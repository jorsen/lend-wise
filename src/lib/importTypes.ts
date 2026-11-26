export type AmountField = 'amountPaid' | 'clientInitiated' | 'agentAssisted';

export const AMOUNT_LABELS: Record<AmountField, string> = {
  amountPaid: 'Amount Paid/Cash',
  clientInitiated: 'Client Initiated',
  agentAssisted: 'Agent Assisted',
};

/** One row in the review step, before it is saved. Values are strings so they can be edited. */
export interface ImportRow {
  key: string;
  include: boolean;
  cid: string;
  name: string;
  amountPaid: string;
  clientInitiated: string;
  agentAssisted: string;
  referenceNumber: string;
  /** 0-100, only set for OCR rows */
  confidence?: number;
  /** Notes produced by parsing (e.g. "CID corrected from name") */
  notes: string[];
  /** Which image page the row came from (OCR only) */
  source?: string;
  /** Existing member this row is for (null = new member). Set in the review step. */
  matchId?: number | null;
  /** how matchId was chosen: exact CID, fuzzy CID/name, or picked by hand */
  matchKind?: 'cid' | 'cid-fuzzy' | 'name' | 'manual';
  matchReason?: string;
}

let counter = 0;
export function newRow(partial: Partial<ImportRow>): ImportRow {
  return {
    key: `r${Date.now()}-${counter++}`,
    include: true,
    cid: '',
    name: '',
    amountPaid: '',
    clientInitiated: '',
    agentAssisted: '',
    referenceNumber: '',
    notes: [],
    ...partial,
  };
}

/**
 * Turns an amount as written on paper / read by OCR into a number.
 * Handles "1,500", "—" (blank = 0) and common OCR digit confusions (O→0, l→1, S→5 ...).
 * Returns null when the value cannot be understood.
 */
export function parseAmount(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return 0;
  if (/^[-–—_~=.]+$/.test(s)) return 0;
  const fixed = s
    .replace(/^["'`.,:;]+|["'`.,:;]+$/g, '') // stray marks around handwriting
    .replace(/[Oo°DQ]/g, '0')
    .replace(/[lI|!i\]\[(){}£]/g, '1')
    .replace(/[Ss$]/g, '5')
    .replace(/[Zz]/g, '2')
    .replace(/B/g, '8')
    .replace(/[gq]/g, '9')
    .replace(/[,\s']/g, '');
  if (!/^\d+(\.\d+)?$/.test(fixed)) return null;
  return Number(fixed);
}

/** "KYC" written in the Agent Assisted column (any case, spacing or trailing dot). */
export const isKyc = (raw: string) => /^k\s*y\s*c\.?$/i.test(raw.trim());

/** True when a cell can't be imported: not a number, and not an accepted marker like KYC for agent assisted. */
export const isUnreadableAmount = (field: AmountField, raw: string) =>
  parseAmount(raw) == null && !(field === 'agentAssisted' && isKyc(raw));

export function normalizeName(name: string): string {
  return name.toUpperCase().replace(/[^A-ZÑ]/g, '');
}
