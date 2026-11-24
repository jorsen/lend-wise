import { useEffect, useRef, useState } from 'react'
import type { Channel, Member } from '../db'
import { setPayment } from '../lib/data'
import { parseAmount } from '../lib/format'
import { cx, useToast } from './ui'

const CELL_COLORS: Record<Channel, string> = {
  cash: 'focus:ring-blue-500/40 focus:border-blue-500',
  client: 'focus:ring-emerald-500/40 focus:border-emerald-500',
  agent: 'focus:ring-amber-500/40 focus:border-amber-500',
}

/**
 * Editable amount for one member / date / channel. Saves on blur.
 * Enter or ↓ moves to the same column on the next row, Shift+Enter or ↑ to the previous row.
 * Cells find each other through `data-cell="row-col"` inside the container passed to `focusCell`.
 */
export function AmountCell({
  member,
  date,
  channel,
  value,
  rowIndex,
  colIndex,
  focusCell,
  label,
  mobileLabel,
  className,
  align = 'right',
}: {
  member: Member
  date: string
  channel: Channel
  value: number
  rowIndex: number
  colIndex: number
  focusCell: (row: number, col: number) => boolean
  label: string
  mobileLabel?: string
  className?: string
  align?: 'right' | 'center'
}) {
  const toast = useToast()
  const [draft, setDraftState] = useState(value ? String(value) : '')
  const draftRef = useRef(draft)
  const setDraft = (v: string) => {
    draftRef.current = v
    setDraftState(v)
  }
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setDraft(value ? String(value) : '')
  }, [value, focused])

  const commit = async () => {
    // Read from the ref: Enter can blur this cell before React re-renders with the latest keystroke.
    const amount = parseAmount(draftRef.current)
    if (amount === value) return
    try {
      await setPayment(member, date, channel, amount)
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`, 'error')
    }
  }

  return (
    <label className="block">
      {mobileLabel && <span className="md:hidden block text-[11px] font-medium text-slate-500 mb-0.5">{mobileLabel}</span>}
      <input
        data-cell={`${rowIndex}-${colIndex}`}
        inputMode="decimal"
        autoComplete="off"
        className={cx(
          'w-full h-9 rounded-md border px-2 text-sm tabular-nums focus:outline-none focus:ring-2 print:border-0 print:h-auto',
          value ? 'border-slate-300 bg-white font-semibold text-slate-900' : 'border-slate-200 bg-slate-50/50 text-slate-500',
          align === 'center' ? 'text-center' : 'text-right',
          CELL_COLORS[channel],
          className,
        )}
        placeholder="0"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d.,]/g, ''))}
        onFocus={(e) => {
          setFocused(true)
          e.target.select()
        }}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault()
            const next = e.shiftKey && e.key === 'Enter' ? rowIndex - 1 : rowIndex + 1
            if (!focusCell(next, colIndex)) e.currentTarget.blur()
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            focusCell(rowIndex - 1, colIndex)
          } else if (e.key === 'Escape') {
            setDraft(value ? String(value) : '')
            setTimeout(() => (e.target as HTMLInputElement).blur())
          }
        }}
        aria-label={label}
      />
    </label>
  )
}
