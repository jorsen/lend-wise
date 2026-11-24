// Helpers for spotting the same person under slightly different spellings or CIDs.
// Shared by the duplicate flags (profiles, Members list) and upload matching (memberMatch.ts).
import type { Member } from '../db'

/** Uppercase letters only: "Cesaria E. Marquez" and "CESARIAEMARQUEZ" both become "CESARIAEMARQUEZ". */
export const normalizeName = (s: string) => s.toUpperCase().replace(/[^A-ZÑ]/g, '')

/** Name without single-letter middle initials, for looser comparison. */
const coreName = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-ZÑ\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .join('')

export function levenshtein(a: string, b: string) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/** 0..1, where 1 means identical after normalising. Middle initials are treated loosely. */
export function nameSimilarity(a: string, b: string) {
  const score = (x: string, y: string) => (x && y ? 1 - levenshtein(x, y) / Math.max(x.length, y.length) : 0)
  const na = normalizeName(a)
  const nb = normalizeName(b)
  const ca = coreName(a) || na
  const cb = coreName(b) || nb
  // A glued initial ("CESARIAEMARQUEZ") vs a spaced one: compare each side's full form with the other's core.
  return Math.max(score(na, nb), score(ca, cb), 0.97 * Math.max(score(na, cb), score(ca, nb)))
}

const digits = (s: string) => s.replace(/\D/g, '')

/** CIDs equal, or one digit substituted, dropped or added. */
export function cidClose(a: string, b: string) {
  const x = digits(a)
  const y = digits(b)
  return !!x && !!y && levenshtein(x, y) <= 1
}

/** Thresholds shared with upload matching so both agree on "same person". */
export const CID_CLOSE_NAME_MIN = 0.6
export const NAME_ONLY_MIN = 0.85

export type DuplicateReason = 'same CID' | 'similar CID and name' | 'similar name'

/** Other members who look like the same person as `m`, best matches first. */
export function findLikelyDuplicates(m: Member, others: Member[]) {
  const out: { member: Member; reason: DuplicateReason; score: number }[] = []
  for (const o of others) {
    if (o.id === m.id) continue
    const sim = nameSimilarity(m.name, o.name)
    if (digits(m.cid) && digits(m.cid) === digits(o.cid)) out.push({ member: o, reason: 'same CID', score: 2 + sim })
    else if (cidClose(m.cid, o.cid) && sim >= CID_CLOSE_NAME_MIN) out.push({ member: o, reason: 'similar CID and name', score: 1 + sim })
    else if (sim >= NAME_ONLY_MIN) out.push({ member: o, reason: 'similar name', score: sim })
  }
  return out.sort((x, y) => y.score - x.score)
}

/** Two-letter badge text: first and last name initials, skipping middle initials. */
export function initials(name: string) {
  const words = name
    .toUpperCase()
    .replace(/[^A-ZÑ\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
  return (words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : '') || '?'
}
