import * as XLSX from 'xlsx';
import { newRow, type ImportRow } from './importTypes';

type Field = 'cid' | 'name' | 'amountPaid' | 'clientInitiated' | 'agentAssisted' | 'referenceNumber';

// Order matters: "Client Asst." must map to agent-assisted, not client-initiated.
const HEADER_RULES: [Field, RegExp][] = [
  ['cid', /^\s*cid\b|client\s*id/i],
  ['referenceNumber', /ref/i],
  ['agentAssisted', /agent|assist|asst/i],
  ['clientInitiated', /client.*init|initiated/i],
  ['amountPaid', /amount|cash|paid/i],
  ['name', /name/i],
];

// Used when the file has no header row.
const POSITIONAL: Field[] = ['cid', 'name', 'agentAssisted', 'amountPaid', 'clientInitiated', 'referenceNumber'];

/** Parses a CSV / XLS / XLSX file into review rows. */
export async function parseSpreadsheet(file: File): Promise<ImportRow[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '', raw: false });
  const rows = grid.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some((c) => c));
  if (rows.length === 0) return [];

  const headerIdx = rows.findIndex((r) => r.some((c) => /^\s*cid\b/i.test(c)));
  let columns: (Field | null)[];
  let body: string[][];

  if (headerIdx >= 0) {
    const used = new Set<Field>();
    columns = rows[headerIdx].map((h) => {
      const rule = HEADER_RULES.find(([f, re]) => !used.has(f) && re.test(h));
      if (!rule) return null;
      used.add(rule[0]);
      return rule[0];
    });
    body = rows.slice(headerIdx + 1);
  } else {
    columns = POSITIONAL;
    body = rows;
  }

  return body
    .map((r) => {
      const rec: Partial<Record<Field, string>> = {};
      columns.forEach((f, i) => {
        if (f && r[i] !== undefined) rec[f] = r[i];
      });
      return newRow({ ...rec, cid: (rec.cid ?? '').replace(/\D/g, '') });
    })
    .filter((r) => r.cid || r.name);
}
