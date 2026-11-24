// Starts the Lend-Wise server in the background (no terminal window) and
// opens the app in its own window. Run via "Lend-Wise.vbs" (double-click).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// Keep "localhost:5173" — the app's saved data (IndexedDB) is tied to this exact origin.
const PORT = process.env.LENDWISE_PORT ?? '5173';
const URL = `http://localhost:${PORT}/`;
const LOG = join(HERE, 'server.log');
const PID = join(HERE, 'server.pid');

function alertBox(text) {
  const ps = `Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show($env:LW_MSG, 'Lend-Wise')`;
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, env: { ...process.env, LW_MSG: text } });
}

// 'up' = Lend-Wise is serving; 'other' = something else holds the port; 'down' = nothing there.
async function probe() {
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(1500) });
    return (await res.text()).includes('LendWise') ? 'up' : 'other';
  } catch {
    return 'down';
  }
}
const isUp = async () => (await probe()) === 'up';

function openWindow() {
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] ?? '';
  const browsers = [
    join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    join(local, 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  const exe = browsers.find((p) => existsSync(p));
  if (exe) {
    // --app opens a clean window with no tabs/address bar, so it feels like a desktop app.
    spawn(exe, [`--app=${URL}`], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}

async function main() {
  const state = await probe();
  if (state === 'other') {
    throw new Error(`Port ${PORT} is being used by another program. Close it (or run "Stop Lend-Wise") and try again.`);
  }
  if (state === 'down') {
    // public/tesseract (OCR data) is created by npm install's postinstall step.
    if (!existsSync(join(ROOT, 'node_modules', 'vite')) || !existsSync(join(ROOT, 'public', 'tesseract'))) {
      const r = spawnSync('npm', ['install'], { cwd: ROOT, shell: true, windowsHide: true, stdio: 'ignore' });
      if (r.status !== 0) throw new Error('"npm install" failed. Check your internet connection and try again.');
    }

    const log = openSync(LOG, 'w');
    const server = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', PORT, '--strictPort'], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
    });
    writeFileSync(PID, String(server.pid));
    server.unref();

    const deadline = Date.now() + 60_000;
    while (!(await isUp())) {
      if (server.exitCode !== null || Date.now() > deadline) {
        throw new Error(`The server did not start. Details are in:\n${LOG}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!process.env.LENDWISE_NO_OPEN) openWindow();
}

main().catch((err) => {
  alertBox(`Lend-Wise could not start.\n\n${err.message}`);
  process.exit(1);
});
