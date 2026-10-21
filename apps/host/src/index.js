import http from 'node:http';
import { Server as SocketServer } from 'socket.io';

import { createApp, localAddresses } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);
await app.bootstrap();

const server = http.createServer((req, res) => {
  app.handle(req, res).catch((exception) => {
    console.error('[trans-dev] request failed', exception);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: { code: 'internal_error', message: 'Internal error' } }));
  });
});

server.on('connection', (socket) => {
  socket.setNoDelay(true);
});

const io = new SocketServer(server, {
  cors: { origin: true, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6,
  path: '/socket.io',
});
app.relay.install(io);

server.listen(config.port, config.host, () => {
  const { port } = server.address();
  app.setNetwork({ port });
  const lan = localAddresses();
  const lines = [
    '',
    '  TransDev portable file server',
    '  ─────────────────────────────',
    `  device      ${config.deviceName}`,
    `  local       http://localhost:${port}`,
    `  network     ${app.baseUrl()}`,
    ...lan.map((entry) => `              http://${entry.address}:${port}  (${entry.name})`),
    `  pairing PIN ${app.pairing.pin}`,
    `  share root  ${config.root}`,
    '',
    lan.length === 0
      ? '  ⚠  No LAN address found. Connect this machine to Wi-Fi so the PC can reach it.'
      : '  Open the network URL on a PC connected to the same Wi-Fi.',
    '',
  ];
  console.log(lines.join('\n'));
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[trans-dev] ${signal} received, shutting down…`);
  app.shutdown();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
