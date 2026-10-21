import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.HOST_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // The dashboard talks to the phone over relative URLs; in dev we proxy them
    // so the browser never has to know where the host process lives.
    allowedHosts: true,
    proxy: {
      '/api': { target: host, changeOrigin: true },
      '/socket.io': { target: host, ws: true, changeOrigin: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
