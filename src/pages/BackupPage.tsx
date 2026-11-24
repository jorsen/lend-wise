import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Database, Download, ShieldCheck, Upload } from 'lucide-react'
import { db } from '../db'
import { exportBackup, restoreBackup, type BackupFile } from '../lib/data'
import { downloadFile, readFileText } from '../lib/csv'
import { today } from '../lib/format'
import { Button, ConfirmDialog, useToast } from '../components/ui'
import { LAST_BACKUP_KEY, daysSinceBackup } from '../components/Sidebar'

export function BackupPage() {
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<BackupFile | null>(null)
  const [, force] = useState(0)
  const counts = useLiveQuery(async () => ({
    groups: await db.groups.count(),
    members: await db.members.count(),
    payments: await db.payments.count(),
  }))
  const since = daysSinceBackup()

  const download = async () => {
    const data = await exportBackup()
    downloadFile(`lendwise-backup_${today()}.json`, JSON.stringify(data), 'application/json')
    try {
      localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()))
    } catch {
      /* ignore */
    }
    force((n) => n + 1)
    toast('Backup downloaded')
  }

  const pick = async (file: File) => {
    try {
      const data = JSON.parse(await readFileText(file))
      if (data?.app !== 'lend-wise') throw new Error('This file is not a Lend-Wise backup.')
      setPending(data)
    } catch (e) {
      toast((e as Error).message || 'Could not read that file', 'error')
    }
  }

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-5 max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <div className="h-11 w-11 rounded-xl bg-slate-200 text-slate-700 grid place-items-center">
          <Database size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold leading-tight">Backup &amp; Restore</h1>
          <p className="text-sm text-slate-500">Your records are stored only in this browser on this device.</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        {(['groups', 'members', 'payments'] as const).map((k) => (
          <div key={k} className="rounded-xl bg-white border border-slate-200 px-4 py-3 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">{k}</div>
            <div className="text-2xl font-bold tabular-nums">{counts?.[k] ?? '—'}</div>
          </div>
        ))}
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm mb-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="text-emerald-600 shrink-0 mt-0.5" size={20} />
          <div className="flex-1">
            <h2 className="font-semibold">Download a backup</h2>
            <p className="text-sm text-slate-600 mt-1">
              Saves every group, member and payment to one file. Keep it somewhere safe, such as Google Drive or a USB stick. Clearing browser data or
              switching devices erases records that aren't backed up.
            </p>
            <p className="text-sm mt-2 text-slate-500">
              Last backup: <span className="font-medium text-slate-700">{since === null ? 'never' : since === 0 ? 'today' : `${since} day${since === 1 ? '' : 's'} ago`}</span>
            </p>
            <Button variant="primary" className="mt-4" onClick={download}>
              <Download size={16} /> Download backup
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <Upload className="text-slate-600 shrink-0 mt-0.5" size={20} />
          <div className="flex-1">
            <h2 className="font-semibold">Restore from a backup</h2>
            <p className="text-sm text-slate-600 mt-1">Replaces everything in this browser with the contents of a backup file. Use it to move to a new device or undo a mistake.</p>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) pick(f)
                e.target.value = ''
              }}
            />
            <Button className="mt-4" onClick={() => fileRef.current?.click()}>
              <Upload size={16} /> Choose backup file…
            </Button>
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={!!pending}
        title="Replace all data?"
        confirmLabel="Restore"
        message={
          pending && (
            <>
              <p>
                The backup from <b>{new Date(pending.exportedAt).toLocaleString()}</b> contains {pending.groups.length} groups, {pending.members.length} members and{' '}
                {pending.payments.length} payments.
              </p>
              <p className="mt-2">
                It will <b>replace</b> the {counts?.payments ?? 0} payments and {counts?.members ?? 0} members currently in this browser.
              </p>
            </>
          )
        }
        onConfirm={async () => {
          try {
            const r = await restoreBackup(pending)
            toast(`Restored ${r.members} members and ${r.payments} payments`)
          } catch (e) {
            toast((e as Error).message, 'error')
          }
        }}
        onClose={() => setPending(null)}
      />
    </div>
  )
}
