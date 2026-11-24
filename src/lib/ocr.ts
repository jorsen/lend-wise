import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { newRow, parseAmount, type AmountField, type ImportRow } from './importTypes';

/* ------------------------------------------------------------------ */
/* Worker (runs fully offline – all files are served from /tesseract)  */
/* ------------------------------------------------------------------ */

let workerPromise: Promise<Worker> | null = null;
let progressCb: ((p: OcrProgress) => void) | null = null;

export interface OcrProgress {
  status: string;
  progress: number; // 0..1
}

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const base = new URL(`${import.meta.env.BASE_URL}tesseract/`, window.location.href).href;
    workerPromise = createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: `${base}worker.min.js`,
      corePath: `${base}core`,
      langPath: `${base}lang`,
      gzip: true,
      cacheMethod: 'none', // assets are local already; avoids stale IndexedDB copies
      logger: (m: { status: string; progress: number }) => progressCb?.({ status: m.status, progress: m.progress }),
    }).then(async (w) => {
      await w.setParameters({
        // Sparse text finds words scattered across table cells, including handwriting.
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
      });
      return w;
    });
    workerPromise.catch(() => (workerPromise = null));
  }
  return workerPromise;
}

/* ------------------------------------------------------------------ */
/* Image pre-processing                                                */
/* ------------------------------------------------------------------ */

/**
 * Loads a photo, applies EXIF orientation + manual rotation, resizes to an
 * OCR-friendly resolution, converts to grayscale and stretches contrast.
 */
export async function preprocessImage(file: File, rotation = 0, stretch = true): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const rotated = rotation % 180 !== 0;
  const srcW = rotated ? bmp.height : bmp.width;
  const srcH = rotated ? bmp.width : bmp.height;

  // Keep up to 3200px on the long side (enough for small print without being too slow).
  // Upscaling a blurry/compressed image barely helps (tested: >1.35x makes it worse).
  const scale = Math.min(1.35, 3200 / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const dw = bmp.width * scale;
  const dh = bmp.height * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  bmp.close();

  // Grayscale + contrast stretch (2nd..98th percentile → 0..255)
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = g;
    hist[g | 0]++;
  }
  const total = w * h;
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.02) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.02) { hi = i; break; } }
  if (!stretch) { lo = 0; hi = 255; }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* ------------------------------------------------------------------ */
/* Table reconstruction                                                */
/* ------------------------------------------------------------------ */

export interface W {
  text: string;
  conf: number;
  x0: number; x1: number; y0: number; y1: number;
  xc: number; yc: number;
}

interface Anchor { cid: string; word: W }

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function findHeaderX(words: W[], re: RegExp): number | null {
  const hits = words.filter((w) => re.test(w.text));
  return hits.length ? median(hits.map((w) => w.xc)) : null;
}

/** A CID is a run of 6–10 digits (it may be glued to the row number, e.g. "1|1012510296"). */
function extractCid(text: string): string | null {
  const cleaned = text.replace(/[Oo]/g, '0').replace(/[lI]/g, '1');
  const chunks = cleaned.split(/[^\d]+/).filter(Boolean);
  const best = chunks.sort((a, b) => b.length - a.length)[0];
  if (!best || best.length < 6) return null;
  if (best.length <= 10) return best;
  if (best.length <= 12) return best.slice(-10); // row number glued in front
  return null;
}

/** A handwritten payment is at least 10 and has 2+ digits; single strokes are table lines. */
function isPlausibleAmount(text: string, conf: number): boolean {
  if (!looksNumeric(text) || /^[-–—_~=]+$/.test(text)) return false;
  const n = parseAmount(text);
  if (n == null) return conf >= 50 && (text.match(/\d/g)?.length ?? 0) >= 2;
  return n >= 10 && conf >= 20;
}

