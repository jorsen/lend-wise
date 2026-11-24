import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { BarChart3, ChevronLeft, ChevronRight, Download, Printer } from 'lucide-react'
import { db, type Member } from '../db'
import { sumByChannel } from '../lib/data'
import { addDays, addMonths, formatDayDate, formatPeso, formatRange, monthRange, today, weekRange } from '../lib/format'
import { downloadFile, toCSV } from '../lib/csv'
import { Button, StatCard, cx, selectClass } from '../components/ui'
import { MemberHistoryDialog } from '../components/dialogs'

type Period = 'week' | 'month' | 'custom'

export function ReportsPage() {
  const [groupId, setGroupId] = useState<number | 'all'>('all')
  const [period, setPeriod] = useState<Period>('week')
  const [anchor, setAnchor] = useState(today())
  const [custom, setCustom] = useState<[string, string]>(() => monthRange(today()))
  const [memberSort, setMemberSort] = useState<'total' | 'name' | 'days'>('total')
  const [history, setHistory] = useState<Member | null>(null)

  const [start, end] = period === 'week' ? weekRange(anchor) : period === 'month' ? monthRange(anchor) : custom
  const step = (dir: 1 | -1) => setAnchor(period === 'week' ? addDays(anchor, 7 * dir) : addMonths(anchor, dir))

  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), []) ?? []
  const members = useLiveQuery(() => db.members.toArray(), []) ?? []
  const payments =
    useLiveQuery(async () => {
      const all = await db.payments.where('date').between(start, end, true, true).toArray()
      return groupId === 'all' ? all : all.filter((p) => p.groupId === groupId)
    }, [start, end, groupId]) ?? []

  const groupName = useMemo(() => new Map(groups.map((g) => [g.id!, g.name])), [groups])
  const memberById = useMemo(() => new Map(members.map((m) => [m.id!, m])), [members])
  const totals = sumByChannel(payments)

  const daily = useMemo(() => {
    const days: { date: string; cash: number; client: number; agent: number; total: number; payers: number }[] = []
    const byDate = new Map<string, typeof payments>()
    for (const p of payments) byDate.set(p.date, [...(byDate.get(p.date) ?? []), p])
    // Show every day of a week; for longer ranges only days with entries.
    const spanDays = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000) + 1
    const dates = spanDays <= 7 ? Array.from({ length: spanDays }, (_, i) => addDays(start, i)) : [...byDate.keys()].sort()
    for (const d of dates) {
      const ps = byDate.get(d) ?? []
      days.push({ date: d, ...sumByChannel(ps), payers: new Set(ps.map((p) => p.memberId)).size })
    }
    return days
  }, [payments, start, end])
  const maxDay = Math.max(1, ...daily.map((d) => d.total))

  const perMember = useMemo(() => {
    const map = new Map<number, { member: Member; cash: number; client: number; agent: number; total: number; dates: Set<string> }>()
    for (const p of payments) {
      const m = memberById.get(p.memberId)
      if (!m) continue
      const r = map.get(m.id!) ?? { member: m, cash: 0, client: 0, agent: 0, total: 0, dates: new Set<string>() }
      r[p.channel] += p.amount
      r.total += p.amount
      r.dates.add(p.date)
      map.set(m.id!, r)
    }
    const list = [...map.values()]
    if (memberSort === 'total') list.sort((a, b) => b.total - a.total)
    if (memberSort === 'name') list.sort((a, b) => a.member.name.localeCompare(b.member.name))
    if (memberSort === 'days') list.sort((a, b) => b.dates.size - a.dates.size || b.total - a.total)
    return list
  }, [payments, memberById, memberSort])

  const activeMembers = groupId === 'all' ? members.length : members.filter((m) => m.groupId === groupId).length
  const scopeLabel = groupId === 'all' ? 'All groups' : groupName.get(groupId) ?? ''

  const exportCSV = () => {
    const rows = [
      ['CID', 'Member Name', 'Group', 'Days paid', 'Cash', 'Client Initiated', 'Agent Assisted', 'Total'],
      ...perMember.map((r) => [r.member.cid, r.member.name, groupName.get(r.member.groupId) ?? '', r.dates.size, r.cash, r.client, r.agent, r.total]),
      ['', 'TOTAL', '', '', totals.cash, totals.client, totals.agent, totals.total],
    ]
    downloadFile(`report_${scopeLabel.replace(/\s+/g, '-')}_${start}_to_${end}.csv`, toCSV(rows))
  }

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-5 max-w-[1400px] mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-blue-100 text-blue-700 grid place-items-center print:hidden">
            <BarChart3 size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Reports</h1>
            <p className="text-sm text-slate-500">
              {scopeLabel} · {formatRange(start, end)}
            </p>
          </div>
        </div>
        <div className="flex gap-2 print:hidden">
          <Button onClick={() => window.print()}>
            <Printer size={16} /> <span className="hidden sm:inline">Print</span>
          </Button>
          <Button onClick={exportCSV} disabled={!perMember.length}>
            <Download size={16} /> <span className="hidden sm:inline">Export</span>
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-5 print:hidden">
        <select className={selectClass} value={groupId} onChange={(e) => setGroupId(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
          <option value="all">All groups</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id!}>
              {g.name}
            </option>
          ))}
        </select>
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
          {(['week', 'month', 'custom'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cx('px-3 h-9 rounded-md text-sm font-medium capitalize', period === p ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50')}
            >
              {p}
            </button>
          ))}
        </div>
        {period !== 'custom' ? (
          <div className="flex items-center gap-1">
            <Button size="icon" onClick={() => step(-1)} aria-label="Previous period">
              <ChevronLeft size={18} />
            </Button>
            <span className="px-2 text-sm font-semibold min-w-[11rem] text-center">{formatRange(start, end)}</span>
            <Button size="icon" onClick={() => step(1)} aria-label="Next period">
              <ChevronRight size={18} />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input type="date" className={selectClass} value={custom[0]} onChange={(e) => e.target.value && setCustom([e.target.value, custom[1]])} />
            <span className="text-slate-400">to</span>
            <input type="date" className={selectClass} value={custom[1]} onChange={(e) => e.target.value && setCustom([custom[0], e.target.value])} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total collected" value={formatPeso(totals.total)} accent="slate" sub={`${perMember.length} of ${activeMembers} members paid`} />
        <StatCard label="Cash" value={formatPeso(totals.cash)} accent="blue" />
        <StatCard label="Client initiated" value={formatPeso(totals.client)} accent="emerald" />
        <StatCard label="Agent assisted" value={formatPeso(totals.agent)} accent="amber" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* Daily */}
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden print-plain">
          <h2 className="px-4 py-3 border-b border-slate-100 font-semibold">By day</h2>
          {daily.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-500">No payments in this period.</p>
          ) : (
            <ul className="divide-y divide-slate-50">
              {daily.map((d) => (
                <li key={d.date} className="px-4 py-2.5">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className={cx('font-medium', d.total ? 'text-slate-800' : 'text-slate-400')}>{formatDayDate(d.date)}</span>
                    <span className={cx('tabular-nums font-semibold', !d.total && 'text-slate-300')}>{formatPeso(d.total)}</span>
                  </div>
                  <div className="mt-1.5 flex h-2 rounded-full bg-slate-100 overflow-hidden" title={`Cash ${formatPeso(d.cash)} · Client ${formatPeso(d.client)} · Agent ${formatPeso(d.agent)}`}>
                    <div className="bg-blue-500" style={{ width: `${(d.cash / maxDay) * 100}%` }} />
                    <div className="bg-emerald-500" style={{ width: `${(d.client / maxDay) * 100}%` }} />
                    <div className="bg-amber-500" style={{ width: `${(d.agent / maxDay) * 100}%` }} />
                  </div>
                  {d.total > 0 && <div className="mt-1 text-xs text-slate-500">{d.payers} paid</div>}
                </li>
              ))}
            </ul>
          )}
          <div className="px-4 py-2.5 border-t border-slate-100 flex gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-blue-500" /> Cash</span>
            <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-emerald-500" /> Client</span>
            <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-amber-500" /> Agent</span>
          </div>
        </section>

        {/* Per member */}
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden print-plain">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2">
            <h2 className="font-semibold">By member</h2>
            <select className="h-8 rounded-md border border-slate-200 px-2 text-sm print:hidden" value={memberSort} onChange={(e) => setMemberSort(e.target.value as typeof memberSort)}>
              <option value="total">Highest total</option>
              <option value="days">Most days paid</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
          {perMember.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-500">No payments in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500 bg-slate-50">
                    <th className="px-4 py-2 font-semibold">Member</th>
                    {groupId === 'all' && <th className="px-2 py-2 font-semibold">Group</th>}
                    <th className="px-2 py-2 font-semibold text-right">Days</th>
                    <th className="px-2 py-2 font-semibold text-right hidden sm:table-cell">Cash</th>
                    <th className="px-2 py-2 font-semibold text-right hidden sm:table-cell">Client</th>
                    <th className="px-2 py-2 font-semibold text-right hidden sm:table-cell">Agent</th>
                    <th className="px-4 py-2 font-semibold text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {perMember.map((r) => (
                    <tr key={r.member.id} className="border-t border-slate-50 hover:bg-slate-50 cursor-pointer" onClick={() => setHistory(r.member)}>
                      <td className="px-4 py-2">
                        <div className="font-medium text-slate-800">{r.member.name}</div>
                        <div className="font-mono text-xs text-slate-500">{r.member.cid}</div>
                      </td>
                      {groupId === 'all' && <td className="px-2 py-2 text-slate-600 whitespace-nowrap">{groupName.get(r.member.groupId)}</td>}
                      <td className="px-2 py-2 text-right tabular-nums">{r.dates.size}</td>
                      <td className="px-2 py-2 text-right tabular-nums hidden sm:table-cell">{r.cash ? formatPeso(r.cash) : '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums hidden sm:table-cell">{r.client ? formatPeso(r.client) : '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums hidden sm:table-cell">{r.agent ? formatPeso(r.agent) : '—'}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-semibold">{formatPeso(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <MemberHistoryDialog member={history} onClose={() => setHistory(null)} />
    </div>
  )
}
