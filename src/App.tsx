import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Menu, PiggyBank } from 'lucide-react'
import { db } from './db'
import { seedDefaultGroups } from './lib/data'
import { navigate, useRoute } from './lib/router'
import { Sidebar } from './components/Sidebar'
import { GroupDialog } from './components/dialogs'
import { SaversPage } from './pages/SaversPage'
import { ReportsPage } from './pages/ReportsPage'
import { BackupPage } from './pages/BackupPage'
import { MemberProfilePage } from './pages/MemberProfilePage'
import { MembersPage } from './pages/MembersPage'

export default function App() {
  const route = useRoute()
  const [menuOpen, setMenuOpen] = useState(false)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), [])

  useEffect(() => {
    seedDefaultGroups().catch(console.error)
  }, [])

  // The group in the URL, else the first group.
  const routeGroupId = route.page === 'savers' ? route.groupId : null
  const activeGroup = groups?.find((g) => g.id === routeGroupId) ?? (routeGroupId === null ? groups?.[0] : undefined)

  useEffect(() => {
    if (route.page === 'savers' && groups?.length && routeGroupId !== null && !groups.some((g) => g.id === routeGroupId)) {
      navigate({ page: 'savers', groupId: groups[0].id! })
    }
  }, [route, groups, routeGroupId])

  return (
    <div className="min-h-dvh flex bg-slate-50 text-slate-900">
      <Sidebar
        route={route}
        activeGroupId={activeGroup?.id ?? null}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onNewGroup={() => {
          setMenuOpen(false)
          setNewGroupOpen(true)
        }}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="lg:hidden sticky top-0 z-20 flex items-center gap-3 bg-slate-900 text-white px-4 h-14 print:hidden">
          <button onClick={() => setMenuOpen(true)} className="p-1 -ml-1" aria-label="Open menu">
            <Menu size={22} />
          </button>
          <PiggyBank size={20} className="text-emerald-400" />
          <span className="font-semibold">S&amp;L Manager</span>
        </header>

        <main className="flex-1 min-w-0">
          {route.page === 'reports' && <ReportsPage />}
          {route.page === 'backup' && <BackupPage />}
          {route.page === 'members' && <MembersPage />}
          {route.page === 'member' && <MemberProfilePage key={route.id} id={route.id} />}
          {route.page === 'savers' &&
            (activeGroup ? (
              <SaversPage key={activeGroup.id} group={activeGroup} />
            ) : groups && groups.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-slate-600 mb-4">Create your first group to start recording payments.</p>
                <button className="rounded-lg bg-emerald-600 text-white px-4 py-2 font-medium" onClick={() => setNewGroupOpen(true)}>
                  New group
                </button>
              </div>
            ) : null)}
        </main>
      </div>

      <GroupDialog open={newGroupOpen} onClose={() => setNewGroupOpen(false)} onSaved={(id) => navigate({ page: 'savers', groupId: id })} />
    </div>
  )
}
