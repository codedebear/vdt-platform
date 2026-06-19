import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `vite dev`, proxy API calls to the local backend so the browser can
// call relative `/api/...` paths with no CORS handling. In production the same
// relative paths are served by nginx, which proxies `/api` to the backend
// container (see frontend/nginx.conf).
const BACKEND_URL = process.env.VITE_DEV_BACKEND_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND_URL, changeOrigin: true },
      '/health': { target: BACKEND_URL, changeOrigin: true },
    },
  },
});
