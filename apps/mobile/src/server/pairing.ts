/**
 * Phone-side pairing state: the PIN on screen, the QR secret, live sessions and
 * brute-force throttling. Mirrors `apps/host/src/pairing.js`; kept dependency-free
 * because React Native has no node:crypto.
 */

export interface Session {
  id: string;
  token: string;
  clientName: string;
  ip: string;
  method: 'pin' | 'qr';
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface PublicSession {
  id: string;
  clientName: string;
  ip: string;
  method: string;
  createdAt: string;
  lastSeenAt: string;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomString(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

function randomToken(): string {
  return `${Date.now().toString(36)}${randomString(24)}${Math.random().toString(36).slice(2)}`;
}

export class PairingError extends Error {
  status: number;
  code: string;
  retryAfter?: number;

  constructor(message: string, status = 401, code = 'pairing_failed', retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class PairingService {
  pin: string;
  qrCode: string;
  qrExpiresAt: number;
  private sessions = new Map<string, Session>();
  private attempts = new Map<string, { failures: number[]; blockedUntil: number }>();
  private sessionTtlMs: number;
  private qrTtlMs = 10 * 60 * 1000;
  private maxAttempts = 5;
  private attemptWindowMs = 60 * 1000;
  private lockoutMs = 30 * 1000;

  constructor(options: { pin?: string; sessionTtlMs?: number } = {}) {
    this.pin = options.pin ?? String(Math.floor(1000 + Math.random() * 9000));
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.qrCode = randomString(6);
    this.qrExpiresAt = Date.now() + this.qrTtlMs;
  }

  rotatePin(): string {
    this.pin = String(Math.floor(1000 + Math.random() * 9000));
    return this.pin;
  }

  rotateQr(): string {
    this.qrCode = randomString(6);
    this.qrExpiresAt = Date.now() + this.qrTtlMs;
    return this.qrCode;
  }

  pair(input: { pin?: string; code?: string; clientName?: string; ip?: string }): Session {
    const ip = input.ip ?? 'unknown';
    const record = this.attempts.get(ip);
    if (record && record.blockedUntil > Date.now()) {
      throw new PairingError('Too many attempts. Wait a moment and try again.', 429, 'rate_limited', Math.ceil((record.blockedUntil - Date.now()) / 1000));
    }

    const qrOk = Boolean(input.code) && input.code!.toUpperCase() === this.qrCode && Date.now() < this.qrExpiresAt;
    const pinOk = Boolean(input.pin) && input.pin === this.pin;

    if (!qrOk && !pinOk) {
      const current = this.attempts.get(ip) ?? { failures: [], blockedUntil: 0 };
      current.failures = current.failures.filter((time) => Date.now() - time < this.attemptWindowMs);
      current.failures.push(Date.now());
      if (current.failures.length >= this.maxAttempts) {
        current.blockedUntil = Date.now() + this.lockoutMs;
        current.failures = [];
      }
      this.attempts.set(ip, current);
      throw new PairingError('That PIN is not right. Check the code on your phone.', 401, 'bad_pin');
    }

    this.attempts.delete(ip);
    if (qrOk) this.rotateQr(); // a scanned code is single use
    const session: Session = {
      id: Math.random().toString(36).slice(2, 10),
      token: randomToken(),
      clientName: input.clientName ?? 'Desktop browser',
      ip,
      method: qrOk ? 'qr' : 'pin',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      expiresAt: Date.now() + this.sessionTtlMs,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  authenticate(token?: string | null): Session | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  revoke(token: string) {
    this.sessions.delete(token);
  }

  revokeById(id: string) {
    for (const [token, session] of this.sessions) {
      if (session.id === id) {
        this.sessions.delete(token);
        return true;
      }
    }
    return false;
  }

  list(): PublicSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.expiresAt > Date.now())
      .map((session) => ({
        id: session.id,
        clientName: session.clientName,
        ip: session.ip,
        method: session.method,
        createdAt: new Date(session.createdAt).toISOString(),
        lastSeenAt: new Date(session.lastSeenAt).toISOString(),
      }));
  }

  get activeCount() {
    return this.list().length;
  }
}
