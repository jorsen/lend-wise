import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, Camera, Check, ChevronLeft, ChevronRight, GitMerge, Pencil, Trash2, UserRound, Users } from 'lucide-react'
import { db, type Member, type Payment } from '../db'
import { deleteMember, mergeMembers, sheetImagesTable } from '../lib/data'
import { addMonths, formatDayDate, formatPeso, fromISODate, monthRange, today, toISODate } from '../lib/format'
import { findLikelyDuplicates, initials, nameSimilarity } from '../lib/match'
import { hrefFor, navigate, openDay } from '../lib/router'
import { Button, ConfirmDialog, Modal, StatCard, cx, inputClass, useToast } from '../components/ui'
import { ChannelBadge, MemberDialog } from '../components/dialogs'

type Day = { date: string; total: number; payments: Payment[]; checked: boolean; photo: boolean }

export function MemberProfilePage({ id }: { id: number }) {
  const toast = useToast()
  const member = useLiveQuery(() => db.members.get(id), [id])
  const group = useLiveQuery(async () => (member ? db.groups.get(member.groupId) : undefined), [member?.groupId])
  const payments = useLiveQuery(() => db.payments.where('memberId').equals(id).toArray(), [id])
  const checks = useLiveQuery(() => db.checks.where('memberId').equals(id).toArray(), [id])
  const photoDates = useLiveQuery(async () => {
    const t = sheetImagesTable()
    if (!t || !member) return new Set<string>()
    return new Set((await t.where('groupId').equals(member.groupId).toArray()).map((i) => i.date))
  }, [member?.groupId])
  const groupMembers = useLiveQuery(async () => (member ? db.members.where('groupId').equals(member.groupId).toArray() : []), [member?.groupId])

  const [month, setMonth] = useState(() => toISODate(new Date()).slice(0, 8) + '01')
  const [editOpen, setEditOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeTarget, setMergeTarget] = useState<Member | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const days: Day[] = useMemo(() => {
    const map = new Map<string, Day>()
    const checked = new Set((checks ?? []).filter((c) => c.checked).map((c) => c.date))
    for (const p of payments ?? []) {
      const d = map.get(p.date) ?? { date: p.date, total: 0, payments: [], checked: checked.has(p.date), photo: !!photoDates?.has(p.date) }
      d.total += p.amount
      d.payments.push(p)
      map.set(p.date, d)
    }
    for (const date of checked) if (!map.has(date)) map.set(date, { date, total: 0, payments: [], checked: true, photo: !!photoDates?.has(date) })
    return [...map.values()].sort((a, b) => b.date.localeCompare(a.date))
  }, [payments, checks, photoDates])

  const duplicates = useMemo(() => (member && groupMembers ? findLikelyDuplicates(member, groupMembers) : []), [member, groupMembers])

  if (member === undefined && payments === undefined) return null
  if (!member)
    return (
      <div className="p-8 text-center text-slate-600">
        This member no longer exists.{' '}
        <a className="text-emerald-700 underline" href={hrefFor({ page: 'savers', groupId: null })}>
          Back to Savers
        </a>
      </div>
    )

  const paidDays = days.filter((d) => d.total > 0)
  const total = paidDays.reduce((s, d) => s + d.total, 0)
  const [mStart, mEnd] = monthRange(today())
  const thisMonth = paidDays.filter((d) => d.date >= mStart && d.date <= mEnd).reduce((s, d) => s + d.total, 0)
  const last = paidDays[0]
  const first = paidDays[paidDays.length - 1]

  // Last 12 months, oldest first.
  const months = Array.from({ length: 12 }, (_, i) => addMonths(today(), i - 11))
  const monthTotals = months.map((m) => {
    const [a, b] = monthRange(m)
    return { month: m, total: paidDays.filter((d) => d.date >= a && d.date <= b).reduce((s, d) => s + d.total, 0) }
  })
  const maxMonth = Math.max(1, ...monthTotals.map((m) => m.total))

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-5 max-w-[1200px] mx-auto">
      <a href={hrefFor({ page: 'savers', groupId: member.groupId })} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-4">
        <ArrowLeft size={16} /> {group?.name ?? 'Savers'}
      </a>

      {/* Header */}
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div className="h-16 w-16 rounded-2xl bg-emerald-600 text-white grid place-items-center text-2xl font-bold shrink-0">{initials(member.name)}</div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold leading-tight">{member.name}</h1>
          <p className="text-sm text-slate-500">
            CID <span className="font-mono text-slate-700">{member.cid || '—'}</span> · {group?.name}
            {first && <> · member since {formatDayDate(first.date)}</>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setEditOpen(true)}>
            <Pencil size={16} /> Edit
          </Button>
          <Button onClick={() => setMergeOpen(true)}>
            <GitMerge size={16} /> Merge
          </Button>
          <Button variant="danger-ghost" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={16} /> Delete
          </Button>
        </div>
      </div>

      {/* Likely duplicates */}
      {duplicates.length > 0 && (
        <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-center gap-2 font-semibold text-amber-900 mb-2">
            <Users size={18} /> This may be the same person as:
          </div>
          <ul className="space-y-2">
            {duplicates.slice(0, 5).map((d) => (
              <li key={d.member.id} className="flex flex-wrap items-center gap-2 text-sm">
                <a href={hrefFor({ page: 'member', id: d.member.id! })} className="font-semibold text-amber-900 underline">
                  {d.member.name}
                </a>
                <span className="font-mono text-amber-800">{d.member.cid || 'no CID'}</span>
                <span className="text-amber-700">({d.reason})</span>
                <Button size="sm" className="ml-auto" onClick={() => setMergeTarget(d.member)}>
                  <GitMerge size={14} /> Merge into this profile
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total saved" value={formatPeso(total)} accent="emerald" sub="all recorded days" />
        <StatCard label="This month" value={formatPeso(thisMonth)} accent="blue" />
        <StatCard label="Days paid" value={paidDays.length} accent="slate" sub={paidDays.length ? `avg ${formatPeso(total / paidDays.length)} per day` : undefined} />
        <StatCard label="Last payment" value={last ? formatPeso(last.total) : '—'} accent="amber" sub={last ? formatDayDate(last.date) : 'no payments yet'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] mb-6">
        <Calendar month={month} setMonth={setMonth} days={days} onOpen={(d) => openDay(member.groupId, d)} />

        {/* Monthly totals */}
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm p-4">
          <h2 className="font-semibold mb-3">Last 12 months</h2>
          <ul className="space-y-2">
            {monthTotals.map((m) => (
              <li key={m.month} className="grid grid-cols-[4.5rem_1fr_6.5rem] items-center gap-3 text-sm">
                <span className="text-slate-500">{fromISODate(m.month).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}</span>
                <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full bg-emerald-500" style={{ width: `${(m.total / maxMonth) * 100}%` }} />
                </div>
                <span className={cx('text-right tabular-nums', m.total ? 'font-semibold' : 'text-slate-300')}>{formatPeso(m.total)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* History */}
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <h2 className="px-4 py-3 border-b border-slate-100 font-semibold">Payment history</h2>
        {days.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-500">No payments recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 bg-slate-50">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-2 py-2 font-medium">Paid via</th>
                  <th className="px-2 py-2 font-medium">Ref #</th>
                  <th className="px-2 py-2 font-medium text-center">Status</th>
                  <th className="px-2 py-2 font-medium text-center">Sheet</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.date} className="border-t border-slate-50 hover:bg-slate-50 cursor-pointer" onClick={() => openDay(member.groupId, d.date)} title="Open this day">
                    <td className="px-4 py-2 font-medium whitespace-nowrap">{formatDayDate(d.date)}</td>
                    <td className="px-2 py-2">
                      <div className="flex gap-1">{d.payments.map((p) => <ChannelBadge key={p.id} channel={p.channel} />)}</div>
                    </td>
                    <td className="px-2 py-2 text-slate-500">{d.payments.map((p) => p.referenceNumber).filter(Boolean).join(', ') || '—'}</td>
                    <td className="px-2 py-2 text-center">{d.checked ? <Check size={16} className="inline text-emerald-600" /> : <span className="text-slate-300">—</span>}</td>
                    <td className="px-2 py-2 text-center">{d.photo ? <Camera size={16} className="inline text-slate-500" /> : <span className="text-slate-300">—</span>}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">{d.total ? formatPeso(d.total) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <MemberDialog open={editOpen} groupId={member.groupId} member={member} onClose={() => setEditOpen(false)} />
      <MergePicker
        open={mergeOpen}
        member={member}
        candidates={groupMembers ?? []}
        onClose={() => setMergeOpen(false)}
        onPick={(m) => {
          setMergeOpen(false)
          setMergeTarget(m)
        }}
      />
      <ConfirmDialog
        open={!!mergeTarget}
        title="Merge these profiles?"
        confirmLabel="Merge"
        message={
          mergeTarget && (
            <>
              <p>
                <b>{mergeTarget.name}</b> ({mergeTarget.cid || 'no CID'}) will be folded into <b>{member.name}</b> ({member.cid || 'no CID'}).
              </p>
              <p className="mt-2">Their payments and ticks move here and the duplicate profile is deleted. If both have a payment on the same day, the larger amount is kept.</p>
            </>
          )
        }
        onConfirm={async () => {
          if (!mergeTarget) return
          const r = await mergeMembers(mergeTarget.id!, member.id!)
          toast(`Merged: ${r.moved} payment${r.moved === 1 ? '' : 's'} moved`)
        }}
        onClose={() => setMergeTarget(null)}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${member.name}?`}
        message="This removes the member and every payment recorded for them."
        confirmLabel="Delete member"
        onConfirm={async () => {
          await deleteMember(member.id!)
          navigate({ page: 'savers', groupId: member.groupId })
        }}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  )
}

function Calendar({ month, setMonth, days, onOpen }: { month: string; setMonth: (m: string) => void; days: Day[]; onOpen: (date: string) => void }) {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const first = fromISODate(month)
  const offset = (first.getDay() + 6) % 7 // Monday first
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells = [...Array(offset).fill(null), ...Array.from({ length: count }, (_, i) => toISODate(new Date(first.getFullYear(), first.getMonth(), i + 1)))]
  const now = today()
  const monthTotal = cells.reduce((s, d) => s + (d ? byDate.get(d)?.total ?? 0 : 0), 0)

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm p-4">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="font-semibold flex-1">{first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h2>
        <span className="text-sm text-slate-500 tabular-nums mr-2">{formatPeso(monthTotal)}</span>
        <button className="p-1.5 rounded hover:bg-slate-100" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">
          <ChevronLeft size={18} />
        </button>
        <button className="p-1.5 rounded hover:bg-slate-100" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-400 mb-1">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} />
          const day = byDate.get(d)
          const paid = !!day?.total
          return (
            <button
              key={d}
              onClick={() => onOpen(d)}
              title={paid ? `${formatDayDate(d)}: ${formatPeso(day!.total)}` : formatDayDate(d)}
              className={cx(
                'aspect-square rounded-lg flex flex-col items-center justify-center text-xs border transition-colors',
                paid ? 'bg-emerald-50 border-emerald-200 hover:bg-emerald-100' : 'border-transparent hover:bg-slate-50',
                d === now && 'ring-2 ring-emerald-500',
              )}
            >
              <span className={cx('font-medium', paid ? 'text-emerald-800' : 'text-slate-400')}>{fromISODate(d).getDate()}</span>
              {paid && <span className="text-[10px] font-semibold text-emerald-700 tabular-nums">{day!.total >= 1000 ? `${(day!.total / 1000).toFixed(1)}k` : day!.total}</span>}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function MergePicker({
  open,
  member,
  candidates,
  onClose,
  onPick,
}: {
  open: boolean
  member: Member
  candidates: Member[]
  onClose: () => void
  onPick: (m: Member) => void
}) {
  const [q, setQ] = useState('')
  const list = candidates
    .filter((c) => c.id !== member.id)
    .map((c) => ({ c, sim: nameSimilarity(member.name, c.name) }))
    .filter(({ c }) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()) || c.cid.includes(q.trim()))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 30)
  return (
    <Modal open={open} onClose={onClose} title="Merge a duplicate into this profile">
      <p className="text-sm text-slate-600 mb-3">Pick the duplicate entry for {member.name}. Its records will move here. Most similar names are listed first.</p>
      <input autoFocus className={inputClass + ' mb-3'} placeholder="Search name or CID" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="max-h-80 overflow-y-auto divide-y divide-slate-100">
        {list.map(({ c }) => (
          <li key={c.id}>
            <button className="w-full flex items-center gap-3 px-2 py-2 text-left hover:bg-slate-50 rounded" onClick={() => onPick(c)}>
              <UserRound size={16} className="text-slate-400" />
              <span className="flex-1 font-medium text-sm">{c.name}</span>
              <span className="font-mono text-xs text-slate-500">{c.cid || 'no CID'}</span>
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="py-6 text-center text-sm text-slate-500">No other members in this group.</li>}
      </ul>
    </Modal>
  )
}
