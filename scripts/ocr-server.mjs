// Local OCR service manager (RapidOCR, Python). Used by the Vite plugin and `npm run ocr`.
//  - creates ocr-server/.venv and installs requirements the first time
//  - starts ocr-server/server.py on 127.0.0.1:8765 unless it is already running
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'ocr-server');
const isWin = process.platform === 'win32';
const venvPy = join(dir, '.venv', isWin ? 'Scripts/python.exe' : 'bin/python');
export const OCR_PORT = 8765;
export const OCR_URL = `http://127.0.0.1:${OCR_PORT}`;

const log = (m) => console.log(`[ocr] ${m}`);

export async function isOcrRunning() {
  try {
    const r = await fetch(`${OCR_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function findPython() {
  const candidates = isWin ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print(sys.version_info[:2] >= (3, 9))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return [cmd, pre];
  }
  return null;
}

/** Creates the virtualenv + installs packages if needed. Returns false if Python is unavailable. */
export function setupOcr() {
  if (existsSync(venvPy)) {
    const ok = spawnSync(venvPy, ['-c', 'import rapidocr_onnxruntime, cv2'], { stdio: 'ignore' });
    if (ok.status === 0) return true;
  }
  const py = findPython();
  if (!py) {
    log('Python 3.9+ not found - accurate OCR disabled (the app falls back to basic in-browser OCR).');
    return false;
  }
  log('First-time setup: creating Python environment and installing RapidOCR (a few minutes)...');
  if (!existsSync(venvPy)) {
    const r = spawnSync(py[0], [...py[1], '-m', 'venv', join(dir, '.venv')], { stdio: 'inherit' });
    if (r.status !== 0) return false;
  }
  const r = spawnSync(venvPy, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(dir, 'requirements.txt')], {
    stdio: 'inherit',
  });
  return r.status === 0;
}

let child = null;

/** Starts the OCR service in the background (no-op if already running). */
export async function startOcr({ foreground = false } = {}) {
  if (await isOcrRunning()) {
    log(`already running at ${OCR_URL}`);
    return;
  }
  if (!setupOcr()) return;
  child = spawn(venvPy, [join(dir, 'server.py')], {
    cwd: dir,
    stdio: foreground ? 'inherit' : ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  child.on('exit', (code) => {
    if (code) log(`service exited with code ${code}`);
    child = null;
  });
  const stop = () => child?.kill();
  process.once('exit', stop);
  process.once('SIGINT', () => { stop(); process.exit(0); });
  process.once('SIGTERM', () => { stop(); process.exit(0); });
}

// `node scripts/ocr-server.mjs [--setup]`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--setup')) process.exit(setupOcr() ? 0 : 1);
  startOcr({ foreground: true });
}