/** Dash-only (= blank / zero) or mostly digits — handwritten amounts come back as "£20", "(02.", "[09"… */
const looksNumeric = (t: string) => {
  if (/^[-–—_~=]+$/.test(t)) return true;
  if (!/\d/.test(t) || t.length > 8) return false;
  const digitish = t.replace(/[^\dOolI|SsZzBgq,.'$\]\[(){}£°"]/g, '').length;
  return digitish / t.length >= 0.6 && (t.match(/\d/g)?.length ?? 0) >= Math.ceil(t.length / 3);
};

export interface OcrResult {
  rows: ImportRow[];
  rawText: string;
  columnsDetected: boolean;
}

/**
 * Runs OCR on a prepared image and rebuilds the member table:
 * 1. Every 6–10 digit word is a CID and anchors a row.
 * 2. Row tilt is measured from words on the same row (photos are rarely straight).
 *    Rows whose CID is unreadable are recovered from the name column.
 * 3. Letter words to the right of a CID on the same row form the name.
 * 4. Numbers further right are matched to the nearest row and to the
 *    nearest column header (AMOUNT / CLIENT INITIATED / AGENT ASSISTED).
 * 5. Each amount cell is then re-read on its own (digits only) to improve handwriting.
 */
export async function ocrMemberSheet(
  canvas: HTMLCanvasElement,
  opts: { defaultColumn: AmountField; source: string; onProgress?: (p: OcrProgress) => void },
): Promise<OcrResult> {
  progressCb = opts.onProgress ?? null;
  const worker = await getWorker();
  // Pass a lossless PNG rather than the canvas itself: tesseract.js reads canvases with
  // noticeably worse results (observed: column headers and names lost on the same image).
  const png = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), 'image/png'));
  const { data } = await worker.recognize(png);
  progressCb = null;

  const words: W[] = (data.words ?? [])
    .filter((w) => w.text.trim())
    .map((w) => ({
      text: w.text.trim(),
      conf: w.confidence,
      x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1,
      xc: (w.bbox.x0 + w.bbox.x1) / 2, yc: (w.bbox.y0 + w.bbox.y1) / 2,
    }));

  const table = reconstructTable(words, canvas.width, opts);

  // Second pass: re-read every amount cell alone, as a single line of digits.
  // Handwriting is read far more reliably this way than in the whole-page pass.
  if (table.geometry && table.columnsDetected) {
    const rects = amountCellRects(table.geometry, canvas.width, canvas.height);
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      tessedit_char_whitelist: '0123456789,.-',
    });
    try {
      for (const [i, r] of rects.entries()) {
        opts.onProgress?.({ status: 'Reading handwritten amounts', progress: i / rects.length });
        const { data: cell } = await worker.recognize(png, {
          rectangle: { left: r.left, top: r.top, width: r.width, height: r.height },
        });
        const row = table.rows[r.row];
        const v = pickCellValue(row[r.field] || undefined, cell.text, cell.confidence);
        if (v !== undefined) {
          table.rows[r.row] = { ...row, [r.field]: v, notes: row.notes.filter((n) => !n.startsWith('Unreadable amount')) };
        }
      }
    } finally {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        tessedit_char_whitelist: '',
      });
    }
  }

  return { rows: table.rows, columnsDetected: table.columnsDetected, rawText: data.text };
}

