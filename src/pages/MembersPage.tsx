import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowDownUp, ChevronRight, Download, Plus, Search, TriangleAlert, Users } from 'lucide-react'
import { db, type Member } from '../db'
import { formatDayDate, formatPeso } from '../lib/format'
import { findLikelyDuplicates, initials } from '../lib/match'
import { downloadFile, toCSV } from '../lib/csv'
import { hrefFor } from '../lib/router'
import { Button, StatCard, cx, inputClass, selectClass } from '../components/ui'
import { MemberDialog } from '../components/dialogs'

type Sort = 'name' | 'cid' | 'total' | 'last' | 'days'
type Row = { member: Member; groupName: string; total: number; days: number; last: string | null; dupes: number }

const GROUP_KEY = 'lendwise:membersGroup'

export function MembersPage() {
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), []) ?? []
  const members = useLiveQuery(() => db.members.toArray(), [])
  const payments = useLiveQuery(() => db.payments.toArray(), []) ?? []

  const [groupId, setGroupIdState] = useState<number | 'all'>(() => {
    try {
      const v = sessionStorage.getItem(GROUP_KEY)
      return v && v !== 'all' ? Number(v) : 'all'
    } catch {
      return 'all'
    }
  })
  const setGroupId = (v: number | 'all') => {
    setGroupIdState(v)
    try {
      sessionStorage.setItem(GROUP_KEY, String(v))
    } catch {
      /* ignore */
    }
  }
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('name')
  const [onlyDupes, setOnlyDupes] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const rows: Row[] = useMemo(() => {
    const groupName = new Map(groups.map((g) => [g.id!, g.name]))
    const stats = new Map<number, { total: number; dates: Set<string>; last: string | null }>()
    for (const p of payments) {
      const s = stats.get(p.memberId) ?? { total: 0, dates: new Set<string>(), last: null }
      s.total += p.amount
      s.dates.add(p.date)
      if (!s.last || p.date > s.last) s.last = p.date
      stats.set(p.memberId, s)
    }
    const byGroup = new Map<number, Member[]>()
    for (const m of members ?? []) byGroup.set(m.groupId, [...(byGroup.get(m.groupId) ?? []), m])
    return (members ?? []).map((m) => {
      const s = stats.get(m.id!)
      return {
        member: m,
        groupName: groupName.get(m.groupId) ?? '',
        total: s?.total ?? 0,
        days: s?.dates.size ?? 0,
        last: s?.last ?? null,
        dupes: findLikelyDuplicates(m, byGroup.get(m.groupId) ?? []).length,
      }
    })
  }, [members, payments, groups])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = rows.filter((r) => groupId === 'all' || r.member.groupId === groupId)
    if (q) list = list.filter((r) => r.member.name.toLowerCase().includes(q) || r.member.cid.includes(q))
    if (onlyDupes) list = list.filter((r) => r.dupes > 0)
    const byName = (a: Row, b: Row) => a.member.name.localeCompare(b.member.name)
    if (sort === 'name') list.sort(byName)
    if (sort === 'cid') list.sort((a, b) => a.member.cid.localeCompare(b.member.cid, undefined, { numeric: true }))
    if (sort === 'total') list.sort((a, b) => b.total - a.total || byName(a, b))
    if (sort === 'days') list.sort((a, b) => b.days - a.days || byName(a, b))
    if (sort === 'last') list.sort((a, b) => (b.last ?? '').localeCompare(a.last ?? '') || byName(a, b))
    return list
  }, [rows, groupId, query, sort, onlyDupes])

  const scoped = rows.filter((r) => groupId === 'all' || r.member.groupId === groupId)
  const dupeCount = scoped.filter((r) => r.dupes > 0).length
  const activeCount = scoped.filter((r) => r.days > 0).length

  const exportCSV = () => {
    const data = [
      ['No', 'Member Name', 'CID', 'Group', 'Days paid', 'Total saved', 'Last payment'],
      ...visible.map((r, i) => [i + 1, r.member.name, r.member.cid, r.groupName, r.days, r.total, r.last ?? '']),
    ]
    const label = groupId === 'all' ? 'all-groups' : (groups.find((g) => g.id === groupId)?.name ?? 'group').replace(/\s+/g, '-')
    downloadFile(`members_${label}.csv`, toCSV(data))
  }

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-5 max-w-[1200px] mx-auto">
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="h-11 w-11 rounded-xl bg-violet-100 text-violet-700 grid place-items-center print:hidden">
          <Users size={22} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold leading-tight">Members</h1>
          <p className="text-sm text-slate-500">Everyone in your savers groups. Click a name to open their profile.</p>
        </div>
        <div className="flex gap-2 print:hidden">
          <Button onClick={exportCSV} disabled={!visible.length}>
            <Download size={16} /> <span className="hidden sm:inline">Export</span>
          </Button>
          <Button variant="primary" onClick={() => setAddOpen(true)} disabled={!groups.length}>
            <Plus size={16} /> Add member
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard label="Members" value={scoped.length} accent="slate" sub={groupId === 'all' ? `in ${groups.length} groups` : undefined} />
        <StatCard label="Have paid" value={activeCount} accent="emerald" sub="at least one payment" />
        <StatCard label="Never paid" value={scoped.length - activeCount} accent="blue" />
        <StatCard label="Possible duplicates" value={dupeCount} accent="amber" sub={dupeCount ? 'review and merge' : 'none found'} />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3 print:hidden">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className={inputClass + ' pl-9'} placeholder="Search name or CID" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className={selectClass} value={groupId} onChange={(e) => setGroupId(e.target.value === 'all' ? 'all' : Number(e.target.value))} aria-label="Group">
          <option value="all">All groups</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id!}>
              {g.name}
            </option>
          ))}
        </select>
        <div className="relative">
          <ArrowDownUp size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <select className={selectClass + ' pl-8'} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
            <option value="name">Name A–Z</option>
            <option value="cid">CID</option>
            <option value="total">Highest total</option>
            <option value="days">Most days paid</option>
            <option value="last">Recently paid</option>
          </select>
        </div>
        {dupeCount > 0 && (
          <button
            onClick={() => setOnlyDupes(!onlyDupes)}
            className={cx(
              'h-10 px-3 rounded-lg border text-sm font-medium inline-flex items-center gap-1.5',
              onlyDupes ? 'bg-amber-500 border-amber-500 text-white' : 'bg-white border-amber-300 text-amber-700 hover:bg-amber-50',
            )}
          >
            <TriangleAlert size={15} /> Duplicates only
          </button>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="hidden md:grid grid-cols-[3rem_minmax(14rem,1fr)_8rem_8rem_5rem_8rem_9rem_1.5rem] gap-3 px-4 py-2 border-b border-slate-200 text-sm font-medium text-slate-600">
          <div>No</div>
          <div>Member Name</div>
          <div>CID</div>
          <div>Group</div>
          <div className="text-right">Days</div>
          <div className="text-right">Total saved</div>
          <div>Last payment</div>
          <div />
        </div>

        {members && visible.length === 0 && (
          <p className="px-6 py-12 text-center text-sm text-slate-500">
            {rows.length === 0 ? 'No members yet. Add one, or upload a sheet from a group page.' : 'No members match your search.'}
          </p>
        )}

        {visible.map((r, i) => (
          <a
            key={r.member.id}
            href={hrefFor({ page: 'member', id: r.member.id! })}
            className="grid grid-cols-[2.5rem_1fr_auto] md:grid-cols-[3rem_minmax(14rem,1fr)_8rem_8rem_5rem_8rem_9rem_1.5rem] gap-x-3 items-center px-4 py-2.5 border-b border-slate-100 last:border-b-0 hover:bg-slate-50"
          >
            <div className="hidden md:block text-sm text-slate-500 tabular-nums">{i + 1}</div>
            <div className="md:hidden h-9 w-9 rounded-full bg-emerald-600 text-white grid place-items-center text-xs font-bold">{initials(r.member.name)}</div>
            <div className="min-w-0 flex items-center gap-3">
              <span className="hidden md:grid h-8 w-8 shrink-0 rounded-full bg-emerald-600 text-white place-items-center text-xs font-bold">{initials(r.member.name)}</span>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 truncate flex items-center gap-1.5">
                  {r.member.name}
                  {r.dupes > 0 && (
                    <span title="May be a duplicate: open the profile to review" className="text-amber-500">
                      <TriangleAlert size={14} />
                    </span>
                  )}
                </div>
                <div className="md:hidden text-xs text-slate-500">
                  <span className="font-mono">{r.member.cid || 'no CID'}</span> · {r.groupName} · {r.days} day{r.days === 1 ? '' : 's'} · {formatPeso(r.total)}
                </div>
              </div>
            </div>
            <div className="hidden md:block font-mono text-sm text-slate-500">{r.member.cid || '—'}</div>
            <div className="hidden md:block text-sm text-slate-600 truncate">{r.groupName}</div>
            <div className="hidden md:block text-sm text-right tabular-nums">{r.days}</div>
            <div className={cx('hidden md:block text-sm text-right tabular-nums font-semibold', !r.total && 'text-slate-300')}>{formatPeso(r.total)}</div>
            <div className="hidden md:block text-sm text-slate-500">{r.last ? formatDayDate(r.last) : '—'}</div>
            <ChevronRight size={16} className="text-slate-300 justify-self-end" />
          </a>
        ))}
      </div>

      <MemberDialog open={addOpen} groupId={groupId === 'all' ? groups[0]?.id ?? 0 : groupId} onClose={() => setAddOpen(false)} />
    </div>
  )
}
