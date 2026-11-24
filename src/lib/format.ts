const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 })

export const formatPeso = (n: number) => peso.format(n || 0)

export function toISODate(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function fromISODate(s: string) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export const today = () => toISODate(new Date())

export function addDays(s: string, n: number) {
  const d = fromISODate(s)
  d.setDate(d.getDate() + n)
  return toISODate(d)
}

/** Monday-based week containing the date. */
export function weekRange(s: string): [string, string] {
  const d = fromISODate(s)
  const offset = (d.getDay() + 6) % 7
  const start = addDays(s, -offset)
  return [start, addDays(start, 6)]
}

export function monthRange(s: string): [string, string] {
  const d = fromISODate(s)
  return [toISODate(new Date(d.getFullYear(), d.getMonth(), 1)), toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0))]
}

export function addMonths(s: string, n: number) {
  const d = fromISODate(s)
  return toISODate(new Date(d.getFullYear(), d.getMonth() + n, 1))
}

export const formatLongDate = (s: string) =>
  fromISODate(s).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })

export const formatShortDate = (s: string) =>
  fromISODate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export const formatDayDate = (s: string) =>
  fromISODate(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })

export function formatRange(a: string, b: string) {
  const da = fromISODate(a)
  const dbb = fromISODate(b)
  const sameYear = da.getFullYear() === dbb.getFullYear()
  const left = da.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
  const right = dbb.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${left} – ${right}`
}

export function parseAmount(v: string) {
  const n = Number(v.replace(/[₱,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : 0
}
