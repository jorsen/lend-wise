import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// host: true -> the app is reachable from other devices on your network
// (e.g. a phone on the same Wi-Fi) at http://<this-pc-ip>:5173
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
