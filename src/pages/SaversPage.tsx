import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ArrowDownUp,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Check,
  PiggyBank,
  Pencil,
  Plus,
  Printer,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import { db, type Channel, type Group, type Member } from '../db'
import { clearDay, deleteGroup, deleteMember, sumByChannel } from '../lib/data'
import { addDays, formatLongDate, formatPeso, formatRange, fromISODate, today, weekRange } from '../lib/format'
import { downloadFile, toCSV } from '../lib/csv'
import { navigate } from '../lib/router'
import { Button, ConfirmDialog, StatCard, cx, inputClass, selectClass, useToast } from '../components/ui'
import { GroupDialog, MemberDialog, MemberHistoryDialog } from '../components/dialogs'
import UploadMembersDialog from '../components/UploadMembersDialog'
import { AmountCell } from '../components/AmountCell'
import { WeekGrid, type DayAmounts, type WeekRow } from './WeekGrid'

type Sort = 'sheet' | 'name' | 'cid' | 'unpaid' | 'amount'
type Row = { member: Member; cash: number; client: number; agent: number; total: number; ref: string }

type Mode = 'day' | 'week'

const DATE_KEY = 'lendwise:date'
const MODE_KEY = 'lendwise:mode'
const COLS: Channel[] = ['cash', 'client', 'agent']
const COL_LABEL: Record<Channel, string> = { cash: 'Cash', client: 'Client', agent: 'Agent' }

