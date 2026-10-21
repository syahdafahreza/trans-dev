# TransDev protocol

The host is a plain HTTP/1.1 server on the local network. Every endpoint lives under `/api`; anything else is
either the built dashboard or a 404.

- **Base URL** — `http://<phone-ip>:8787` (the port is configurable).
- **Auth** — `Authorization: Bearer <token>` on every data route. Tokens come from `/api/pair` and live in
  `sessionStorage` on the browser.
- **Content type** — JSON in, JSON out, except file bodies (`application/octet-stream`) and media responses.
- **Errors** — always JSON: `{ "error": { "code": "bad_pin", "message": "...", "retryAfter": 30 } }`.
  `retryAfter` is present on `429`.

## Pairing

### `GET /api/pair/info` — public

What a browser needs before it can show a pairing screen.

```json
{
  "deviceName": "Pixel 8 · TransDev",
  "demo": true,
  "baseUrl": "http://192.168.1.24:8787",
  "pin": "4821",
  "qrCode": "XF7L6F",
  "qrExpiresAt": "2026-10-21T05:36:41.775Z",
  "pairingUrl": "http://192.168.1.24:8787/?pin=4821",
  "network": { "address": "192.168.1.24", "port": 8787 },
  "addresses": [{ "name": "wlan0", "address": "192.168.1.24" }],
  "pairedSessions": [{ "id": "41eb51b7e643", "clientName": "Chrome on macOS", "ip": "::1", "method": "pin", "lastSeenAt": "..." }]
}
```

`pin`, `qrCode`, `pairingUrl` and `qrExpiresAt` are **only** returned when the host runs in demo mode
(`DEMO=1`). A real phone renders those values on its own screen and never publishes them over HTTP.

### `POST /api/pair` — public

```bash
curl -X POST http://192.168.1.24:8787/api/pair \
  -H 'Content-Type: application/json' \
  -d '{"pin":"4821","clientName":"Chrome on macOS"}'
```

Body: `{ "pin": "4821" }` **or** `{ "code": "XF7L6F" }` (the QR secret), plus an optional `clientName`.

`201 Created`

```json
{
  "token": "k3eBMcVS…",
  "expiresAt": "2026-10-22T05:22:26.222Z",
  "session": { "id": "41eb51b7e643", "clientName": "Chrome on macOS", "method": "pin", "createdAt": "…" },
  "device": { "name": "Pixel 8 · TransDev", "baseUrl": "http://192.168.1.24:8787", "network": {…} },
  "locations": [{ "id": "inbox", "label": "Inbox", "path": "/Inbox", "icon": "inbox" }],
  "permissions": { "read": true, "write": true, "delete": true }
}
```

| Status | `code`         | Meaning                                              |
| ------ | -------------- | ---------------------------------------------------- |
| 401    | `bad_pin`      | Wrong PIN or expired/incorrect QR secret.            |
| 429    | `rate_limited` | 5 failures inside a minute; locked for `retryAfter`. |
| 400    | `invalid_json` | Body was not JSON.                                   |

### `GET /api/pair/qr` — public

PNG of the pairing QR (`?size=` clamped to 160–1024). Demo hosts only; the phone app draws its own QR locally.

### `POST /api/pair/scan` — public

Used by the phone to validate a code it scanned off a desktop: `{ "url": "http://host:8787/?pin=4821" }` →
`{ "matched": true, "deviceName": "…" }`. This is a convenience endpoint for desktop-first flows.

## Session

| Endpoint                     | Description                                               |
| ---------------------------- | --------------------------------------------------------- |
| `GET /api/session`           | Current session, device and shared locations.             |
| `GET /api/sessions`          | All live sessions (never exposes tokens).                 |
| `DELETE /api/sessions/:id`   | Revoke one session; revoking your own logs you out.       |
| `POST /api/session/logout`   | Revoke the token you are using.                           |

## Files

All paths are **virtual** paths inside the shared root: `/`, `/Inbox`, `/Documents/Trip/day 1.jpg`.
Segments `.` are dropped, `..` is rejected with `400 invalid_path`, and control characters are refused.

| Endpoint                  | Notes                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `GET /api/fs/list?path=/` | `{ path, parent, entries: [Entry] }`, folders first, natural sort.      |
| `GET /api/fs/stat?path=`  | `{ entry: Entry }`.                                                   |
| `GET /api/fs/search?q=`   | Recursive name search, `q` needs ≥2 chars, `limit` ≤200, depth ≤8.     |
| `GET /api/fs/locations`   | Folder shortcuts with item counts.                                    |
| `GET /api/storage`        | `{ total, free, used, sharedBytes }` in bytes.                         |
| `POST /api/fs/mkdir`      | `{ path: "/", name: "Holiday" }` → `201 { entry }`.                    |
| `POST /api/fs/rename`     | `{ path: "/Inbox/a.txt", name: "b.txt" }`.                             |
| `POST /api/fs/delete`     | `{ paths: ["/Inbox/a.txt", "/Holiday"] }` (recursive for folders).     |

