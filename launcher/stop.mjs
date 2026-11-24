// Stops the background Lend-Wise server started by launch.mjs.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PID = join(dirname(fileURLToPath(import.meta.url)), 'server.pid');

const PORT = process.env.LENDWISE_PORT ?? '5173';
const pids = new Set();
if (existsSync(PID)) pids.add(readFileSync(PID, 'utf8').trim());
try {
  // Also catch a server started some other way that is still holding the app port,
  // and the OCR service (8765), which can be left orphaned when Vite is killed.
  const ports = [`:${PORT}`, ':8765'];
  const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true });
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[3] === 'LISTENING' && ports.some((p) => cols[1]?.endsWith(p))) pids.add(cols[4]);
  }
} catch {}
try {
  // Any OCR service python process (even one not yet listening, e.g. still loading models).
  const ps = `Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object { $_.CommandLine -like '*ocr-server*server.py*' } | ForEach-Object { $_.ProcessId }`;
  const out = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: 'utf8', windowsHide: true });
  for (const pid of out.split(/\s+/)) if (pid) pids.add(pid);
} catch {}

for (const pid of pids) {
  if (!/^\d+$/.test(pid)) continue;
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
  } catch {}
}
rmSync(PID, { force: true });