/** Pure table rebuild from OCR word boxes (exported for testing outside the browser). */
export function reconstructTable(
  words: W[],
  pageWidth: number,
  opts: { defaultColumn: AmountField; source: string },
): { rows: ImportRow[]; columnsDetected: boolean; geometry?: TableGeometry } {
  // 1. anchors
  let anchors: Anchor[] = [];
  for (const w of words) {
    const cid = extractCid(w.text);
    if (cid && !/,/.test(w.text)) anchors.push({ cid, word: w });
  }
  // The CID column is narrow: drop stray digit runs far from it (e.g. phone numbers in margins)
  if (anchors.length >= 3) {
    const mx = median(anchors.map((a) => a.word.xc));
    const spread = median(anchors.map((a) => Math.abs(a.word.xc - mx))) * 4 + 80;
    anchors = anchors.filter((a) => Math.abs(a.word.xc - mx) < spread);
  }
  anchors.sort((a, b) => a.word.yc - b.word.yc);
  // One CID per row: if two digit runs sit on the same line, keep the more plausible one.
  {
    const h = median(anchors.map((a) => a.word.y1 - a.word.y0)) || 10;
    const score = (a: Anchor) => (a.cid.length === 10 || a.cid.length === 6 ? 100 : 0) + a.word.conf;
    anchors = anchors.filter((a, i) => !anchors.some((b, j) => j !== i && Math.abs(b.word.yc - a.word.yc) < h * 0.6 && (score(b) > score(a) || (score(b) === score(a) && j < i))));
  }

  if (anchors.length === 0) {
    return { rows: [], columnsDetected: false };
  }
  const anchorWordSet = new Set(anchors.map((a) => a.word));
  const anchorSet = (w: W) => anchorWordSet.has(w);

  const gaps = anchors.slice(1).map((a, i) => a.word.yc - anchors[i].word.yc).filter((g) => g > 5);
  const rowH = median(gaps) || median(anchors.map((a) => a.word.y1 - a.word.y0)) * 1.6 || 30;

  // 2. row tilt, measured from the words printed on the same row as each CID.
  //    (Phone photos have perspective, so the CID column's lean says nothing about row tilt.)
  //    Two passes: a tight band near the CID first, then a wider band with the first estimate applied.
  let slope = 0;
  for (const [maxDx, band] of [[rowH * 10, 0.3], [rowH * 25, 0.25]] as const) {
    const samples: number[] = [];
    for (const a of anchors) {
      for (const w of words) {
        const dx = w.xc - a.word.xc;
        if (dx < rowH * 2 || dx > maxDx || anchorSet(w)) continue;
        const dy = w.yc - a.word.yc;
        if (Math.abs(dy - slope * dx) < rowH * band) samples.push(dy / dx);
      }
    }
    if (samples.length >= 5) slope = median(samples);
  }
  if (Math.abs(slope) > 0.2) slope = 0; // nonsense → assume straight

  /** vertical offset of word w from anchor a, corrected for page tilt */
  const dyFrom = (w: W, a: Anchor) => w.yc - slope * (w.xc - a.word.xc) - a.word.yc;

  // column headers: only words above the first row and to the right of the CID column count.
  // Patterns are loose because headers are small print ("AMOUNT" often reads as "WOUNT").
  const first = anchors[0];
  const cidRight = median(anchors.map((a) => a.word.x1));
  const headerWords = words.filter((w) => dyFrom(w, first) < -rowH * 0.4 && dyFrom(w, first) > -rowH * 6 && w.xc > cidRight);
  const colX: Partial<Record<AmountField | 'reference', number>> = {};
  const found = {
    amountPaid: findHeaderX(headerWords, /AMOU|OUNT|PAID|CASH/i),
    clientInitiated: findHeaderX(headerWords, /CLIEN|INITI|TIATED/i),
    agentAssisted: findHeaderX(headerWords, /AGEN|ASSIS|SSIST/i),
    reference: findHeaderX(headerWords, /REFER|ERENCE/i),
  };
  // Keep only headers in the expected left→right order: cash < client < agent < reference.
  let lastX = -Infinity;
  for (const k of ['amountPaid', 'clientInitiated', 'agentAssisted', 'reference'] as const) {
    const x = found[k];
    if (x != null && x > lastX) { colX[k] = x; lastX = x; }
  }
  const amountCols = (['amountPaid', 'clientInitiated', 'agentAssisted'] as const).filter((c) => colX[c] != null);
  const columnsDetected = amountCols.length > 0;
  const firstAmountX = columnsDetected ? Math.min(...amountCols.map((c) => colX[c]!)) : null;
  const knownCols = [...amountCols, ...(colX.reference != null ? (['reference'] as const) : [])];
  const colWidth = knownCols.length >= 2
    ? Math.min(...knownCols.slice(1).map((c, i) => Math.abs(colX[c]! - colX[knownCols[i]]!)))
    : rowH * 3;

  // Where the name column ends: just left of the first amount column, or — when the headers
  // weren't read — a bit under half of the remaining page width.
  const nameAreaEnd = firstAmountX != null
    ? firstAmountX - colWidth * 0.6
    : cidRight + (pageWidth - cidRight) * 0.45;

  // 2b. recover rows whose CID was unreadable: a cluster of name words with no CID beside it.
  //     They get a blank CID (filled later by matching the name against saved members).
  {
    const cidXc = median(anchors.map((a) => a.word.xc));
    const nameLimit = nameAreaEnd;
    const top = anchors[0].word.yc - rowH * 0.5;
    const bottom = anchors[anchors.length - 1].word.yc + rowH * 1.5;
    const orphan = words
      .filter((w) => !anchorSet(w) && w.x0 > cidRight - 4 && w.x0 < cidRight + rowH * 4 && w.xc < nameLimit)
      .filter((w) => /[A-Za-z]{3,}/.test(w.text) && !/TOTAL|AMOUNT|NAME/i.test(w.text))
      .map((w) => ({ w, y: w.yc - slope * (w.xc - cidXc) }))
      .filter(({ y }) => y > top && y < bottom)
      .filter(({ w }) => anchors.every((a) => Math.abs(dyFrom(w, a)) > rowH * 0.6))
      .sort((a, b) => a.y - b.y);
    let lastY = -Infinity;
    for (const { y } of orphan) {
      if (y - lastY < rowH * 0.5) continue;
      lastY = y;
      const fake: W = { text: '', conf: 0, x0: cidRight - 1, x1: cidRight, y0: y - 1, y1: y + 1, xc: cidXc, yc: y };
      anchors.push({ cid: '', word: fake });
    }
    anchors.sort((a, b) => a.word.yc - b.word.yc);
  }

  const anchorWords = new Set(anchors.map((a) => a.word));
  const used = new Set<W>();

  // 3. names: split the letter-words right of the CID into gap-separated clusters and take the
  //    first one that looks like a real name (stray marks from ruling lines come out as "Ea", "TT").
  const names = anchors.map((a) => {
    const cand = words
      .filter((w) => !anchorWords.has(w) && w.x0 > a.word.x1 - 4 && w.xc < nameAreaEnd)
      .filter((w) => Math.abs(dyFrom(w, a)) < rowH * 0.45)
      .filter((w) => /[A-Za-zÑñ]/.test(w.text))
      .sort((p, q) => p.x0 - q.x0);
    const clusters: W[][] = [];
    for (const w of cand) {
      const cur = clusters[clusters.length - 1];
      const prev = cur?.[cur.length - 1];
      if (prev && w.x0 - prev.x1 < rowH * 1.5) cur.push(w);
      else clusters.push([w]);
    }
    const letters = (c: W[]) => c.reduce((t, w) => t + (w.text.match(/[A-Za-zÑñ]/g)?.length ?? 0), 0);
    const avgConf = (c: W[]) => c.reduce((t, w) => t + w.conf, 0) / c.length;
    const parts =
      clusters.find((c) => letters(c) >= 5 && avgConf(c) >= 55) ??
      clusters.reduce<W[]>((best, c) => (letters(c) * avgConf(c) > letters(best) * (best.length ? avgConf(best) : 0) ? c : best), []);
    parts.forEach((w) => used.add(w));
    const name = parts
      .map((w) => w.text)
      .join(' ')
      .replace(/[^A-Za-zÑñ .,'-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
    return { name, conf: parts.length ? Math.min(...parts.map((w) => w.conf)) : 0, endX: parts.length ? parts[parts.length - 1].x1 : a.word.x1 };
  });
  const nameEndX = median(names.map((n) => n.endX));

  // 4. amounts
  const maxX = colX.reference != null
    ? colX.reference + colWidth * 0.8
    : firstAmountX != null
      ? Math.max(...amountCols.map((c) => colX[c]!)) + colWidth
      : nameEndX + pageWidth * 0.35;
  // Plausible amounts only: ruling lines read as "1", "|", "-" and would otherwise fill every cell.
  const candidates = words.filter(
    (w) => !anchorWords.has(w) && !used.has(w) && w.x0 > nameEndX - 4 && w.xc < maxX && isPlausibleAmount(w.text, w.conf),
  );

  // Handwritten amounts don't line up with the printed rows the way the names do: the page
  // curls near the binding, and writers drift above/below the line. So measure how far the
  // handwriting sits from its row separately in the top and bottom halves of the sheet, and
  // interpolate between them. (A whole-row slip can't be told apart from a correct match, so
  // the review screen has "shift column" buttons for that case.)
  const firstY = anchors[0].word.yc;
  const lastY = anchors[anchors.length - 1].word.yc;
  let amountCands = candidates
    .filter((w) => w.yc > firstY - rowH * 1.6 && w.yc < lastY + rowH * 2.5)
    .sort((p, q) => p.yc - q.yc);
  if (amountCands.length >= 3) {
    // drop a trailing grand total (e.g. "13,190")
    const bottom = amountCands[amountCands.length - 1];
    const restSum = amountCands.slice(0, -1).reduce((t, w) => t + (parseAmount(w.text) ?? 0), 0);
    if ((parseAmount(bottom.text) ?? 0) >= restSum * 0.5 || /\d,\d{3}/.test(bottom.text)) amountCands = amountCands.slice(0, -1);
  }
  const residual = (w: W) => {
    const d = anchors.map((a) => w.yc - a.word.yc);
    return d.reduce((b, x) => (Math.abs(x) < Math.abs(b) ? x : b), Infinity);
  };
  const midY = (firstY + lastY) / 2;
  const topRes = amountCands.filter((w) => w.yc < midY).map(residual);
  const botRes = amountCands.filter((w) => w.yc >= midY).map(residual);
  const allMed = median(amountCands.map(residual));
  const offTop = topRes.length >= 3 ? median(topRes) : allMed;
  const offBot = botRes.length >= 3 ? median(botRes) : allMed;
  const yTop = (firstY + midY) / 2;
  const yBot = (midY + lastY) / 2;
  const amountOffset = (y: number) =>
    yBot > yTop ? offTop + ((offBot - offTop) * (y - yTop)) / (yBot - yTop) : offTop;
  const nearest = (w: W) => {
    let best = anchors[0];
    let bestD = Infinity;
    for (const a of anchors) {
      const d = Math.abs(w.yc - (a.word.yc + amountOffset(a.word.yc)));
      if (d < bestD) { bestD = d; best = a; }
    }
    return { anchor: best, dist: bestD };
  };

  type Hit = { w: W; dist: number };
  const cells = new Map<string, Hit>(); // key: anchorIndex|field|ref
  for (const w of amountCands) {
    const { anchor, dist } = nearest(w);
    if (dist > rowH * 0.55) continue;
    let field: AmountField | 'reference' = opts.defaultColumn;
    if (columnsDetected) {
      const all = [...amountCols, ...(colX.reference != null ? (['reference'] as const) : [])];
      field = all.reduce((b, c) => (Math.abs(colX[c]! - w.xc) < Math.abs(colX[b]! - w.xc) ? c : b), all[0]);
    }
    const key = `${anchors.indexOf(anchor)}|${field}`;
    const prev = cells.get(key);
    if (!prev) cells.set(key, { w, dist });
    else if (Math.abs(prev.w.yc - w.yc) < rowH * 0.3) {
      // same cell split into two words ("1," "500") → join left-to-right
      const [l, r] = prev.w.x0 < w.x0 ? [prev.w, w] : [w, prev.w];
      cells.set(key, { w: { ...l, text: l.text + r.text, x1: r.x1, conf: Math.min(l.conf, r.conf) }, dist: prev.dist });
    } else if (dist < prev.dist) cells.set(key, { w, dist });
  }

  // 5. build rows
  const rows = anchors.map((a, i) => {
    const notes: string[] = [];
    const vals: Partial<Record<AmountField, string>> = {};
    let reference = '';
    const confs = [a.word.conf, names[i].conf];
    for (const f of ['amountPaid', 'clientInitiated', 'agentAssisted', 'reference'] as const) {
      const hit = cells.get(`${i}|${f}`);
      if (!hit) continue;
      confs.push(hit.w.conf);
      if (f === 'reference') { reference = hit.w.text; continue; }
      const n = parseAmount(hit.w.text);
      if (n == null) notes.push(`Unreadable amount "${hit.w.text}"`);
      vals[f] = n == null ? hit.w.text : String(n);
    }
    if (!a.cid) notes.push('CID not read');
    else if (a.cid.length !== 6 && a.cid.length !== 10) notes.push('Unusual CID length');
    if (!names[i].name) notes.push('Name not read');
    return newRow({
      cid: a.cid,
      name: names[i].name,
      ...vals,
      referenceNumber: reference,
      confidence: Math.round(Math.min(...confs)),
      notes,
      source: opts.source,
    });
  });

  const geometry: TableGeometry = {
    rowH, colWidth, colX,
    rowCenters: anchors.map((a) => ({ xc: a.word.xc, yc: a.word.yc + amountOffset(a.word.yc) })),
  };
  return { rows, columnsDetected, geometry };
}

export interface TableGeometry {
  rowH: number;
  colWidth: number;
  colX: Partial<Record<AmountField | 'reference', number>>;
  /** one per returned row, same order; yc is where that row's handwriting sits */
  rowCenters: { xc: number; yc: number }[];
}

export interface CellRect { row: number; field: AmountField; left: number; top: number; width: number; height: number }

/** Where each amount cell sits on the page, so it can be re-read on its own. */
export function amountCellRects(g: TableGeometry, pageW: number, pageH: number): CellRect[] {
  const out: CellRect[] = [];
  const fields = (['amountPaid', 'clientInitiated', 'agentAssisted'] as const).filter((f) => g.colX[f] != null);
  g.rowCenters.forEach((c, row) => {
    for (const field of fields) {
      const x = g.colX[field]!;
      const y = c.yc;
      const width = g.colWidth * 0.95;
      const height = g.rowH * 1.05;
      const left = Math.max(0, Math.round(x - width / 2));
      const top = Math.max(0, Math.round(y - height / 2));
      out.push({
        row, field, left, top,
        width: Math.round(Math.min(width, pageW - left)),
        height: Math.round(Math.min(height, pageH - top)),
      });
    }
  });
  return out.filter((r) => r.width > 4 && r.height > 4);
}

/**
 * Combines the whole-page reading of an amount with the single-cell re-read.
 * Returns the value to show, or undefined to keep what the page pass found.
 */
export function pickCellValue(pageVal: string | undefined, cellText: string, cellConf: number): string | undefined {
  const t = cellText.replace(/\s+/g, '').replace(/^[.,-]+|[.,-]+$/g, '');
  if (!t) return undefined;
  const n = parseAmount(t);
  if (n == null || n < 10) return undefined; // blank / dash / table line
  const pageN = pageVal != null ? parseAmount(pageVal) : null;
  if (pageN == null) return cellConf >= 45 ? String(n) : undefined;
  return cellConf >= 60 ? String(n) : undefined;
}

export async function terminateOcr() {
  if (workerPromise) {
    const w = await workerPromise;
    await w.terminate();
    workerPromise = null;
  }
}

/* ------------------------------------------------------------------ */
/* Accurate OCR: local RapidOCR service (ocr-server/server.py)         */
/* ------------------------------------------------------------------ */

/** Applies EXIF orientation + rotation and returns an upright colour JPEG (long side ≤ maxSide) plus a preview URL. */
export async function prepareForService(
  file: File,
  rotation = 0,
  maxSide = 3200,
  quality = 0.95,
): Promise<{ blob: Blob; preview: string }> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const rotated = rotation % 180 !== 0;
  const srcW = rotated ? bmp.height : bmp.width;
  const srcH = rotated ? bmp.width : bmp.height;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (-bmp.width * scale) / 2, (-bmp.height * scale) / 2, bmp.width * scale, bmp.height * scale);
  bmp.close();
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), 'image/jpeg', quality),
  );
  return { blob, preview: canvas.toDataURL('image/jpeg', 0.8) };
}

