import type { Member } from '../db';
// Shared similarity rules (owned by the members/profile code) so that upload matching and the
// duplicate flags on profiles agree on what "the same person" means.
import { CID_CLOSE_NAME_MIN, NAME_ONLY_MIN, cidClose, nameSimilarity } from './match';

/** name-only matches must clearly beat the runner-up, so siblings/namesakes aren't mixed up */
const NAME_ONLY_MARGIN = 0.06;

export type MatchKind = 'cid' | 'cid-fuzzy' | 'name';

export interface MemberMatch {
  member: Member;
  kind: MatchKind;
  /** human-readable reason, shown in the review table */
  reason: string;
}

const usableCid = (cid: string) => /^\d{5,}$/.test(cid);

/**
 * Finds the existing member a scanned/imported row refers to:
 *  1. exact CID
 *  2. CID within one digit edit (substitution / drop / insert) and a similar name
 *  3. a strongly similar name (covers blank, unreadable or badly misread CIDs)
 * Members already claimed by another row of the same sheet (`taken`) are skipped.
 */
export function matchMember(
  row: { cid: string; name: string },
  members: Member[],
  taken: Set<number> = new Set(),
): MemberMatch | null {
  const pool = members.filter((m) => !taken.has(m.id!));
  const cid = row.cid.trim();

  if (cid) {
    const exact = pool.find((m) => m.cid === cid);
    if (exact) return { member: exact, kind: 'cid', reason: 'Same CID' };
  }

  if (usableCid(cid) && row.name) {
    let best: { m: Member; sim: number } | null = null;
    for (const m of pool) {
      if (!cidClose(m.cid, cid)) continue;
      const sim = nameSimilarity(row.name, m.name);
      if (sim >= CID_CLOSE_NAME_MIN && (!best || sim > best.sim)) best = { m, sim };
    }
    if (best) return { member: best.m, kind: 'cid-fuzzy', reason: `CID 1 digit off (saved ${best.m.cid}); name matches` };
  }

  if (row.name) {
    let best: { m: Member; sim: number } | null = null;
    let second = 0;
    for (const m of pool) {
      const sim = nameSimilarity(row.name, m.name);
      if (!best || sim > best.sim) {
        second = best?.sim ?? second;
        best = { m, sim };
      } else if (sim > second) second = sim;
    }
    if (best && best.sim >= NAME_ONLY_MIN && best.sim - second >= NAME_ONLY_MARGIN) {
      return {
        member: best.m,
        kind: 'name',
        reason: usableCid(cid) ? `Name matches (saved CID ${best.m.cid})` : 'CID unreadable; name matches',
      };
    }
  }
  return null;
}

/** Matches a whole sheet: exact CIDs first (so they win), then fuzzy ones, each member once. */
export function matchSheet<T extends { cid: string; name: string }>(rows: T[], members: Member[]): (MemberMatch | null)[] {
  const taken = new Set<number>();
  const out: (MemberMatch | null)[] = rows.map(() => null);
  rows.forEach((r, i) => {
    const m = members.find((x) => r.cid && x.cid === r.cid.trim() && !taken.has(x.id!));
    if (m) {
      out[i] = { member: m, kind: 'cid', reason: 'Same CID' };
      taken.add(m.id!);
    }
  });
  rows.forEach((r, i) => {
    if (out[i]) return;
    const m = matchMember(r, members, taken);
    if (m) {
      out[i] = m;
      taken.add(m.member.id!);
    }
  });
  return out;
}
