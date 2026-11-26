import Dexie, { type EntityTable } from 'dexie';

export interface Group {
  id?: number;
  name: string;
  order: number;
}

export interface Member {
  id?: number;
  groupId: number;
  cid: string;
  name: string;
  order: number;
}

/** cash = "Amount Paid/Cash", client = "Client Initiated Payment", agent = "Agent Assisted Payment" */
export type Channel = 'cash' | 'client' | 'agent';

export interface Payment {
  id?: number;
  groupId: number;
  memberId: number;
  date: string; // YYYY-MM-DD (local)
  amount: number;
  channel: Channel;
  referenceNumber: string;
}

/** The Status tick on the Savers sheet: set by hand per member per day (unticked by default). */
export interface DayCheck {
  memberId: number;
  groupId: number;
  date: string; // YYYY-MM-DD
  checked: boolean;
}

/** A photo of the paper sheet uploaded for a group and day (shown beside the Day sheet). */
export interface SheetImage {
  id?: number;
  groupId: number;
  date: string; // YYYY-MM-DD
  blob: Blob;
  name: string;
  rotation: number; // degrees still to apply when displaying (uploads are stored upright: 0)
  uploadedAt: number;
}

export const db = new Dexie('lendwise') as Dexie & {
  groups: EntityTable<Group, 'id'>;
  members: EntityTable<Member, 'id'>;
  payments: EntityTable<Payment, 'id'>;
  checks: Dexie.Table<DayCheck, [number, string]>;
  sheetImages: EntityTable<SheetImage, 'id'>;
};

db.version(1).stores({
  groups: '++id, order',
  members: '++id, groupId, cid, [groupId+cid], order',
  payments: '++id, groupId, memberId, date, [groupId+date], [memberId+date]',
});
db.version(2).stores({
  checks: '[memberId+date], groupId, date, memberId, [groupId+date]',
});
db.version(3).stores({
  sheetImages: '++id, [groupId+date], groupId, date',
});

/** Replaces the stored sheet photos for a group and day. */
export async function replaceSheetImages(
  groupId: number,
  date: string,
  images: { blob: Blob; name: string }[],
) {
  await db.transaction('rw', db.sheetImages, async () => {
    await db.sheetImages.where('[groupId+date]').equals([groupId, date]).delete();
    const now = Date.now();
    await db.sheetImages.bulkAdd(images.map((im) => ({ groupId, date, blob: im.blob, name: im.name, rotation: 0, uploadedAt: now })));
  });
}

/** Ticks / unticks a member's Status for a day. Unticking removes the record (default = unticked). */
export async function setChecked(memberId: number, groupId: number, date: string, checked: boolean) {
  if (checked) await db.checks.put({ memberId, groupId, date, checked: true });
  else await db.checks.delete([memberId, date]);
}

export interface SheetRow {
  /** Existing member chosen in the review step (omit to look up by CID / add new) */
  memberId?: number;
  /** true when memberId came from a fuzzy match: the stored name/CID are left untouched */
  fuzzy?: boolean;
  cid: string;
  name: string;
  cash: number;
  client: number;
  agent: number;
  referenceNumber: string;
}

/**
 * Saves rows from an uploaded sheet (CSV/Excel/OCR) into one group on one date.
 * - A row with `memberId` goes to that member. An exact match may refresh the stored name;
 *   a fuzzy match (`fuzzy`) never overwrites the stored name or CID.
 * - Otherwise members are matched by CID within the group; new ones are appended.
 * - For each channel with a non-zero amount, that member/date/channel payment is replaced.
 * - A zero amount leaves existing payments for that channel untouched.
 */
export async function importSheetRows(groupId: number, date: string, rows: SheetRow[]) {
  let added = 0, updated = 0, payments = 0;
  await db.transaction('rw', db.members, db.payments, async () => {
    const existing = await db.members.where('groupId').equals(groupId).toArray();
    let nextOrder = existing.reduce((m, x) => Math.max(m, x.order), -1) + 1;

    for (const r of rows) {
      // A blank CID never looks anyone up: otherwise every no-CID row would land on the same member.
      let member = r.memberId != null
        ? await db.members.get(r.memberId)
        : r.cid.trim()
          ? await db.members.where('[groupId+cid]').equals([groupId, r.cid.trim()]).first()
          : undefined;
      if (member && member.groupId !== groupId) member = undefined; // safety: never cross groups
      if (member) {
        if (!r.fuzzy && r.name && r.name !== member.name) await db.members.update(member.id!, { name: r.name });
        updated++;
      } else {
        const id = await db.members.add({ groupId, cid: r.cid, name: r.name, order: nextOrder++ });
        member = { id, groupId, cid: r.cid, name: r.name, order: nextOrder - 1 };
        added++;
      }

      const memberId = member.id!;
      for (const channel of ['cash', 'client', 'agent'] as const) {
        const amount = r[channel];
        if (!amount) continue;
        await db.payments
          .where('[memberId+date]').equals([memberId, date])
          .filter((p) => p.channel === channel)
          .delete();
        await db.payments.add({ groupId, memberId, date, amount, channel, referenceNumber: r.referenceNumber });
        payments++;
      }
    }
  });
  return { added, updated, payments };
}
