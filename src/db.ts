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

export const db = new Dexie('lendwise') as Dexie & {
  groups: EntityTable<Group, 'id'>;
  members: EntityTable<Member, 'id'>;
  payments: EntityTable<Payment, 'id'>;
};

db.version(1).stores({
  groups: '++id, order',
  members: '++id, groupId, cid, [groupId+cid], order',
  payments: '++id, groupId, memberId, date, [groupId+date], [memberId+date]',
});

export interface SheetRow {
  cid: string;
  name: string;
  cash: number;
  client: number;
  agent: number;
  referenceNumber: string;
}

/**
 * Saves rows from an uploaded sheet (CSV/Excel/OCR) into one group on one date.
 * - Members are matched by CID within the group; new ones are appended.
 * - For each channel with a non-zero amount, that member/date/channel payment is replaced.
 * - A zero amount leaves existing payments for that channel untouched.
 */
export async function importSheetRows(groupId: number, date: string, rows: SheetRow[]) {
  let added = 0, updated = 0, payments = 0;
  await db.transaction('rw', db.members, db.payments, async () => {
    const existing = await db.members.where('groupId').equals(groupId).toArray();
    let nextOrder = existing.reduce((m, x) => Math.max(m, x.order), -1) + 1;

    for (const r of rows) {
      let member = await db.members.where('[groupId+cid]').equals([groupId, r.cid]).first();
      if (member) {
        if (r.name && r.name !== member.name) await db.members.update(member.id!, { name: r.name });
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
