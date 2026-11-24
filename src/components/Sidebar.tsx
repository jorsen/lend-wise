import { useLiveQuery } from 'dexie-react-hooks'
import { BarChart3, Building2, Database, PiggyBank, Plus, TriangleAlert, X } from 'lucide-react'
import { db } from '../db'
import { hrefFor, type Route } from '../lib/router'
import { cx } from './ui'

export const LAST_BACKUP_KEY = 'lendwise:lastBackupAt'

export function daysSinceBackup() {
  try {
    const v = localStorage.getItem(LAST_BACKUP_KEY)
    if (!v) return null
    return Math.floor((Date.now() - Number(v)) / 86_400_000)
  } catch {
    return null
  }
}

export function Sidebar({
  route,
  activeGroupId,
  open,
  onClose,
  onNewGroup,
}: {
  route: Route
  activeGroupId: number | null
  open: boolean
  onClose: () => void
  onNewGroup: () => void
}) {
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), [])
  const counts = useLiveQuery(async () => {
    const all = await db.members.toArray()
    const m = new Map<number, number>()
    for (const x of all) m.set(x.groupId, (m.get(x.groupId) ?? 0) + 1)
    return m
  }, [])
  const paymentsCount = useLiveQuery(() => db.payments.count(), [])
  const since = daysSinceBackup()
  const needsBackup = (paymentsCount ?? 0) > 0 && (since === null || since >= 7)

  const link = (active: boolean) =>
    cx(
      'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
      active ? 'bg-white/10 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white',
    )

  return (
    <>
      <div className={cx('fixed inset-0 z-30 bg-slate-900/50 lg:hidden', open ? 'block' : 'hidden')} onClick={onClose} />
      <aside
        className={cx(
          'fixed lg:sticky top-0 left-0 z-40 h-dvh w-64 shrink-0 bg-slate-900 text-white flex flex-col transition-transform print:hidden',
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        <div className="flex items-center gap-3 px-5 py-5 border-b border-white/10">
          <div className="h-10 w-10 rounded-xl bg-emerald-500 grid place-items-center">
            <PiggyBank size={22} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-bold leading-tight">S&amp;L Manager</div>
            <div className="text-xs text-slate-400">Savers records</div>
          </div>
          <button className="lg:hidden p-1 text-slate-400 hover:text-white" onClick={onClose} aria-label="Close menu">
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <div className="flex items-center justify-between px-3 mb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Groups</span>
            <button onClick={onNewGroup} className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10" title="New group" aria-label="New group">
              <Plus size={16} />
            </button>
          </div>
          <div className="space-y-0.5">
            {groups?.map((g) => (
              <a
                key={g.id}
                href={hrefFor({ page: 'savers', groupId: g.id! })}
                onClick={onClose}
                className={link(route.page === 'savers' && activeGroupId === g.id)}
              >
                <Building2 size={18} className="shrink-0" />
                <span className="flex-1 truncate">{g.name}</span>
                <span className="text-xs text-slate-500 tabular-nums">{counts?.get(g.id!) ?? 0}</span>
              </a>
            ))}
            {groups?.length === 0 && <p className="px-3 text-sm text-slate-500">No groups yet.</p>}
          </div>

          <div className="mt-6 pt-4 border-t border-white/10 space-y-0.5">
            <a href={hrefFor({ page: 'reports' })} onClick={onClose} className={link(route.page === 'reports')}>
              <BarChart3 size={18} /> Reports
            </a>
            <a href={hrefFor({ page: 'backup' })} onClick={onClose} className={link(route.page === 'backup')}>
              <Database size={18} />
              <span className="flex-1">Backup &amp; Restore</span>
              {needsBackup && <TriangleAlert size={16} className="text-amber-400" />}
            </a>
          </div>
        </nav>

        {needsBackup && (
          <a href={hrefFor({ page: 'backup' })} onClick={onClose} className="m-3 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-200 hover:bg-amber-500/20">
            {since === null ? 'No backup yet.' : `Last backup ${since} days ago.`} Data lives only in this browser, so download a backup.
          </a>
        )}
      </aside>
    </>
  )
}
