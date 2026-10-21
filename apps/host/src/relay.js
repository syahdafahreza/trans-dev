import { randomBytes } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length = 6) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/**
 * Optional signalling relay ("desktop shows a QR, phone scans it").
 *
 * It only ever carries a one-line handshake — the phone's `http://192.168.x.x:PORT`
 * base URL plus its pairing code. File bytes never touch this server. It can be
 * switched off entirely and pairing still works via PIN or the phone's own QR.
 */
export class RelayService {
  constructor({ ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map(); // code -> { code, host, createdAt, expiresAt, baseUrl, deviceName, desktopSocketId }
  }

  create({ baseUrl = null, deviceName = 'Phone' } = {}) {
    const code = randomCode();
    const session = {
      code,
      baseUrl,
      deviceName,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      desktop: null,
    };
    this.sessions.set(code, session);
    return this.publicView(session);
  }

  publicView(session) {
    return {
      code: session.code,
      expiresAt: new Date(session.expiresAt).toISOString(),
      waiting: Boolean(session.baseUrl),
      desktopOnline: Boolean(session.desktop),
    };
  }

  get(code) {
    const session = this.sessions.get(String(code ?? '').toUpperCase().trim());
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(session.code);
      return null;
    }
    return session;
  }

  announce(code, { baseUrl, deviceName }) {
    const session = this.get(code);
    if (!session) return null;
    session.baseUrl = baseUrl;
    session.deviceName = deviceName ?? session.deviceName;
    return session;
  }

  prune() {
    const now = this.now();
    for (const [code, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(code);
    }
  }

  install(io) {
    io.on('connection', (socket) => {
      socket.on('desktop:join', (payload = {}, ack = () => {}) => {
        const session = this.get(payload.code);
        if (!session) {
          ack({ ok: false, error: 'This pairing code has expired. Show a fresh QR on your phone.' });
          return;
        }
        session.desktop = socket.id;
        socket.join(`relay:${session.code}`);
        socket.data.relayCode = session.code;
        ack({ ok: true, deviceName: session.deviceName });
        if (session.baseUrl) {
          socket.emit('host:found', { baseUrl: session.baseUrl, deviceName: session.deviceName });
        }
      });

      socket.on('host:announce', (payload = {}, ack = () => {}) => {
        const session = this.get(payload.code);
        if (!session) {
          ack({ ok: false, error: 'Unknown or expired pairing code' });
          return;
        }
        this.announce(payload.code, { baseUrl: payload.baseUrl, deviceName: payload.deviceName });
        io.to(`relay:${session.code}`).emit('host:found', {
          baseUrl: payload.baseUrl,
          deviceName: payload.deviceName,
        });
        ack({ ok: true });
      });

      socket.on('disconnect', () => {
        const code = socket.data.relayCode;
        if (code && this.sessions.get(code)?.desktop === socket.id) {
          this.sessions.get(code).desktop = null;
        }
      });
    });

    const timer = setInterval(() => this.prune(), 30_000);
    timer.unref?.();
  }
}
