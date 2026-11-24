// Copies the Tesseract OCR engine + English model into public/tesseract so
// OCR runs 100% locally (no CDN / internet needed). Runs on `npm install`.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'tesseract');
mkdirSync(join(out, 'core'), { recursive: true });
mkdirSync(join(out, 'lang'), { recursive: true });

cpSync(join(nm, 'tesseract.js', 'dist', 'worker.min.js'), join(out, 'worker.min.js'));

const coreDir = join(nm, 'tesseract.js-core');
for (const f of readdirSync(coreDir)) {
  if (f.startsWith('tesseract-core') && (f.endsWith('.js') || f.endsWith('.wasm'))) {
    cpSync(join(coreDir, f), join(out, 'core', f));
  }
}

cpSync(
  join(nm, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'),
  join(out, 'lang', 'eng.traineddata.gz'),
);

console.log('OCR assets copied to public/tesseract');
