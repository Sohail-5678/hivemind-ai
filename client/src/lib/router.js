// Hash router. Every screen, including being inside a room, has a URL, so
// refresh rejoins, Back leaves the room, and links can be shared.
//
//   #/                          home
//   #/demo #/sample #/live #/about
//   #/join/CODE                 Live, join card prefilled
//   #/live/room/CODE            inside a room (static runtime, encrypted relay)
//   #/sample/room/CODE
//   #/live/s/SESSION_ID         inside a room (server runtime)
//   #/sample/s/SESSION_ID
import { useEffect, useState } from 'react'

export const SECTIONS = ['demo', 'sample', 'live', 'about']
const CODE = '[A-Za-z0-9]{4,10}'
const SESSION = '[A-Za-z0-9_-]{4,40}'

export function parseRoute(hash = window.location.hash) {
  const path = String(hash || '').replace(/^#/, '').replace(/\/+$/, '') || '/'
  if (path === '/' || path === '') return { section: 'home', room: null, join: null, valid: true, path: '/' }

  let m = path.match(new RegExp(`^/join/(${CODE})$`))
  if (m) return { section: 'live', room: null, join: m[1].toUpperCase(), valid: true, path }

  m = path.match(new RegExp(`^/(sample|live)/room/(${CODE})$`))
  if (m) return { section: m[1], room: { kind: 'code', code: m[2].toUpperCase() }, join: null, valid: true, path }

  m = path.match(new RegExp(`^/(sample|live)/s/(${SESSION})$`))
  if (m) return { section: m[1], room: { kind: 'session', id: m[2] }, join: null, valid: true, path }

  m = path.match(/^\/(demo|sample|live|about)$/)
  if (m) return { section: m[1], room: null, join: null, valid: true, path }

  return { section: 'home', room: null, join: null, valid: false, path }
}

// navigate('/live/room/ABC123') pushes a history entry; { replace: true } swaps
// the current one (used to normalize bad URLs without breaking Back).
export function navigate(path, { replace = false } = {}) {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`
  if (window.location.hash === target) return
  if (replace) {
    history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${target}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    window.location.hash = target
  }
}

// The route for being inside a session. Static rooms are addressed by room code,
// server sessions by id. A session's own mode wins over the section asking, so
// a Sample session's code typed into Live still opens it as Sample.
export function roomPath(section, session) {
  const mode = session?.mode === 'sample' || session?.mode === 'live' ? session.mode : section
  const where = mode === 'sample' ? 'sample' : 'live'
  if (!session) return `/${where}`
  const local = session.local || String(session.id || '').startsWith('local_')
  return local ? `/${where}/room/${session.roomCode}` : `/${where}/s/${session.id}`
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute())
  useEffect(() => {
    const onChange = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onChange)
    window.addEventListener('popstate', onChange)
    return () => {
      window.removeEventListener('hashchange', onChange)
      window.removeEventListener('popstate', onChange)
    }
  }, [])
  return route
}