interface ServiceRow {
  cid: string;
  name: string;
  amountPaid: string;
  clientInitiated: string;
  agentAssisted: string;
  referenceNumber: string;
  confidence: number;
  notes: string[];
}

export class OcrServiceUnavailable extends Error {}

/**
 * Sends a page to the local OCR service (RapidOCR + ruling-line table detection).
 * Throws OcrServiceUnavailable if the service isn't running, so callers can fall back.
 */
export async function ocrWithLocalService(blob: Blob, source: string): Promise<OcrResult> {
  let resp: Response;
  try {
    resp = await fetch(`${import.meta.env.BASE_URL}api/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
  } catch {
    throw new OcrServiceUnavailable('OCR service not reachable');
  }
  // Vite's proxy answers 502/504 (or 500 with an HTML body) when the service is down
  const isJson = resp.headers.get('content-type')?.includes('application/json');
  if (!isJson || resp.status === 502 || resp.status === 503 || resp.status === 504) {
    throw new OcrServiceUnavailable(`OCR service unavailable (${resp.status})`);
  }
  const data = (await resp.json()) as {
    rows?: ServiceRow[];
    columnsDetected?: boolean;
    text?: string;
    error?: string;
  };
  if (!resp.ok) throw new Error(data.error || `OCR failed (${resp.status})`);
  const rows = (data.rows ?? []).map((r) =>
    newRow({
      cid: r.cid,
      name: r.name,
      amountPaid: r.amountPaid,
      clientInitiated: r.clientInitiated,
      agentAssisted: r.agentAssisted,
      referenceNumber: r.referenceNumber,
      confidence: r.confidence,
      notes: r.notes ?? [],
      source,
    }),
  );
  return { rows, rawText: data.text ?? '', columnsDetected: !!data.columnsDetected };
}
