import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronUp, ClipboardPaste, Copy, FileSpreadsheet, Image as ImageIcon, Loader2, RotateCw, ScanText, Trash2, Upload, X,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, importSheetRows, replaceSheetImages } from '../db';
import { AMOUNT_LABELS, normalizeName, parseAmount, type AmountField, type ImportRow } from '../lib/importTypes';
import { parseSpreadsheet } from '../lib/parseSpreadsheet';
import Magnifier from './Magnifier';
import {
  ocrMemberSheet, ocrWithLocalService, OcrServiceUnavailable, prepareForService, preprocessImage, type OcrProgress, type OcrResult,
} from '../lib/ocr';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Group the uploaded members/payments belong to */
  groupId: number;
  /** Payment date for the uploaded amounts, YYYY-MM-DD */
  date: string;
  onImported?: (result: { added: number; updated: number; payments: number }) => void;
}

interface PickedImage {
  file: File;
  url: string;
  rotation: number;
}

/** Turns pasted text (tab-separated cells copied from Excel/Sheets, or CSV) into a CSV file. */
function textToCsvFile(text: string): File {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const csv = lines.some((l) => l.includes('\t'))
    ? lines.map((l) => l.split('\t').map((c) => `"${c.trim().replace(/"/g, '""')}"`).join(',')).join('\n')
    : lines.join('\n');
  return new File([csv], `Pasted text (${lines.length} lines).csv`, { type: 'text/csv' });
}

/** Writes text to the clipboard; falls back to execCommand on plain-http LAN addresses. */
async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Copy was blocked by the browser');
}

const isImage = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|heic)$/i.test(f.name);