`Entry`

```json
{
  "name": "Coastline.jpg",
  "path": "/Photos/Coastline.jpg",
  "type": "file",
  "size": 307125,
  "mtime": "2026-10-21T05:22:26.067Z",
  "ext": "jpg",
  "mime": "image/jpeg",
  "kind": "image",
  "inline": true
}
```

`kind` is one of `folder | image | video | audio | pdf | document | spreadsheet | presentation | text | code |
archive | app | contact | file`. Folders have `size: null` and `mime: null`.

## Media and downloads

`<img>`, `<video>` and `<a download>` cannot send an `Authorization` header, so the dashboard asks for a signed URL:

```bash
curl -X POST http://192.168.1.24:8787/api/asset \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"path":"/Photos/Coastline.jpg","mode":"inline"}'
```

```json
{ "url": "/api/asset?path=%2FPhotos%2FCoastline.jpg&mode=inline&exp=1792560752726&sig=oOMoO…&s=41eb51b7e643&name=Coastline.jpg" }
```

The signature is `HMAC-SHA256(sessionId \n path \n mode \n exp)`; it is valid for 10 minutes and only for that
combination. `mode=download` adds `Content-Disposition: attachment`.

`GET /api/asset` supports:

- `Range: bytes=0-1023` → `206` with `Content-Range` (used for video seeking and resumable downloads), `416` when
  unsatisfiable.
- `If-None-Match` → `304` (ETag is derived from size and mtime).
- `HEAD` for metadata without a body.

An expired link answers `403 invalid_signature`; a revoked session answers `401 unauthenticated`.

## Chunked, resumable uploads

```
browser                                     phone
   │ PUT /api/upload                          │
   │ X-Upload-Id, -Dir, -Name, -Size          │  create (or resume) the partial file
   │◀──────────── 201 { offset: 0 } ──────────│
   │ PUT /api/upload  X-Upload-Offset: 0      │  append 4 MB slice
   │◀──────────── 200 { offset: 4194304 } ───│
   │ …                                        │
   │ POST /api/upload/finish { uploadId }     │  atomically move into the folder
   │◀──────────── 201 { entry } ──────────────│
```

- `X-Upload-Id` must match `[A-Za-z0-9_-]{8,80}` and is chosen by the client, so a reload can continue the same
  upload.
- `X-Upload-Dir` and `X-Upload-Name` are URI-encoded to stay ASCII-safe for non-Latin filenames.
- `X-Upload-Offset` must equal the current size on disk, otherwise `409 offset_mismatch` with `expectedOffset`.
- `GET`/`HEAD /api/upload?id=…` report `{ offset, size, complete }`; `HEAD` also returns `X-Upload-Offset`.
- `DELETE /api/upload/:id` aborts and removes the temporary file.
- The name is de-duplicated on finish: `photo.jpg` → `photo (1).jpg` rather than overwriting.
- Temporary files older than 24 h are cleaned on boot.

Single-request streaming is available for scripts:

```bash
curl -T movie.mp4 -H "Authorization: Bearer $TOKEN" \
  "http://192.168.1.24:8787/api/upload/simple?dir=/Inbox"
```

The body is piped straight to disk — memory stays flat regardless of file size.

## Live updates (SSE)

`GET /api/events?token=…` (or the bearer header) returns `text/event-stream`:

```
event: fs
data: {"type":"uploaded","path":"/Inbox/report.pdf","size":1048576}

event: pairing
data: {"type":"paired","session":{"id":"41eb51b7e643","clientName":"Chrome on macOS"}}
```

Heartbeat comment every 25 s. The dashboard uses this to refresh the listing and storage numbers.

## Optional pairing relay (Socket.IO)

Only needed for the *desktop shows a QR, phone scans it* flow. It carries a handshake, never file data.

1. A desktop (or the phone) creates a code: `POST /api/relay/session` →
   `201 { code, expiresAt, waiting, relayUrl }`.
2. The desktop joins with `socket.emit('desktop:join', { code }, ack)`.
3. The phone announces `socket.emit('host:announce', { code, baseUrl: 'http://192.168.1.24:8787' })`.
4. The socket receives `host:found { baseUrl, deviceName }` and navigates to `baseUrl/?code=<qr secret>`, which
   completes pairing through the normal `POST /api/pair` path.

`GET /api/relay/session/:code` lets a phone confirm a code is still alive before announcing.

## Status codes used

`200` ok · `201` created · `204` preflight · `206` partial content · `304` not modified · `400` invalid input ·
`401` unauthenticated / bad PIN · `403` invalid signature · `404` not found · `409` offset or completeness mismatch ·
`413` too large · `416` bad range · `429` rate limited · `500` host error.
