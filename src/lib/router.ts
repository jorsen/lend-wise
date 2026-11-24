import { useEffect, useState } from 'react'

export type Route =
  | { page: 'savers'; groupId: number | null }
  | { page: 'reports' }
  | { page: 'backup' }

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/')
  if (parts[0] === 'reports') return { page: 'reports' }
  if (parts[0] === 'backup') return { page: 'backup' }
  const id = Number(parts[1])
  return { page: 'savers', groupId: parts[0] === 'group' && Number.isFinite(id) ? id : null }
}

export function useRoute() {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const on = () => setRoute(parse(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export const hrefFor = (r: Route) =>
  r.page === 'savers' ? (r.groupId ? `#/group/${r.groupId}` : '#/') : `#/${r.page}`

export const navigate = (r: Route) => {
  location.hash = hrefFor(r)
}
