import { useEffect, useState } from 'react'

export type Route =
  | { page: 'savers'; groupId: number | null }
  | { page: 'member'; id: number }
  | { page: 'members' }
  | { page: 'reports' }
  | { page: 'backup' }

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/')
  if (parts[0] === 'members') return { page: 'members' }
  if (parts[0] === 'reports') return { page: 'reports' }
  if (parts[0] === 'backup') return { page: 'backup' }
  const id = Number(parts[1])
  if (parts[0] === 'member' && Number.isFinite(id)) return { page: 'member', id }
  return { page: 'savers', groupId: parts[0] === 'group' && Number.isFinite(id) ? id : null }
}

export function useRoute() {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const on = () => {
      setRoute(parse(location.hash))
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export const hrefFor = (r: Route) =>
  r.page === 'savers' ? (r.groupId ? `#/group/${r.groupId}` : '#/') : r.page === 'member' ? `#/member/${r.id}` : `#/${r.page}`

export const navigate = (r: Route) => {
  location.hash = hrefFor(r)
}

/** Opens a group's Savers sheet in Day view on a specific date. */
export function openDay(groupId: number, date: string) {
  try {
    // Same keys SaversPage reads when it mounts.
    sessionStorage.setItem('lendwise:date', date)
    sessionStorage.setItem('lendwise:mode', 'day')
  } catch {
    /* ignore */
  }
  navigate({ page: 'savers', groupId })
}
