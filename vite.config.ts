import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const OCR_TARGET = 'http://127.0.0.1:8765';

/**
 * Starts the local OCR service (ocr-server/server.py) together with the dev/preview server.
 * It runs in a separate process so a first-time setup never blocks the app from starting.
 * If Python isn't available the app still works and falls back to in-browser OCR.
 */
function localOcr(): Plugin {
  let child: ChildProcess | null = null;
  const start = () => {
    if (child || process.env.LENDWISE_NO_OCR) return;
    const script = fileURLToPath(new URL('./scripts/ocr-server.mjs', import.meta.url));
    child = spawn(process.execPath, [script], { stdio: 'inherit', windowsHide: true });
    const stop = () => child?.kill();
    process.once('exit', stop);
  };
  return {
    name: 'lendwise-local-ocr',
    configureServer: start,
    configurePreviewServer: start,
  };
}

const proxy = {
  // The browser talks to the OCR service through Vite, so phones on the LAN can use it too.
  '/api/ocr': { target: OCR_TARGET, changeOrigin: true },
};

// host: true -> the app is reachable from other devices on your network
// (e.g. a phone on the same Wi-Fi) at http://<this-pc-ip>:5173
export default defineConfig({
  plugins: [react(), tailwindcss(), localOcr()],
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 4173, proxy },
});
