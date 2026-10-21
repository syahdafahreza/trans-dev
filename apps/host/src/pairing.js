import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — easier to read off a screen

export class PairingError extends Error {
  constructor(message, { code = 'pairing_failed', status = 401, retryAfter } = {}) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
    this.status = status;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

function randomPin() {
  return String(randomInt(0, 10000)).padStart(4, '0');
}

function randomCode(length) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += PIN_ALPHABET[bytes[i] % PIN_ALPHABET.length];
  return out;
}

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Owns the pairing state that lives on the phone:
 *  - the 4 digit PIN shown on screen,
 *  - a short lived QR code embedded in the pairing link,
 *  - the bearer sessions handed to paired desktops,
 *  - brute force throttling per client IP.
 *
 * Nothing in here ever leaves the device except a session token.
 */
export class PairingService {
  constructor({
    deviceName = 'Phone',
    pin = null,
    qrTtlMs = 10 * 60 * 1000,
    sessionTtlMs = 12 * 60 * 60 * 1000,
    maxAttempts = 5,
    attemptWindowMs = 60 * 1000,
    lockoutMs = 30 * 1000,
    now = () => Date.now(),
  } = {}) {
    this.deviceName = deviceName;
    this.fixedPin = pin;
    this.pin = pin ?? randomPin();
    this.qrTtlMs = qrTtlMs;
    this.sessionTtlMs = sessionTtlMs;
    this.maxAttempts = maxAttempts;
    this.attemptWindowMs = attemptWindowMs;
    this.lockoutMs = lockoutMs;
    this.now = now;
    this.sessions = new Map();
    this.attempts = new Map();
    this.rotateQr();
  }

  rotateQr() {
    this.qrCode = randomCode(6);
    this.qrExpiresAt = this.now() + this.qrTtlMs;
    this.qrImage = null; // cached data URL, regenerated lazily
    return this.qrCode;
  }

  rotatePin() {
    if (this.fixedPin) return this.pin;
    this.pin = randomPin();
    this.qrImage = null;
    return this.pin;
  }

  /** Lets a user type a new PIN from the phone UI. */
  setPin(pin) {
    if (!/^\d{4}$/.test(String(pin))) throw new PairingError('PIN must be 4 digits', { status: 400 });
    this.pin = String(pin);
    this.qrImage = null;
    return this.pin;
  }

  gate(ip) {
    const record = this.attempts.get(ip);
    if (!record) return { allowed: true };
    if (record.blockedUntil > this.now()) {
      return { allowed: false, retryAfter: Math.ceil((record.blockedUntil - this.now()) / 1000) };
    }
    return { allowed: true };
  }

  recordFailure(ip) {
    const now = this.now();
    const record = this.attempts.get(ip) ?? { failures: [], blockedUntil: 0 };
    record.failures = record.failures.filter((t) => now - t < this.attemptWindowMs);
    record.failures.push(now);
    if (record.failures.length >= this.maxAttempts) {
      record.blockedUntil = now + this.lockoutMs;
      record.failures = [];
    }
    this.attempts.set(ip, record);
    return this.gate(ip);
  }

  clearFailures(ip) {
    this.attempts.delete(ip);
  }

  /**
   * Exchanges a PIN *or* the QR code for a session token.
   * The QR code path exists because scanning the screen already proves proximity.
   */
  pair({ pin, code, clientName = 'Desktop browser', ip = 'unknown', userAgent = '' } = {}) {
    const gate = this.gate(ip);
    if (!gate.allowed) {
      throw new PairingError('Too many attempts. Try again in a moment.', {
        code: 'rate_limited',
        status: 429,
        retryAfter: gate.retryAfter,
      });
    }

    const viaQr = Boolean(code) && this.qrCode && safeEqual(code.toUpperCase(), this.qrCode) && this.now() < this.qrExpiresAt;
    const viaPin = Boolean(pin) && /^\d{4}$/.test(String(pin)) && safeEqual(String(pin), this.pin);

    if (!viaQr && !viaPin) {
      const failure = this.recordFailure(ip);
      throw new PairingError('That PIN is not right. Check the code on your phone.', {
        code: failure.allowed ? 'bad_pin' : 'rate_limited',
        status: failure.allowed ? 401 : 429,
        retryAfter: failure.retryAfter,
      });
    }

    this.clearFailures(ip);
    const token = randomBytes(32).toString('base64url');
    const session = {
      id: randomBytes(6).toString('hex'),
      token,
      clientName: String(clientName).slice(0, 80) || 'Desktop browser',
      ip,
      userAgent: String(userAgent).slice(0, 300),
      method: viaQr ? 'qr' : 'pin',
      createdAt: this.now(),
      lastSeenAt: this.now(),
      expiresAt: this.now() + this.sessionTtlMs,
    };
    this.sessions.set(token, session);
    return session;
  }

  authenticate(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    session.lastSeenAt = this.now();
    return session;
  }

  /** Looks a live session up by its public id (used to validate signed asset URLs). */
  sessionById(id) {
    if (!id) return null;
    for (const session of this.sessions.values()) {
      if (session.id === id && session.expiresAt > this.now()) return session;
    }
    return null;
  }

  revoke(token) {
    return this.sessions.delete(token);
  }

  revokeById(id) {
    for (const [token, session] of this.sessions) {
      if (session.id === id) {
        this.sessions.delete(token);
        return true;
      }
    }
    return false;
  }

  publicSessions() {
    const now = this.now();
    return [...this.sessions.values()]
      .filter((s) => s.expiresAt > now)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((s) => ({
        id: s.id,
        clientName: s.clientName,
        ip: s.ip,
        method: s.method,
        createdAt: new Date(s.createdAt).toISOString(),
        lastSeenAt: new Date(s.lastSeenAt).toISOString(),
      }));
  }

  prune() {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}
