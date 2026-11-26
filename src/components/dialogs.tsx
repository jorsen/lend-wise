import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Channel, type Group, type Member } from '../db'
import { addGroup, addMember, renameGroup, updateMember } from '../lib/data'
import { Button, Field, Modal, inputClass, useToast } from './ui'
import { formatDayDate, formatPeso } from '../lib/format'

export function GroupDialog({
  open,
  group,
  onClose,
  onSaved,
}: {
  open: boolean
  group?: Group | null
  onClose: () => void
  onSaved?: (id: number) => void
}) {
  const [name, setName] = useState('')
  useEffect(() => {
    if (open) setName(group?.name ?? '')
  }, [open, group])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    if (group) {
      await renameGroup(group.id!, name)
      onSaved?.(group.id!)
    } else {
      const id = await addGroup(name)
      onSaved?.(id)
    }
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title={group ? 'Rename group' : 'New group'}>
      <form onSubmit={save}>
        <Field label="Group name">
          <input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Santan 4" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            {group ? 'Save' : 'Create group'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function MemberDialog({
  open,
  groupId,
  member,
  onClose,
}: {
  open: boolean
  groupId: number
  member?: Member | null
  onClose: () => void
}) {
  const toast = useToast()
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), []) ?? []
  const [cid, setCid] = useState('')
  const [name, setName] = useState('')
  const [targetGroup, setTargetGroup] = useState(groupId)
  const [keepOpen, setKeepOpen] = useState(false)

  useEffect(() => {
    if (open) {
      setCid(member?.cid ?? '')
      setName(member?.name ?? '')
      setTargetGroup(member?.groupId ?? groupId)
    }
  }, [open, member, groupId])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    const dup = cid.trim()
      ? await db.members.where('cid').equals(cid.trim()).filter((m) => m.groupId === targetGroup && m.id !== member?.id).first()
      : undefined
    if (dup) {
      toast(`CID ${cid} already belongs to ${dup.name}`, 'error')
      return
    }
    if (member) {
      await updateMember(member.id!, { cid, name, groupId: targetGroup })
      toast('Member updated')
      onClose()
    } else {
      await addMember(targetGroup, cid, name)
      toast(`Added ${name.trim().toUpperCase()}`)
      if (keepOpen) {
        setCid('')
        setName('')
        document.getElementById('member-cid')?.focus()
      } else onClose()
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={member ? 'Edit member' : 'Add member'}>
      <form onSubmit={save}>
        <Field label="CID">
          <input id="member-cid" autoFocus className={inputClass} value={cid} onChange={(e) => setCid(e.target.value)} placeholder="1010059398" inputMode="numeric" />
        </Field>
        <Field label="Member name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="JUAN D. DELA CRUZ" />
        </Field>
        <Field label="Group">
          <select className={inputClass} value={targetGroup} onChange={(e) => setTargetGroup(Number(e.target.value))}>
            {groups.map((g) => (
              <option key={g.id} value={g.id!}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-center justify-between gap-2">
          {!member ? (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={keepOpen} onChange={(e) => setKeepOpen(e.target.checked)} className="accent-emerald-600" />
              Add another after saving
            </label>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              {member ? 'Save' : 'Add member'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

export function MemberHistoryDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const payments = useLiveQuery(
    async () => (member ? (await db.payments.where('memberId').equals(member.id!).sortBy('date')).reverse() : []),
    [member?.id],
  )
  const total = payments?.reduce((s, p) => s + p.amount, 0) ?? 0
  return (
    <Modal open={!!member} onClose={onClose} title={member?.name ?? ''} wide>
      <div className="grid grid-cols-3 gap-3 mb-4 text-center">
        <div className="rounded-lg bg-slate-50 py-2">
          <div className="text-xs text-slate-500">CID</div>
          <div className="font-semibold font-mono text-sm">{member?.cid || '—'}</div>
        </div>
        <div className="rounded-lg bg-slate-50 py-2">
          <div className="text-xs text-slate-500">Payments</div>
          <div className="font-semibold">{payments?.length ?? 0}</div>
        </div>
        <div className="rounded-lg bg-emerald-50 py-2">
          <div className="text-xs text-emerald-700">Total paid</div>
          <div className="font-semibold text-emerald-700 tabular-nums">{formatPeso(total)}</div>
        </div>
      </div>
      {payments && payments.length === 0 && <p className="text-sm text-slate-500 text-center py-6">No payments recorded yet.</p>}
      {payments && payments.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-100">
              <th className="py-2 font-medium">Date</th>
              <th className="py-2 font-medium">Paid via</th>
              <th className="py-2 font-medium">Ref #</th>
              <th className="py-2 font-medium text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-b border-slate-50">
                <td className="py-2">{formatDayDate(p.date)}</td>
                <td className="py-2">
                  <ChannelBadge channel={p.channel} />
                </td>
                <td className="py-2 text-slate-500">{p.referenceNumber || '—'}</td>
                <td className="py-2 text-right tabular-nums font-medium">{formatPeso(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}

const BADGE: Record<Channel, [string, string]> = {
  cash: ['Cash', 'bg-blue-50 text-blue-700'],
  client: ['Client', 'bg-emerald-50 text-emerald-700'],
  agent: ['Agent', 'bg-amber-50 text-amber-700'],
}

export function ChannelBadge({ channel }: { channel: Channel }) {
  const [label, cls] = BADGE[channel] ?? [channel, 'bg-slate-100 text-slate-700']
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{label}</span>
}
