# TransDev

**Wi-Fi file transfer between your phone and your computer — no cable, no cloud, no account.**

Your phone runs a tiny HTTP server on the local network. Any browser on the same Wi-Fi opens it, pairs with a
4-digit PIN (or QR code), and gets a file manager that can browse, preview, download and upload files straight to the
device. Bytes never leave the LAN.

```
   ┌─────────────────────────┐            local Wi-Fi            ┌──────────────────────────┐
   │  Phone (host / server)  │  ◀──────── HTTP + SSE ─────────▶  │  Computer (web client)   │
   │                         │                                   │                          │
   │  • local HTTP server    │   GET  /api/fs/list               │  • React dashboard       │
   │  • PIN + QR pairing     │   PUT  /api/upload    (chunks)    │  • grid / list explorer  │
   │  • streaming file I/O   │   GET  /api/asset     (ranges)    │  • drag-and-drop upload  │
   │  • session management   │   GET  /api/events    (SSE)       │  • previews + transfers  │
   └─────────────────────────┘                                   └──────────────────────────┘
```

## What's in the repo

| Path            | What it is                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/host`     | Reference implementation of the phone host: Node HTTP server, pairing, streaming uploads/downloads, SSE, relay. |
| `apps/web`      | The desktop dashboard: React 19 + Vite + TypeScript, pairing screen, file manager, transfer queue.               |
| `apps/mobile`   | React Native app source (the real phone host): HTTP server over `react-native-tcp-socket`, PIN/QR screen, files. |
| `docs/`         | [`PROTOCOL.md`](docs/PROTOCOL.md) (API contract) and [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) (design notes).   |

The Node host is what you can run right now, on any machine, to exercise the exact protocol the phone app speaks.

## Quick start

```bash
npm install
npm run seed     # create a demo shared folder with photos, documents and a PDF
npm run dev      # host on :8787 + dashboard on :5173
```

Open **http://localhost:5173**. The demo host publishes its PIN, so the pairing screen fills in the code for you —
press **Connect to device** and you are in. From there you can browse `Photos`, preview images, drag a file in from
your desktop, and watch it land in `Inbox`.

To try the production shape (a single origin, exactly like the phone):

```bash
npm run build
npm start        # http://<your-lan-ip>:8787
```

The server prints every LAN address it can be reached at, plus the current pairing PIN.

### Demo content

`npm run seed` writes into `apps/host/data` (git-ignored): four folders, sample documents, a small generated PDF and
four demo photos from `apps/host/demo-assets`. Use `npm run seed -- --force` to reset, including files you uploaded.

## Features

**Pairing**

- 4-digit PIN shown on the phone; QR code encodes `http://<phone-ip>:<port>/?pin=<pin>`.
- QR path uses a rotating 6-character secret; older codes expire after 10 minutes.
- 5 attempts per minute per IP, then a 30-second lockout.
- Sessions are bearer tokens (32 random bytes), listed on the phone, revocable one by one.

**File manager**

- Grid and list views, breadcrumbs, back/forward history, sort by name/size/date/type.
- Live search across the whole shared tree.
- New folder, rename, multi-select, delete (with confirmation).
- Inline previews: images, video (seeking via HTTP Range), audio, PDF, and text/code.
- Storage panel: free/total plus how much the shared folders use.

**Transfers**

- Uploads sliced into 4 MB chunks, two files in parallel, with speed and ETA.
- Interrupted uploads resume from the acknowledged byte offset instead of restarting.
- Drag and drop — including whole folders, which are recreated on the phone.
- Queue with cancel, retry and a clear-on-finish action.
- Downloads stream with `Range` support; large videos never buffer in memory.
- Server-sent events keep every paired browser in sync after a change.

## Mobile app

`apps/mobile` contains the actual on-device host: a small HTTP/1.1 server implemented on top of
`react-native-tcp-socket`, a filesystem layer over `react-native-fs`, and a three-tab UI (Server / Files / Settings)
with the PIN, QR code, live session list and start/stop control.

It is shipped as source because native projects are generated per toolchain. See
[`apps/mobile/README.md`](apps/mobile/README.md) for the 4-step setup.

## Configuration

The host reads these environment variables (all optional):

| Variable            | Default                  | Purpose                                                    |
| ------------------- | ------------------------ | ---------------------------------------------------------- |
| `PORT`              | `8787`                   | Listening port.                                            |
| `HOST`              | `0.0.0.0`                | Bind address (LAN reachable by default).                   |
| `ROOT`              | `apps/host/data`         | Folder exposed to paired devices.                          |
| `DEVICE_NAME`       | `Pixel 8 · TransDev`     | Name shown in the dashboard.                               |
| `PIN`               | random 4 digits          | Fixed PIN (handy for development).                         |
| `DEMO`              | `1`                      | Publish the PIN over HTTP so the demo can auto-fill it. **Set `0` in production.** |
| `MAX_UPLOAD_BYTES`  | 20 GB                    | Per-file cap enforced while streaming.                     |
| `SESSION_TTL_MS`    | 12 h                     | Session lifetime.                                          |
| `PUBLIC_URL`        | detected LAN IP          | Override the address shown in pairing links.               |
| `LOG_REQUESTS`      | `1`                      | Request log lines.                                         |

## Scripts

| Command            | What it does                                              |
| ------------------ | --------------------------------------------------------- |
| `npm run dev`      | Host (watch mode) + Vite dashboard together.              |
| `npm run dev:host` | Only the host.                                            |
| `npm run dev:web`  | Only the dashboard (proxies `/api` to `:8787`).            |
| `npm run build`    | Typecheck and build the dashboard into `apps/web/dist`.   |
| `npm start`        | Host in production mode, serving the built dashboard.     |
| `npm test`         | 40 backend tests (unit + HTTP integration).               |
| `npm run typecheck`| TypeScript check for the dashboard.                       |
| `npm run check`    | Typecheck + tests + build.                                |
| `npm run seed`     | Repopulate the demo shared folder.                        |

## Security model, in one breath

Traffic stays on the LAN and is only reachable while the phone's server is running. File routes require a bearer
token from a paired session; media URLs are HMAC-signed, short-lived and bound to one path and one mode (so an
`<img>` tag never carries the session token). Paths are normalised and traversal is rejected rather than clamped;
uploads are capped and streamed to disk; PIN guesses are throttled; sessions expire and can be revoked from the phone.

What it is **not**: HTTPS. Anyone who can already observe your Wi-Fi traffic can see what a paired browser sees.
Treat it as a tool for your own network — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full threat
model and the honest list of limitations.

## Roadmap

- Native photo-library (CameraRoll) and system file-picker bridges in the mobile app.
- Persist the mobile signer/session across app restarts with Keychain/Keystore.
- Optional TLS with a self-signed certificate and a fingerprint in the QR.
- Multi-device transfer history with retry, and a "send to this device" action.
- End-to-end encryption of file bytes with a key carried in the QR code.

## License

MIT — see [LICENSE](LICENSE).
