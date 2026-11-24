import type { RefObject } from 'react'
import type { Channel, Member } from '../db'
import { AmountCell } from '../components/AmountCell'
import { cx } from '../components/ui'
import { formatPeso, fromISODate, today } from '../lib/format'

export type DayAmounts = { cash: number; client: number; agent: number; total: number }
export type WeekRow = { member: Member; days: Record<string, DayAmounts>; total: number }

const CHANNEL_TABS: { value: Channel; label: string; on: string }[] = [
  { value: 'cash', label: 'Cash', on: 'bg-blue-600 text-white' },
  { value: 'client', label: 'Client initiated', on: 'bg-emerald-600 text-white' },
  { value: 'agent', label: 'Agent assisted', on: 'bg-amber-500 text-white' },
]

const EMPTY: DayAmounts = { cash: 0, client: 0, agent: 0, total: 0 }

/** Members down the side, Mon–Sun across. Each cell edits the selected channel for that member and day. */
export function WeekGrid({
  rows,
  days,
  dayTotals,
  weekTotal,
  channel,
  onChannel,
  containerRef,
  focusCell,
  onHistory,
  onPickDay,
}: {
  rows: WeekRow[]
  days: string[]
  dayTotals: Record<string, DayAmounts>
  weekTotal: number
  channel: Channel
  onChannel: (c: Channel) => void
  containerRef: RefObject<HTMLDivElement>
  focusCell: (row: number, col: number) => boolean
  onHistory: (m: Member) => void
  onPickDay: (date: string) => void
}) {
  const now = today()
  const label = CHANNEL_TABS.find((t) => t.value === channel)!.label

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden print-plain">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-slate-200 bg-slate-50 print:hidden">
        <span className="text-sm text-slate-600">Entering:</span>
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
          {CHANNEL_TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => onChannel(t.value)}
              className={cx('px-3 h-8 rounded-md text-sm font-medium', channel === t.value ? t.on : 'text-slate-600 hover:bg-slate-50')}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-500 hidden sm:inline">Enter moves down · Tab moves to the next day · amounts in other channels show under the box</span>
      </div>

      <div ref={containerRef} className="overflow-x-auto">
        <table className="w-full text-sm border-separate border-spacing-0">
          <thead>
            <tr className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              <th className="sticky left-0 z-[1] bg-white text-left px-4 py-2 border-b border-slate-200 min-w-[9rem] sm:min-w-[13rem]">Member</th>
              {days.map((d) => {
                const dt = fromISODate(d)
                return (
                  <th key={d} className={cx('px-1 py-2 border-b border-slate-200 min-w-[4.75rem] sm:min-w-[5.5rem]', d === now && 'bg-emerald-50')}>
                    <button onClick={() => onPickDay(d)} className="w-full text-center hover:text-emerald-700" title="Open this day">
                      <div>{dt.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                      <div className={cx('text-sm normal-case tracking-normal', d === now ? 'text-emerald-700 font-bold' : 'text-slate-800')}>
                        {dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </div>
                    </button>
                  </th>
                )
              })}
              <th className="px-4 py-2 border-b border-slate-200 text-right min-w-[7rem]">Week</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r.member.id} className={cx(r.total > 0 ? 'bg-emerald-50/30' : 'hover:bg-slate-50/60')}>
                <td className="sticky left-0 z-[1] bg-white px-2 sm:px-4 py-1.5 border-b border-slate-100">
                  <button onClick={() => onHistory(r.member)} className="text-left group flex gap-2 items-baseline min-w-0" title="Payment history">
                    <span className="text-xs text-slate-400 tabular-nums w-5 shrink-0">{ri + 1}</span>
                    <span className="min-w-0">
                      <span className="block font-semibold text-slate-800 truncate max-w-[7.5rem] sm:max-w-[14rem] group-hover:text-emerald-700 group-hover:underline">{r.member.name}</span>
                      <span className="block font-mono text-xs text-slate-500">{r.member.cid}</span>
                    </span>
                  </button>
                </td>
                {days.map((d, di) => {
                  const a = r.days[d] ?? EMPTY
                  const others = a.total - a[channel]
                  return (
                    <td key={d} className={cx('px-1 py-1.5 border-b border-slate-100 align-top', d === now && 'bg-emerald-50/50')}>
                      <AmountCell
                        member={r.member}
                        date={d}
                        channel={channel}
                        value={a[channel]}
                        rowIndex={ri}
                        colIndex={di}
                        focusCell={focusCell}
                        label={`${label} for ${r.member.name} on ${d}`}
                      />
                      {others > 0 && (
                        <div className="text-[10px] text-slate-500 text-right pr-1 tabular-nums" title="Paid through other channels this day">
                          +{formatPeso(others)}
                        </div>
                      )}
                    </td>
                  )
                })}
                <td className={cx('px-4 py-1.5 border-b border-slate-100 text-right font-bold tabular-nums', r.total ? 'text-emerald-700' : 'text-slate-300')}>
                  {formatPeso(r.total)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className="sticky left-0 z-[1] bg-slate-50 px-4 py-2.5 text-xs uppercase tracking-wide text-slate-500">Day total</td>
              {days.map((d) => (
                <td key={d} className={cx('px-1 py-2.5 text-right pr-3 tabular-nums bg-slate-50', !dayTotals[d]?.total && 'text-slate-300')}>
                  {formatPeso(dayTotals[d]?.total ?? 0)}
                </td>
              ))}
              <td className="px-4 py-2.5 text-right tabular-nums bg-slate-50 text-base">{formatPeso(weekTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
