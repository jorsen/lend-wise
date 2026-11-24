// Write helpers on top of the shared schema in src/db.ts (owned by the import/OCR side).
// A member has at most one payment per date per channel.
import { db, type Channel, type DayCheck, type Group, type Member, type Payment } from '../db'

export const CHANNELS: Channel[] = ['cash', 'client', 'agent']
export const CHANNEL_LABEL: Record<Channel, string> = {
  cash: 'Cash',
  client: 'Client initiated',
  agent: 'Agent assisted',
}

const SEED_KEY = 'lendwise:seeded'

// ---------- Sheet photos ----------

/** A photo of the paper sheet, stored by the Upload dialog for one group and date. */
export interface SheetImageRecord {
  id?: number
  groupId: number
  date: string
  blob: Blob
  name: string
  /** Degrees (0/90/180/270) to rotate when displaying. */
  rotation: number
  uploadedAt: number
}

/** The `sheetImages` table, or null on a database version that doesn't have it yet. */
export function sheetImagesTable() {
  return db.tables.some((t) => t.name === 'sheetImages') ? db.table<SheetImageRecord, number>('sheetImages') : null
}

const withImages = <T,>(tables: T[]) => {
  const t = sheetImagesTable()
  return t ? [...tables, t] : tables
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

const dataUrlToBlob = async (url: string) => (await fetch(url)).blob()

/** Creates the starter groups once, on a brand-new install. */
export async function seedDefaultGroups() {
  try {
    if (localStorage.getItem(SEED_KEY)) return
  } catch {
    /* storage blocked: rely on the count check */
  }
  // Inside a rw transaction so concurrent calls (e.g. StrictMode's double effect) can't both seed.
  await db.transaction('rw', db.groups, async () => {
    if ((await db.groups.count()) === 0) {
      await db.groups.bulkAdd(['Santan 9', 'Santan 9B', 'Santan 3'].map((name, i) => ({ name, order: i }) as Group))
    }
  })
  try {
    localStorage.setItem(SEED_KEY, '1')
  } catch {
    /* ignore */
  }
}

// ---------- Groups ----------

export async function addGroup(name: string) {
  const last = await db.groups.orderBy('order').last()
  return (await db.groups.add({ name: name.trim(), order: (last?.order ?? -1) + 1 } as Group)) as number
}

export const renameGroup = (id: number, name: string) => db.groups.update(id, { name: name.trim() })

export async function deleteGroup(id: number) {
  await db.transaction('rw', withImages([db.groups, db.members, db.payments, db.checks]), async () => {
    await sheetImagesTable()?.where('groupId').equals(id).delete()
    await db.payments.where('groupId').equals(id).delete()
    await db.checks.where('groupId').equals(id).delete()
    await db.members.where('groupId').equals(id).delete()
    await db.groups.delete(id)
  })
}

// ---------- Members ----------

export async function addMember(groupId: number, cid: string, name: string) {
  const existing = await db.members.where('groupId').equals(groupId).toArray()
  const order = existing.reduce((m, x) => Math.max(m, x.order ?? 0), -1) + 1
  return db.members.add({ groupId, cid: cid.trim(), name: name.trim().toUpperCase(), order } as Member)
}

export async function updateMember(id: number, changes: { cid?: string; name?: string; groupId?: number }) {
  await db.transaction('rw', db.members, db.payments, db.checks, async () => {
    const patch: Partial<Member> = {}
    if (changes.cid !== undefined) patch.cid = changes.cid.trim()
    if (changes.name !== undefined) patch.name = changes.name.trim().toUpperCase()
    if (changes.groupId !== undefined) patch.groupId = changes.groupId
    await db.members.update(id, patch)
    if (changes.groupId !== undefined) {
      await db.payments.where('memberId').equals(id).modify({ groupId: changes.groupId })
      await db.checks.where('memberId').equals(id).modify({ groupId: changes.groupId })
    }
  })
}

export async function deleteMember(id: number) {
  await db.transaction('rw', db.members, db.payments, db.checks, async () => {
    await db.payments.where('memberId').equals(id).delete()
    await db.checks.where('memberId').equals(id).delete()
    await db.members.delete(id)
  })
}

/**
 * Folds a duplicate member into another: their payments and ticks move to `intoId`,
 * then the duplicate is deleted. If both have a payment on the same date and channel,
 * the larger amount is kept (a duplicate usually comes from importing the same sheet twice).
 */
export async function mergeMembers(fromId: number, intoId: number) {
  if (fromId === intoId) return { moved: 0 }
  return db.transaction('rw', db.members, db.payments, db.checks, async () => {
    const into = await db.members.get(intoId)
    if (!into || !(await db.members.get(fromId))) throw new Error('Member not found')
    const theirs = await db.payments.where('memberId').equals(fromId).toArray()
    const mine = await db.payments.where('memberId').equals(intoId).toArray()
    const key = (p: Payment) => `${p.date}|${p.channel}`
    const existing = new Map(mine.map((p) => [key(p), p]))
    let moved = 0
    for (const p of theirs) {
      const clash = existing.get(key(p))
      if (clash) {
        if (p.amount > clash.amount) await db.payments.update(clash.id!, { amount: p.amount, referenceNumber: p.referenceNumber || clash.referenceNumber })
        await db.payments.delete(p.id!)
      } else {
        await db.payments.update(p.id!, { memberId: intoId, groupId: into.groupId })
        moved++
      }
    }
    for (const c of await db.checks.where('memberId').equals(fromId).toArray()) {
      await db.checks.delete([fromId, c.date])
      await db.checks.put({ ...c, memberId: intoId, groupId: into.groupId })
    }
    await db.members.delete(fromId)
    return { moved }
  })
}

// ---------- Payments ----------

/** Creates, updates or (amount <= 0) removes the member's payment for that date and channel. */
export async function setPayment(member: Member, date: string, channel: Channel, amount: number) {
  await db.transaction('rw', db.payments, async () => {
    const existing = await db.payments
      .where('[memberId+date]')
      .equals([member.id!, date])
      .filter((p) => p.channel === channel)
      .toArray()
    const [keep, ...dupes] = existing
    if (dupes.length) await db.payments.bulkDelete(dupes.map((p) => p.id!))
    if (!amount || amount <= 0) {
      if (keep) await db.payments.delete(keep.id!)
      return
    }
    const rounded = Math.round(amount * 100) / 100
    if (keep) await db.payments.update(keep.id!, { amount: rounded })
    else
      await db.payments.add({
        groupId: member.groupId,
        memberId: member.id!,
        date,
        channel,
        amount: rounded,
        referenceNumber: '',
      } as Payment)
  })
}

/** Moves a member's payment for that date from one channel to another (adding to any amount already there). */
export async function moveChannel(member: Member, date: string, from: Channel, to: Channel) {
  if (from === to) return
  await db.transaction('rw', db.payments, async () => {
    const ps = await db.payments.where('[memberId+date]').equals([member.id!, date]).toArray()
    const src = ps.filter((p) => p.channel === from)
    if (!src.length) return
    const amount = src.reduce((s, p) => s + p.amount, 0)
    const dst = ps.find((p) => p.channel === to)
    await db.payments.bulkDelete(src.map((p) => p.id!))
    if (dst) await db.payments.update(dst.id!, { amount: Math.round((dst.amount + amount) * 100) / 100 })
    else await db.payments.add({ ...src[0], id: undefined, channel: to, amount } as Payment)
  })
}

export async function setReference(member: Member, date: string, ref: string) {
  const ps = await db.payments.where('[memberId+date]').equals([member.id!, date]).toArray()
  await Promise.all(ps.map((p) => db.payments.update(p.id!, { referenceNumber: ref.trim() })))
}

export const clearDay = (groupId: number, date: string) =>
  db.transaction('rw', withImages([db.payments, db.checks]), async () => {
    await sheetImagesTable()?.where('[groupId+date]').equals([groupId, date]).delete()
    await db.checks.where('[groupId+date]').equals([groupId, date]).delete()
    return db.payments.where('[groupId+date]').equals([groupId, date]).delete()
  })

export function sumByChannel(payments: Payment[]) {
  const t = { cash: 0, client: 0, agent: 0, total: 0 }
  for (const p of payments) {
    t[p.channel] += p.amount
    t.total += p.amount
  }
  return t
}

// ---------- Backup ----------

export interface BackupFile {
  app: 'lend-wise'
  version: 2
  exportedAt: string
  groups: Group[]
  members: Member[]
  payments: Payment[]
  /** Manual Status ticks; missing in backups made before they existed. */
  checks?: DayCheck[]
  /** Sheet photos with the image as a data: URL; missing in older backups. */
  sheetImages?: (Omit<SheetImageRecord, 'blob'> & { dataUrl: string })[]
}

export async function exportBackup(): Promise<BackupFile> {
  const [groups, members, payments, checks] = await Promise.all([
    db.groups.toArray(),
    db.members.toArray(),
    db.payments.toArray(),
    db.checks.toArray(),
  ])
  const images = (await sheetImagesTable()?.toArray()) ?? []
  const sheetImages = await Promise.all(images.map(async ({ blob, ...rest }) => ({ ...rest, dataUrl: await blobToDataUrl(blob) })))
  return { app: 'lend-wise', version: 2, exportedAt: new Date().toISOString(), groups, members, payments, checks, sheetImages }
}

export async function restoreBackup(data: unknown) {
  const b = data as Partial<BackupFile>
  if (!b || b.app !== 'lend-wise' || !Array.isArray(b.groups) || !Array.isArray(b.members) || !Array.isArray(b.payments)) {
    throw new Error('This file is not a Lend-Wise backup.')
  }
  // Decode photos before the transaction: awaiting non-database work inside it would end it early.
  const images: SheetImageRecord[] = await Promise.all(
    (b.sheetImages ?? []).map(async ({ dataUrl, ...rest }) => ({ ...rest, blob: await dataUrlToBlob(dataUrl) })),
  )
  const imgTable = sheetImagesTable()
  await db.transaction('rw', withImages([db.groups, db.members, db.payments, db.checks]), async () => {
    await Promise.all([db.groups.clear(), db.members.clear(), db.payments.clear(), db.checks.clear(), imgTable?.clear()])
    if (imgTable && images.length) await imgTable.bulkAdd(images)
    await db.groups.bulkAdd(b.groups!)
    await db.members.bulkAdd(b.members!)
    await db.payments.bulkAdd(b.payments!)
    if (Array.isArray(b.checks)) await db.checks.bulkPut(b.checks)
  })
  return { groups: b.groups.length, members: b.members.length, payments: b.payments.length }
}
