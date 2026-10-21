# Architecture & design notes

## Shape of the system

```
apps/host  ─────────────┐
  src/app.js            │  protocol + behaviours implemented once, in Node
  src/pairing.js        │  (the demo device and the contract the phone mirrors)
  src/uploads.js        │
  src/files.js          │
  src/signer.js         │
  src/http/*            │
  src/relay.js          │
                        ▼
apps/web  ──── HTTP ──▶  phone (apps/host or apps/mobile)
  src/lib/api.ts          relative /api/* URLs
  src/lib/uploader.ts     4 MB chunks, 2 parallel, retry + resume
  src/components/*        pairing, browser, preview, transfers
```

There is deliberately **no backend of our own in the middle**. The dashboard is static files; it either comes from
the phone (`npm run build && npm start`) or from any static host, pointing at the phone with `?host=192.168.1.24:8787`.

## Why these pieces

**HTTP over WebSockets for data.** Pairing needs one small signalling step, but directory listings, ranged previews
and chunked uploads are all naturally request/response. Plain HTTP also means `Range`, `ETag` and `<video>` seeking
work for free.

**Chunked uploads with client-chosen ids.** A 4 GB video must not be buffered, and Wi-Fi drops happen. The client
streams 4 MB slices, the server appends them to a partial file, and each request reports the acknowledged offset.
Retrying after a failure is a `GET` of the current offset — no restart from zero.

**Signed media URLs.** `Authorization` headers cannot be attached by `<img>`/`<video>`, and putting the session token
in a URL would leak it into history and logs. An HMAC over `(session, path, mode, expiry)` gives a capability that
is useless for anything else and dies in ten minutes.

**Signed URLs vs. session tokens on the phone.** The React Native implementation cannot run Node's `crypto`, so it
issues opaque random grants kept in a map instead of HMACs. Same properties: random, path-bound, 10-minute expiry,
revocable with the process.

**SSE instead of polling.** One long-lived `EventSource` per browser keeps listings and storage fresh when another
device uploads or deletes something. It reconnects automatically and costs one socket.

## Request lifecycle (Node host)

1. `index.js` builds config, creates the app, creates the HTTP server and the optional Socket.IO relay.
2. `app.handle` parses the URL, applies security headers and CORS, answers `OPTIONS`, logs on finish.
3. The dependency-free router matches method + path; dynamic segments become `params`.
4. Handlers either go through `authed()` (which resolves the bearer token to a session) or are public.
5. Files are resolved through `resolveVirtualPath`, which proves the result is inside the root.
6. Responses use `json()` / `error()` helpers; files go through `sendFile` (Range, ETag, `HEAD`, streamed with
   backpressure). Errors are normalised in `handleError`.

## Upload pipeline in the browser

```
Uploader.enqueue(files, dir)
  └─ pump() keeps 2 transfers running
       └─ run(entry)
            ├─ PUT begin  → server returns offset (resume point)
            ├─ loop: file.slice(offset, offset+4MB) → PUT X-Upload-Offset
            ├─ progress: exponential moving average for speed
            └─ POST finish → listing refresh + storage refresh
```

Failures retry three times with backoff; `409` responses refresh the offset first, so a flaky link degrades to
"slower" rather than "failed". Folder drops are expanded with `webkitGetAsEntry` and the nested directories are
created before their files are enqueued.

## Pairing and trust

| Step              | What protects it                                                        |
| ----------------- | ----------------------------------------------------------------------- |
| Discovery         | None. Being on the LAN is the first gate; the server only runs when the user starts it. |
| PIN               | 4 digits is small, so it is rate limited: 5 attempts/minute/IP, 30 s lockout. |
| QR                | 6-character rotating secret (10 min), only readable on the phone screen. |
| Session token     | 32 random bytes, `sessionStorage` (dies with the tab), 12 h expiry, revocable. |
| Media URLs        | HMAC, path+mode bound, 10 min.                                          |
| File paths        | Normalised; `..` rejected; every resolved path re-checked against the root. |
| Upload size       | Streamed to disk with a cap; no whole-file buffer anywhere.              |

Threat model: **someone else on the same Wi-Fi**. They can reach the port and try PINs (throttled), but they cannot
list files, read media or upload without a session. They can see traffic if the network itself is compromised —
there is no TLS. That trade-off keeps setup instant (no certificates, no warnings) and is stated plainly in the UI.

What is intentionally out of scope today: TLS, encrypted-at-rest storage, per-file permissions, audit logs.
`docs/PROTOCOL.md` documents the API; adding those would not break it.

## React Native host

The phone cannot use Node's `http`, streams or `crypto`, so `apps/mobile/src/server` re-implements the minimum:

- `httpServer.ts` — HTTP/1.1 parsing on top of `react-native-tcp-socket`, 32 MB per-request body cap, range-aware
  file streaming from `react-native-fs` in 256 KB blocks.
- `localHost.ts` — routes mirroring the Node API (pairing, listing, assets, chunked uploads, storage).
- `pairing.ts` — PIN/QR/session/throttle logic, in-memory.

Deliberate limitations of that layer, called out so nobody is surprised:

- Requests are parsed one at a time per socket; no HTTP keep-alive pipelining.
- `Transfer-Encoding: chunked` bodies are not accepted — the dashboard always sends `Content-Length`.
- Sessions and grants are in memory: killing the app revokes everything, which is also a safe default.
- The photo library bridge (CameraRoll) and the system file picker are future work; today the app exposes its
  documents folder through `react-native-fs`.

The Node host stays the reference for the wire format, which is why `apps/host/test` covers it thoroughly instead of
duplicating a test harness for native code.

## Data layout

```
<shared root>/
  Inbox/        uploads from paired computers (default destination)
  Photos/       camera roll mirror / demo photos
  Documents/    documents
  Downloads/    saved from the web
<tmp dir>/
  <upload-id>.part   bytes received so far
  <upload-id>.json   original name, destination and size
```

Partial files are removed on finish/abort and garbage-collected on boot if older than 24 h.

## Performance notes

- Upload chunk 4 MB: large enough to keep throughput high, small enough to keep memory and retry cost low.
- Downloads stream with 256 KB read buffers and honour `Range`, so video seeking is instant.
- Listings stat entries concurrently and cache nothing; a phone folder of 2,000 files still lists in tens of
  milliseconds on a LAN.
- The dashboard prefetches signed URLs for visible images only, caches them for 4 minutes, and never renders a
  full-size image where a thumbnail is enough.