function loadSession(key: string, fallback: string) {
  try {
    return sessionStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}

function saveSession(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

export function SaversPage({ group }: { group: Group }) {
  const groupId = group.id!
  const toast = useToast()
  const [date, setDateState] = useState(() => loadSession(DATE_KEY, today()))
  const [mode, setModeState] = useState<Mode>(() => (loadSession(MODE_KEY, 'day') === 'week' ? 'week' : 'day'))
  const [weekChannel, setWeekChannel] = useState<Channel>('cash')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('sheet')
  const [memberDialog, setMemberDialog] = useState<{ open: boolean; member: Member | null }>({ open: false, member: null })
  const [history, setHistory] = useState<Member | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [confirm, setConfirm] = useState<null | { title: string; message: React.ReactNode; label: string; run: () => Promise<unknown> }>(null)
  const tableRef = useRef<HTMLDivElement>(null)

  const setDate = (d: string) => {
    setDateState(d)
    saveSession(DATE_KEY, d)
  }
  const setMode = (m: Mode) => {
    setModeState(m)
    saveSession(MODE_KEY, m)
  }

  const [weekStart, weekEnd] = weekRange(date)
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])
  const members = useLiveQuery(() => db.members.where('groupId').equals(groupId).sortBy('order'), [groupId])
  const dayPayments = useLiveQuery(() => db.payments.where('[groupId+date]').equals([groupId, date]).toArray(), [groupId, date])
  const weekPayments = useLiveQuery(
    () => db.payments.where('[groupId+date]').between([groupId, weekStart], [groupId, weekEnd], true, true).toArray(),
    [groupId, weekStart, weekEnd],
  )
  const weekTotals = sumByChannel(weekPayments ?? [])

  // Week view: per member, per day amounts by channel.
  const { weekByMember, dayTotals } = useMemo(() => {
    const byMember = new Map<number, WeekRow>()
    const totals: Record<string, DayAmounts> = {}
    for (const m of members ?? []) byMember.set(m.id!, { member: m, days: {}, total: 0 })
    for (const p of weekPayments ?? []) {
      const r = byMember.get(p.memberId)
      if (!r) continue
      const cell = (r.days[p.date] ??= { cash: 0, client: 0, agent: 0, total: 0 })
      cell[p.channel] += p.amount
      cell.total += p.amount
      r.total += p.amount
      const t = (totals[p.date] ??= { cash: 0, client: 0, agent: 0, total: 0 })
      t[p.channel] += p.amount
      t.total += p.amount
    }
    return { weekByMember: byMember, dayTotals: totals }
  }, [members, weekPayments])

  const rows: Row[] = useMemo(() => {
    const byMember = new Map<number, Row>()
    for (const m of members ?? []) byMember.set(m.id!, { member: m, cash: 0, client: 0, agent: 0, total: 0, ref: '' })
    for (const p of dayPayments ?? []) {
      const r = byMember.get(p.memberId)
      if (!r) continue
      r[p.channel] += p.amount
      r.total += p.amount
      if (p.referenceNumber) r.ref = p.referenceNumber
    }
    return [...byMember.values()]
  }, [members, dayPayments])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? rows.filter((r) => r.member.name.toLowerCase().includes(q) || r.member.cid.includes(q)) : [...rows]
    // "Unpaid" and "Highest amount" use the day total in day mode and the week total in week mode.
    const amt = (r: Row) => (mode === 'week' ? weekByMember.get(r.member.id!)?.total ?? 0 : r.total)
    const byName = (a: Row, b: Row) => a.member.name.localeCompare(b.member.name)
    if (sort === 'name') list.sort(byName)
    if (sort === 'cid') list.sort((a, b) => a.member.cid.localeCompare(b.member.cid, undefined, { numeric: true }))
    if (sort === 'unpaid') list.sort((a, b) => Number(amt(a) > 0) - Number(amt(b) > 0))
    if (sort === 'amount') list.sort((a, b) => amt(b) - amt(a) || byName(a, b))
    return list
  }, [rows, query, sort, mode, weekByMember])

  const weekRows = useMemo(() => visible.map((r) => weekByMember.get(r.member.id!)!).filter(Boolean), [visible, weekByMember])

  const memberCount = members?.length ?? 0
  const totals = mode === 'week' ? weekTotals : sumByChannel(dayPayments ?? [])
  const paidCount = mode === 'week' ? [...weekByMember.values()].filter((r) => r.total > 0).length : rows.filter((r) => r.total > 0).length
  const thisWeek = weekRange(today())[0] === weekStart

  // Keyboard navigation between amount cells: Enter/↓ = next row, Shift+Enter/↑ = previous row.
  const focusCell = (row: number, col: number) => {
    const el = tableRef.current?.querySelector<HTMLInputElement>(`[data-cell="${row}-${col}"]`)
    if (el) {
      el.focus()
      el.select()
      return true
    }
    return false
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if (e.key === '/') {
        e.preventDefault()
        document.getElementById('savers-search')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const exportCSV = () => {
    if (mode === 'week') {
      const dayHeads = weekDays.map((d) => fromISODate(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))
      const data = [
        ['No', 'CID', 'Member Name', ...dayHeads, 'Cash', 'Client Initiated', 'Agent Assisted', 'Week Total'],
        ...weekRows.map((r, i) => {
          const ch = { cash: 0, client: 0, agent: 0 }
          for (const d of weekDays) for (const c of COLS) ch[c] += r.days[d]?.[c] ?? 0
          return [i + 1, r.member.cid, r.member.name, ...weekDays.map((d) => r.days[d]?.total || ''), ch.cash || '', ch.client || '', ch.agent || '', r.total || '']
        }),
        ['', '', 'TOTAL', ...weekDays.map((d) => dayTotals[d]?.total ?? 0), weekTotals.cash, weekTotals.client, weekTotals.agent, weekTotals.total],
      ]
      downloadFile(`${group.name.replace(/\s+/g, '-')}_week_${weekStart}.csv`, toCSV(data))
      return
    }
    const data = [
      ['No', 'CID', 'Member Name', 'Amount', 'Status', 'Channel', 'Reference #', 'Date'],
      ...visible.map((r, i) => [
        i + 1,
        r.member.cid,
        r.member.name,
        r.total || '',
        r.total > 0 ? 'Paid' : 'Unpaid',
        COLS.filter((c) => r[c] > 0).map((c) => COL_LABEL[c]).join(' + '),
        r.ref,
        date,
      ]),
      ['', '', 'TOTAL', totals.total, '', `Cash ${totals.cash} / Client ${totals.client} / Agent ${totals.agent}`, '', ''],
    ]
    downloadFile(`${group.name.replace(/\s+/g, '-')}_${date}.csv`, toCSV(data))
  }

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-5 pb-28 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-11 w-11 rounded-xl bg-emerald-100 text-emerald-700 grid place-items-center shrink-0 print:hidden">
            <PiggyBank size={22} />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold leading-tight truncate">{group.name}</h1>
            <p className="text-sm text-slate-500">
              Savers · {memberCount} member{memberCount === 1 ? '' : 's'}
              <span className="hidden print:inline"> · {mode === 'week' ? `Week of ${formatRange(weekStart, weekEnd)}` : formatLongDate(date)}</span>
            </p>
          </div>
        </div>
        <div className="flex gap-1 print:hidden">
          <Button variant="ghost" size="sm" onClick={() => setRenameOpen(true)}>
            <Pencil size={15} /> Rename
          </Button>
          <Button
            variant="danger-ghost"
            size="sm"
            onClick={() =>
              setConfirm({
                title: `Delete ${group.name}?`,
                message: `This permanently deletes the group, its ${memberCount} members and all of their payment records. Download a backup first if you might need them.`,
                label: 'Delete group',
                run: async () => {
                  await deleteGroup(groupId)
                  navigate({ page: 'savers', groupId: null })
                },
              })
            }
          >
            <Trash2 size={15} /> Delete group
          </Button>
        </div>
      </div>

      {/* Date bar */}
      <div className="flex flex-wrap items-center gap-2 mb-5 print:hidden">
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
          {(['day', 'week'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cx('px-3 h-9 rounded-md text-sm font-medium capitalize', mode === m ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50')}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="flex items-center rounded-lg border border-slate-200 bg-white shadow-sm">
          <button
            className="h-10 w-10 grid place-items-center hover:bg-slate-50 rounded-l-lg"
            onClick={() => setDate(addDays(date, mode === 'week' ? -7 : -1))}
            aria-label={mode === 'week' ? 'Previous week' : 'Previous day'}
          >
            <ChevronLeft size={18} />
          </button>
          <label className="relative h-10 flex items-center gap-2 px-3 border-x border-slate-200 cursor-pointer hover:bg-slate-50">
            <CalendarDays size={16} className="text-slate-500" />
            <span className="text-sm font-semibold whitespace-nowrap">{mode === 'week' ? formatRange(weekStart, weekEnd) : formatLongDate(date)}</span>
            <input
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer"
              aria-label={mode === 'week' ? 'Pick any day in the week' : 'Pick date'}
            />
          </label>
          <button
            className="h-10 w-10 grid place-items-center hover:bg-slate-50 rounded-r-lg"
            onClick={() => setDate(addDays(date, mode === 'week' ? 7 : 1))}
            aria-label={mode === 'week' ? 'Next week' : 'Next day'}
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <Button onClick={() => setDate(today())} disabled={mode === 'week' ? thisWeek : date === today()}>
          {mode === 'week' ? 'This week' : 'Today'}
        </Button>
        {mode === 'day' && (
          <button onClick={() => setMode('week')} className="ml-auto text-sm text-slate-500 hover:text-slate-800" title="Open week view">
            Week {formatRange(weekStart, weekEnd)}: <span className="font-semibold text-slate-800 tabular-nums">{formatPeso(weekTotals.total)}</span>
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard
          label={mode === 'week' ? 'Week total' : 'Total collected'}
          value={formatPeso(totals.total)}
          accent="slate"
          sub={`${paidCount} of ${memberCount} paid${mode === 'week' ? ' this week' : ''}`}
        />
        <StatCard label="Cash" value={formatPeso(totals.cash)} accent="blue" />
        <StatCard label="Client initiated" value={formatPeso(totals.client)} accent="emerald" />
        <StatCard label="Agent assisted" value={formatPeso(totals.agent)} accent="amber" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-3 print:hidden">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            id="savers-search"
            className={inputClass + ' pl-9'}
            placeholder="Search name or CID   ( / )"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="relative">
          <ArrowDownUp size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <select className={selectClass + ' pl-8 pr-8'} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
            <option value="sheet">Sheet order</option>
            <option value="name">Name A–Z</option>
            <option value="cid">CID</option>
            <option value="unpaid">Unpaid first</option>
            <option value="amount">Highest amount</option>
          </select>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button onClick={() => window.print()} title="Print">
            <Printer size={16} />
            <span className="hidden sm:inline">Print</span>
          </Button>
          <Button onClick={exportCSV} title="Export CSV">
            <Download size={16} />
            <span className="hidden sm:inline">Export</span>
          </Button>
          <Button onClick={() => setUploadOpen(true)} title="Upload sheet">
            <Upload size={16} />
            <span className="hidden sm:inline">Upload</span>
          </Button>
          <Button variant="primary" onClick={() => setMemberDialog({ open: true, member: null })}>
            <Plus size={16} /> Add member
          </Button>
        </div>
      </div>

      {/* Sheet */}
      {mode === 'week' && visible.length > 0 ? (
        <WeekGrid
          rows={weekRows}
          days={weekDays}
          dayTotals={dayTotals}
          weekTotal={weekTotals.total}
          channel={weekChannel}
          onChannel={setWeekChannel}
          containerRef={tableRef}
          focusCell={focusCell}
          onHistory={setHistory}
          onPickDay={(d) => {
            setDate(d)
            setMode('day')
          }}
        />
      ) : (
      <div ref={tableRef} className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden print-plain">
        <div className={cx('hidden md:grid gap-3 items-center px-4 py-2 border-b border-slate-200 text-sm font-medium text-slate-600', SHEET_COLS)}>
          <div>No</div>
          <div>Member Name</div>
          <div>CID</div>
          <div className="text-center">Amount</div>
          <div className="text-center">Status</div>
          <div className="text-center print:hidden">Action</div>
        </div>

        {members && memberCount === 0 && (
          <div className="px-6 py-14 text-center">
            <p className="text-slate-600 mb-1 font-medium">No members in {group.name} yet</p>
            <p className="text-sm text-slate-500 mb-5">Upload a photo or spreadsheet of the paper sheet, or add members one at a time.</p>
            <div className="flex justify-center gap-2">
              <Button onClick={() => setUploadOpen(true)}>
                <Upload size={16} /> Upload sheet
              </Button>
              <Button variant="primary" onClick={() => setMemberDialog({ open: true, member: null })}>
                <Plus size={16} /> Add member
              </Button>
            </div>
          </div>
        )}
        {memberCount > 0 && visible.length === 0 && <div className="px-6 py-10 text-center text-sm text-slate-500">No members match “{query}”.</div>}

        {visible.map((r, i) => (
          <SheetRow
            key={r.member.id}
            index={i}
            row={r}
            date={date}
            focusCell={focusCell}
            onHistory={() => setHistory(r.member)}
            onEdit={() => setMemberDialog({ open: true, member: r.member })}
            onDelete={() =>
              setConfirm({
                title: `Remove ${r.member.name}?`,
                message: 'This removes the member and every payment recorded for them.',
                label: 'Remove member',
                run: () => deleteMember(r.member.id!),
              })
            }
          />
        ))}
      </div>
      )}

      {/* Sticky totals bar */}
      {memberCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 lg:left-64 z-10 border-t border-slate-200 bg-white/95 backdrop-blur px-4 sm:px-6 lg:px-8 py-3 print:static print:border-0 print:mt-4 print:px-0">
          <div className="max-w-[1400px] mx-auto flex flex-wrap items-center gap-x-6 gap-y-1">
            <div className="text-sm text-slate-600">
              <span className="font-semibold text-slate-900">{paidCount}</span> of {memberCount} paid{mode === 'week' ? ' this week' : ''}
              <div className="mt-1 h-1.5 w-32 rounded-full bg-slate-100 overflow-hidden print:hidden">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${memberCount ? (paidCount / memberCount) * 100 : 0}%` }} />
              </div>
            </div>
            <div className="hidden sm:flex gap-5 text-sm tabular-nums">
              <span className="text-blue-700">Cash {formatPeso(totals.cash)}</span>
              <span className="text-emerald-700">Client {formatPeso(totals.client)}</span>
              <span className="text-amber-700">Agent {formatPeso(totals.agent)}</span>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-lg font-bold tabular-nums">{formatPeso(totals.total)}</span>
              {mode === 'day' && (dayPayments?.length ?? 0) > 0 && (
                <Button
                  size="sm"
                  variant="danger-ghost"
                  className="print:hidden"
                  onClick={() =>
                    setConfirm({
                      title: 'Clear this day?',
                      message: `Deletes all ${dayPayments!.length} payment entries for ${group.name} on ${formatLongDate(date)}. Members are kept.`,
                      label: 'Clear day',
                      run: () => clearDay(groupId, date),
                    })
                  }
                >
                  <Trash2 size={14} /> Clear day
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <MemberDialog open={memberDialog.open} groupId={groupId} member={memberDialog.member} onClose={() => setMemberDialog({ open: false, member: null })} />
      <MemberHistoryDialog member={history} onClose={() => setHistory(null)} />
      <GroupDialog open={renameOpen} group={group} onClose={() => setRenameOpen(false)} />
      <UploadMembersDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        groupId={groupId}
        date={date}
        onImported={(res) => toast(`Imported: ${res.added} new, ${res.updated} updated, ${res.payments} payments`)}
      />
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ''}
        message={confirm?.message}
        confirmLabel={confirm?.label}
        onConfirm={async () => {
          await confirm?.run()
        }}
        onClose={() => setConfirm(null)}
      />
    </div>
  )
}

const SHEET_COLS = 'md:grid-cols-[3rem_minmax(14rem,1fr)_10rem_8rem_5rem_5rem]'

function SheetRow({
  index,
  row,
  date,
  focusCell,
  onHistory,
  onEdit,
  onDelete,
}: {
  index: number
  row: Row
  date: string
  focusCell: (row: number, col: number) => boolean
  onHistory: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { member } = row
  const paid = row.total > 0
  const paidChannels = COLS.filter((c) => row[c] > 0)
  // Amounts typed on this sheet are recorded as cash. A member already paid through one
  // other channel (e.g. from an upload or the Week view) keeps editing that channel.
  const channel: Channel = paidChannels.length === 1 ? paidChannels[0] : 'cash'
  const mixed = paidChannels.length > 1

  return (
    <div
      className={cx(
        'border-b border-slate-100 last:border-b-0 px-4 py-2.5 md:py-1 transition-colors',
        'grid grid-cols-[2rem_1fr_auto_auto] gap-x-3 gap-y-1 items-center',
        SHEET_COLS,
        paid ? 'bg-emerald-50/40' : 'hover:bg-slate-50/60',
      )}
    >
      {/* No */}
      <div className="text-sm text-slate-700 tabular-nums md:row-auto row-span-2 md:row-span-1 self-start md:self-center pt-0.5 md:pt-0">{index + 1}</div>

      {/* Member Name (CID under it on mobile) */}
      <button onClick={onHistory} className="text-left min-w-0 group" title="Payment history">
        <div className="text-sm font-semibold text-slate-900 truncate group-hover:text-emerald-700 group-hover:underline">{member.name}</div>
        <div className="md:hidden font-mono text-xs text-slate-500">{member.cid}</div>
      </button>

      {/* CID */}
      <div className="hidden md:block font-mono text-sm text-slate-500">{member.cid}</div>

      {/* Amount */}
      <div className="w-28 md:w-full">
        {mixed ? (
          <div
            className="h-9 flex items-center justify-center rounded-md border border-slate-200 bg-slate-50 px-2 text-sm font-semibold tabular-nums"
            title={paidChannels.map((c) => `${COL_LABEL[c]} ${formatPeso(row[c])}`).join(' + ')}
          >
            {row.total}
          </div>
        ) : (
          <AmountCell
            member={member}
            date={date}
            channel={channel}
            value={row[channel]}
            rowIndex={index}
            colIndex={0}
            focusCell={focusCell}
            label={`Amount for ${member.name}`}
            align="center"
          />
        )}
      </div>

      {/* Status: ticks itself when an amount is saved */}
      <div className="flex justify-center">
        <span
          role="checkbox"
          aria-checked={paid}
          aria-label={paid ? 'Paid' : 'Not paid'}
          title={paid ? 'Paid' : 'Not paid'}
          className={cx(
            'h-5 w-5 rounded-[5px] border-2 grid place-items-center transition-colors',
            paid ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-700 bg-white',
          )}
        >
          {paid && <Check size={14} strokeWidth={3} />}
        </span>
      </div>

      {/* Action */}
      <div className="col-start-2 col-span-3 md:col-auto flex justify-end md:justify-center gap-1 print:hidden">
        <button onClick={onEdit} className="p-1.5 rounded-md text-slate-800 hover:bg-slate-100" title="Edit member" aria-label="Edit member">
          <Pencil size={17} />
        </button>
        <button onClick={onDelete} className="p-1.5 rounded-md text-red-500 hover:bg-red-50" title="Remove member" aria-label="Remove member">
          <Trash2 size={17} />
        </button>
      </div>
    </div>
  )
}