export default function UploadMembersDialog({ open, onClose, groupId, date, onImported }: Props) {
  const existing = useLiveQuery(() => db.members.where('groupId').equals(groupId).toArray(), [groupId]) ?? [];
  const inputRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<PickedImage[]>([]);
  const [sheet, setSheet] = useState<File | null>(null);
  const [defaultColumn, setDefaultColumn] = useState<AmountField>('agentAssisted');
  const [busy, setBusy] = useState<OcrProgress & { page?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [rawText, setRawText] = useState('');
  const [columnsDetected, setColumnsDetected] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fallbackUsed, setFallbackUsed] = useState(false);

  useEffect(() => {
    if (!open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function reset() {
    images.forEach((i) => URL.revokeObjectURL(i.url));
    setImages([]); setSheet(null); setRows(null); setPreviews([]); setRawText('');
    setError(null); setBusy(null); setSaving(false);
  }

  function pickFiles(list: FileList | File[] | null) {
    if (!list?.length) return;
    setError(null);
    const files = Array.from(list);
    const imgs = files.filter(isImage);
    const sheets = files.filter((f) => !isImage(f));
    if (sheets.length) {
      setSheet(sheets[0]);
      setImages([]);
    } else if (imgs.length) {
      setSheet(null);
      setImages((prev) => [...prev, ...imgs.map((file) => ({ file, url: URL.createObjectURL(file), rotation: 0 }))]);
    }
  }

  // Ctrl+V anywhere in the dialog (upload step): screenshots/photos or cells copied from Excel.
  useEffect(() => {
    if (!open || rows !== null) return;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const files = Array.from(cd.items)
        .filter((i) => i.kind === 'file')
        .map((i, n) => {
          const f = i.getAsFile();
          return f && new File([f], f.name && f.name !== 'image.png' ? f.name : `pasted-${Date.now()}-${n}.png`, { type: f.type });
        })
        .filter((f): f is File => !!f);
      if (files.length) {
        e.preventDefault();
        pickFiles(files);
        return;
      }
      const text = cd.getData('text/plain');
      if (text.trim()) {
        e.preventDefault();
        pickFiles([textToCsvFile(text)]);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows]);

  /** "Paste" button: reads the clipboard directly (needs localhost/https; otherwise use Ctrl+V). */
  async function pasteFromClipboard() {
    setError(null);
    try {
      if (!navigator.clipboard?.read || !window.isSecureContext) throw new Error('unsupported');
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          files.push(new File([blob], `pasted-${Date.now()}-${files.length}.${type.split('/')[1] || 'png'}`, { type }));
        }
      }
      if (files.length) return pickFiles(files);
      const text = await navigator.clipboard.readText();
      if (text.trim()) return pickFiles([textToCsvFile(text)]);
      setError('The clipboard has no image or table text. Copy a photo/screenshot or Excel cells first.');
    } catch (e) {
      setError(
        e instanceof Error && e.message === 'unsupported'
          ? 'This browser blocks the Paste button on this address — press Ctrl+V instead.'
          : e instanceof DOMException && e.name === 'NotAllowedError'
            ? 'Clipboard access was denied — press Ctrl+V instead.'
            : `Could not read the clipboard: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Copies the review table as tab-separated text, ready to paste into Excel/Sheets. */
  async function copyTable() {
    if (!rows) return;
    const header = ['CID', 'Member Name', 'Amount Paid/Cash', 'Client Initiated Payment', 'Agent Assisted Payment', 'Reference Number'];
    const body = rows
      .filter((r) => r.include)
      .map((r) => [r.cid, r.name, r.amountPaid, r.clientInitiated, r.agentAssisted, r.referenceNumber].map((c) => c.replace(/[\t\n]/g, ' ')).join('\t'));
    try {
      await copyText([header.join('\t'), ...body].join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function process() {
    setError(null);
    try {
      if (sheet) {
        setBusy({ status: 'Reading file', progress: 0.5 });
        const parsed = await parseSpreadsheet(sheet);
        if (!parsed.length) throw new Error('No rows found. Make sure the file has CID and Name columns.');
        setRows(finalize(parsed));
        setPreviews([]);
      } else {
        const all: ImportRow[] = [];
        const urls: string[] = [];
        let text = '';
        let detected = true;
        let usedFallback = false;
        for (const [idx, img] of images.entries()) {
          const page = `Page ${idx + 1}`;
          setBusy({ status: 'Preparing image', progress: 0, page });
          let res: OcrResult;
          try {
            // Accurate engine: local RapidOCR service with ruling-line table detection
            const { blob, preview } = await prepareForService(img.file, img.rotation);
            setBusy({ status: 'Reading the sheet (about 15–30 s per page)', progress: 0.3, page });
            res = await ocrWithLocalService(blob, page);
            urls.push(preview);
          } catch (e) {
            if (!(e instanceof OcrServiceUnavailable)) throw e;
            // Fallback: in-browser Tesseract (much less accurate)
            usedFallback = true;
            const canvas = await preprocessImage(img.file, img.rotation);
            urls.push(canvas.toDataURL('image/jpeg', 0.85));
            res = await ocrMemberSheet(canvas, {
              defaultColumn,
              source: page,
              onProgress: (p) => setBusy({ ...p, page }),
            });
          }
          all.push(...res.rows);
          text += `--- ${page} ---\n${res.rawText}\n`;
          detected &&= res.columnsDetected;
        }
        if (!all.length) {
          throw new Error(
            'No member rows were recognised. Try a sharper, well-lit photo taken straight on, or rotate the image so the text is upright.',
          );
        }
        setRows(finalize(all));
        setPreviews(urls);
        setRawText(text);
        setColumnsDetected(detected);
        setFallbackUsed(usedFallback);
      }
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** Cross-check against members already saved: fix CIDs by name match, flag duplicates. */
  function finalize(list: ImportRow[]): ImportRow[] {
    const byCid = new Map(existing.map((m) => [m.cid, m]));
    const byName = new Map(existing.map((m) => [normalizeName(m.name), m]));
    return list.map((r) => {
      const notes = [...r.notes];
      let { cid, name } = r;
      const nameKey = normalizeName(name);
      if (!byCid.has(cid) && nameKey && byName.has(nameKey)) {
        const m = byName.get(nameKey)!;
        notes.push(`CID corrected ${cid || '(blank)'} → ${m.cid} (name match)`);
        cid = m.cid;
      }
      const saved = byCid.get(cid);
      // OCR often drops spaces ("BENILDAV.MARQUEZ"); prefer the saved spelling when only spacing differs
      if (saved && (!name || normalizeName(name) === normalizeName(saved.name))) name = saved.name;
      return { ...r, cid, name, notes };
    });
  }

  const status = useMemo(() => {
    if (!rows) return new Map<string, { label: string; tone: 'new' | 'update' | 'error' }>();
    const byCid = new Map(existing.map((m) => [m.cid, m]));
    const seen = new Map<string, number>();
    rows.forEach((r) => r.include && seen.set(r.cid, (seen.get(r.cid) ?? 0) + 1));
    return new Map(
      rows.map((r) => {
        let s: { label: string; tone: 'new' | 'update' | 'error' };
        if (!/^\d{4,}$/.test(r.cid)) s = { label: 'Invalid CID', tone: 'error' };
        else if (!r.name.trim() && !byCid.has(r.cid)) s = { label: 'Missing name', tone: 'error' };
        else if ((seen.get(r.cid) ?? 0) > 1 && r.include) s = { label: 'Duplicate CID', tone: 'error' };
        else if ((['amountPaid', 'clientInitiated', 'agentAssisted'] as const).some((f) => parseAmount(r[f]) == null))
          s = { label: 'Bad amount', tone: 'error' };
        else if (byCid.has(r.cid)) s = { label: 'Update', tone: 'update' };
        else s = { label: 'New', tone: 'new' };
        return [r.key, s];
      }),
    );
  }, [rows, existing]);

  const included = rows?.filter((r) => r.include) ?? [];
  const blocking = included.filter((r) => status.get(r.key)?.tone === 'error').length;
  const totals = useMemo(() => {
    const t = { amountPaid: 0, clientInitiated: 0, agentAssisted: 0 };
    included.forEach((r) => (Object.keys(t) as AmountField[]).forEach((f) => (t[f] += parseAmount(r[f]) ?? 0)));
    return t;
  }, [included]);

  /** Moves a whole amount column one row up (-1) or down (+1) — fixes OCR row slips. */
  function shiftColumn(field: AmountField, dir: -1 | 1) {
    setRows((rs) => {
      const vals = rs!.map((r) => r[field]);
      return rs!.map((r, i) => ({ ...r, [field]: vals[i - dir] ?? '' }));
    });
  }

  function update(key: string, patch: Partial<ImportRow>) {
    setRows((rs) => rs!.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function save() {
    if (!rows) return;
    setSaving(true);
    try {
      const result = await importSheetRows(
        groupId,
        date,
        included.map((r) => ({
          cid: r.cid,
          name: r.name.trim().toUpperCase(),
          cash: parseAmount(r.amountPaid) ?? 0,
          client: parseAmount(r.clientInitiated) ?? 0,
          agent: parseAmount(r.agentAssisted) ?? 0,
          referenceNumber: r.referenceNumber.trim(),
        })),
      );
      // Keep the sheet photos for this group + day (upright, ≤2000px) so they can be shown
      // beside the Day sheet. A new photo upload replaces the previous one for that day.
      if (!sheet && images.length) {
        try {
          const stored = await Promise.all(
            images.map(async (im) => ({
              blob: (await prepareForService(im.file, im.rotation, 2000, 0.85)).blob,
              name: im.file.name,
            })),
          );
          await replaceSheetImages(groupId, date, stored);
        } catch (e) {
          console.error('Could not store sheet photos', e); // the import itself already succeeded
        }
      }
      onImported?.(result);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  if (!open) return null;

  const reviewing = rows !== null;
  const hasFiles = !!sheet || images.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 no-print" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={`relative flex max-h-[95vh] w-full flex-col rounded-xl bg-white shadow-2xl ${reviewing ? 'max-w-7xl' : 'max-w-2xl'}`}>
        <button className="absolute right-4 top-4 rounded p-1 text-slate-500 hover:bg-slate-100" onClick={onClose} disabled={!!busy} aria-label="Close">
          <X className="h-5 w-5" />
        </button>

        <div className="px-8 pt-7">
          <h2 className="text-xl font-semibold text-slate-900">{reviewing ? 'Review Imported Members' : 'Upload Savers Members'}</h2>
          <p className="mt-1 text-slate-500">
            {reviewing
              ? `Check every row against the photo, fix anything misread, then import. Amounts will be recorded for ${date}.`
              : 'Upload a CSV / Excel file, or photos of the collection sheet (read by OCR on this PC).'}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-8 py-5">
          {!reviewing && (
            <>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept=".csv,.xlsx,.xls,image/*"
                className="hidden"
                onChange={(e) => { pickFiles(e.target.files); e.target.value = ''; }}
              />
              <button
                type="button"
                disabled={!!busy}
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFiles(e.dataTransfer.files); }}
                className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-10 text-slate-600 transition ${dragOver ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}
              >
                <Upload className="h-9 w-9 text-slate-500" />
                <span className="text-lg">Click to select, drop, or paste (Ctrl+V)</span>
                <span className="text-sm text-slate-500">CSV, Excel (.xlsx/.xls) or images (JPG, PNG) — multiple pages allowed</span>
              </button>

              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={pasteFromClipboard}
                  className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                >
                  <ClipboardPaste className="h-4 w-4" /> Paste from clipboard
                </button>
              </div>

              {sheet && (
                <div className="mt-4 flex items-center gap-3 rounded-lg border border-slate-200 p-3">
                  <FileSpreadsheet className="h-6 w-6 text-emerald-600" />
                  <span className="flex-1 truncate text-sm">{sheet.name}</span>
                  <button className="text-slate-400 hover:text-red-500" onClick={() => setSheet(null)}><Trash2 className="h-4 w-4" /></button>
                </div>
              )}

              {images.length > 0 && (
                <>
                  <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {images.map((img, i) => (
                      <div key={img.url} className="group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                        <div className="flex aspect-[3/4] items-center justify-center overflow-hidden">
                          <img src={img.url} alt="" className="max-h-full max-w-full object-contain transition-transform" style={{ transform: `rotate(${img.rotation}deg)` }} />
                        </div>
                        <div className="flex items-center justify-between border-t border-slate-200 bg-white px-2 py-1 text-xs">
                          <span>Page {i + 1}</span>
                          <span className="flex gap-1">
                            <button title="Rotate" className="rounded p-1 hover:bg-slate-100" onClick={() => setImages((a) => a.map((x, j) => (j === i ? { ...x, rotation: (x.rotation + 90) % 360 } : x)))}>
                              <RotateCw className="h-3.5 w-3.5" />
                            </button>
                            <button title="Remove" className="rounded p-1 text-red-500 hover:bg-red-50" onClick={() => { URL.revokeObjectURL(img.url); setImages((a) => a.filter((_, j) => j !== i)); }}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <label className="mt-4 flex flex-wrap items-center gap-2 text-sm text-slate-700">
                    If column headers can't be read, put amounts in:
                    <select className="rounded-md border border-slate-300 px-2 py-1" value={defaultColumn} onChange={(e) => setDefaultColumn(e.target.value as AmountField)}>
                      {(Object.keys(AMOUNT_LABELS) as AmountField[]).map((f) => <option key={f} value={f}>{AMOUNT_LABELS[f]}</option>)}
                    </select>
                  </label>
                </>
              )}

              <div className="mt-5 rounded-lg bg-slate-50 p-4">
                <p className="font-semibold text-slate-800">Expected format:</p>
                <code className="mt-2 block rounded bg-slate-200/70 px-3 py-2 text-sm text-slate-700">
                  CID, Member Name, Agent Asst. (optional: Amount Paid/Cash, Client Initiated Payment, Reference Number)
                </code>
                <p className="mt-3 flex items-start gap-2 text-sm text-slate-600">
                  <ScanText className="mt-0.5 h-4 w-4 shrink-0" />
                  Photo tips: lay the page flat, good light, no shadows, fill the frame with the table, keep the camera straight above it. Printed CIDs and names read best; handwritten amounts should always be double-checked.
                </p>
              </div>
            </>
          )}

          {reviewing && rows && (
            <div className={`grid gap-5 ${previews.length ? 'lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : ''}`}>
              {previews.length > 0 && (
                <div className="space-y-3 lg:sticky lg:top-0 lg:max-h-[70vh] lg:overflow-auto">
                  {previews.map((p, i) => (
                    <Magnifier key={i} src={p} alt={`Page ${i + 1}`} />
                  ))}
                  {rawText && (
                    <details className="text-xs text-slate-500">
                      <summary className="cursor-pointer">Raw OCR text</summary>
                      <pre className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2">{rawText}</pre>
                    </details>
                  )}
                </div>
              )}

              <div className="min-w-0">
                {previews.length > 0 && fallbackUsed && (
                  <div className="mb-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      The accurate OCR engine isn't running, so basic in-browser OCR was used and results will be poor.
                      Restart the app (it starts the engine automatically), or run <code>npm run ocr</code>.
                    </span>
                  </div>
                )}
                {previews.length > 0 && !columnsDetected && (
                  <div className="mb-3 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <AlertTriangle className="h-4 w-4" /> Column headers weren't found, so amounts were placed in "{AMOUNT_LABELS[defaultColumn]}".
                  </div>
                )}
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                      <tr>
                        <th className="p-2"><input type="checkbox" checked={rows.every((r) => r.include)} onChange={(e) => setRows(rows.map((r) => ({ ...r, include: e.target.checked })))} /></th>
                        <th className="p-2">#</th>
                        <th className="p-2">CID</th>
                        <th className="p-2">Member Name</th>
                        {([['amountPaid', 'Cash'], ['clientInitiated', 'Client Init.'], ['agentAssisted', 'Agent Asst.']] as const).map(([f, label]) => (
                          <th key={f} className="p-2">
                            <div className="flex items-center gap-1">
                              {label}
                              {previews.length > 0 && (
                                <span className="flex flex-col">
                                  <button title="Shift this column up one row" className="rounded hover:bg-slate-200" onClick={() => shiftColumn(f, -1)}><ChevronUp className="h-3 w-3" /></button>
                                  <button title="Shift this column down one row" className="rounded hover:bg-slate-200" onClick={() => shiftColumn(f, 1)}><ChevronDown className="h-3 w-3" /></button>
                                </span>
                              )}
                            </div>
                          </th>
                        ))}
                        <th className="p-2">Ref #</th>
                        <th className="p-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const s = status.get(r.key)!;
                        const lowConf = r.confidence != null && r.confidence < 70;
                        const cell = 'w-full rounded border border-transparent bg-transparent px-1.5 py-1 hover:border-slate-300 focus:border-emerald-500 focus:bg-white focus:outline-none';
                        const amt = (f: AmountField) => (
                          <input className={`${cell} w-20 text-right ${parseAmount(r[f]) == null ? 'bg-red-50 text-red-700' : ''}`} value={r[f]} inputMode="decimal" onChange={(e) => update(r.key, { [f]: e.target.value })} />
                        );
                        return (
                          <tr key={r.key} className={`border-t border-slate-100 ${!r.include ? 'opacity-40' : lowConf ? 'bg-amber-50/60' : ''}`}>
                            <td className="p-2"><input type="checkbox" checked={r.include} onChange={(e) => update(r.key, { include: e.target.checked })} /></td>
                            <td className="p-2 text-slate-400">{i + 1}</td>
                            <td className="p-1"><input className={`${cell} !w-28 min-w-28 font-mono`} value={r.cid} onChange={(e) => update(r.key, { cid: e.target.value.replace(/\D/g, '') })} /></td>
                            <td className="p-1"><input className={`${cell} min-w-44`} value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} /></td>
                            <td className="p-1">{amt('amountPaid')}</td>
                            <td className="p-1">{amt('clientInitiated')}</td>
                            <td className="p-1">{amt('agentAssisted')}</td>
                            <td className="p-1"><input className={`${cell} w-24`} value={r.referenceNumber} onChange={(e) => update(r.key, { referenceNumber: e.target.value })} /></td>
                            <td className="p-2">
                              <span title={[...r.notes, r.confidence != null ? `OCR confidence ${r.confidence}%` : ''].filter(Boolean).join('\n')}
                                className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${s.tone === 'error' ? 'bg-red-100 text-red-700' : s.tone === 'update' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
                                {s.label}
                                {(r.notes.length > 0 || lowConf) && <AlertTriangle className="h-3 w-3 text-amber-600" />}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                      <tr>
                        <td colSpan={4} className="p-2 text-right">Total ({included.length} rows)</td>
                        <td className="p-2 text-right">{totals.amountPaid.toLocaleString()}</td>
                        <td className="p-2 text-right">{totals.clientInitiated.toLocaleString()}</td>
                        <td className="p-2 text-right">{totals.agentAssisted.toLocaleString()}</td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Yellow rows = low OCR confidence. Hover a status badge for details. Printed CIDs and names read well; handwritten amounts are often missed or misread — fill blanks from the photo and compare the total with the sheet's TOTAL AMOUNT. If amounts landed one row off, use the ▲▼ arrows in the column header.
                </p>
              </div>
            </div>
          )}

          {busy && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {busy.page ? `${busy.page}: ` : ''}{busy.status}…
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-emerald-100">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round(busy.progress * 100)}%` }} />
              </div>
            </div>
          )}
          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-100 px-8 py-5">
          {reviewing ? (
            <>
              <button className="mr-auto flex items-center gap-2 rounded-lg px-3 py-2 text-slate-600 hover:bg-slate-100" onClick={() => { setRows(null); setError(null); }}>
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button
                className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-slate-700 hover:bg-slate-50"
                onClick={copyTable}
                title="Copy the ticked rows as a table you can paste into Excel or Google Sheets"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy table'}
              </button>
              {blocking > 0 && <span className="text-sm text-red-600">{blocking} row(s) need fixing or unticking</span>}
              <button
                className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                disabled={saving || blocking > 0 || included.length === 0}
                onClick={save}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Import {included.length} member(s)
              </button>
            </>
          ) : (
            <>
              <button className="rounded-lg border border-slate-200 px-5 py-2.5 font-medium hover:bg-slate-50" onClick={onClose} disabled={!!busy}>Cancel</button>
              <button
                className="flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 font-medium text-white hover:bg-emerald-600 disabled:bg-emerald-300"
                disabled={!hasFiles || !!busy}
                onClick={process}
              >
                {images.length ? <ImageIcon className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
                {images.length ? 'Scan & Review' : 'Upload'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
