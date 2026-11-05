// Light and dark themes. The theme lives on <html data-theme> so the token
// blocks in styles/tokens.css switch every surface at once. index.html sets it
// from storage before first paint (no flash); this module only changes it.
// Storage can be off (private windows, blocked site data), so every read and
// write is guarded and the page still themes for the visit.
import { useCallback, useEffect, useState } from 'react'

export const THEME_KEY = 'hivemind_theme'
export const THEMES = ['dark', 'light']
const SWITCH_MS = 240 // matches the .theme-switching transition in tokens.css

const valid = (t) => (THEMES.includes(t) ? t : null)
const root = () => (typeof document === 'undefined' ? null : document.documentElement)

export function currentTheme() {
  return valid(root()?.dataset.theme) || 'dark'
}

function readStored() {
  try { return valid(window.localStorage.getItem(THEME_KEY)) } catch { return null }
}

function store(theme) {
  try { window.localStorage.setItem(THEME_KEY, theme) } catch { /* storage off: the theme holds for this visit */ }
}

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

// The browser chrome (address bar tint, native controls) follows the page.
function syncMeta(theme) {
  const el = root()
  if (!el) return
  const bg = getComputedStyle(el).getPropertyValue('--theme-meta').trim()
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || (theme === 'light' ? '#E6EAE9' : '#11212D'))
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme)
}

let switchTimer = null

// Sets the attribute, the meta tags and (unless `persist` is false) storage.
// With `animate`, colours ease over for one transition instead of snapping.
export function applyTheme(theme, { animate = false, persist = true } = {}) {
  const el = root()
  const next = valid(theme) || 'dark'
  if (!el) return next
  if (animate && !reducedMotion() && el.dataset.theme !== next) {
    clearTimeout(switchTimer)
    el.classList.add('theme-switching')
    switchTimer = setTimeout(() => el.classList.remove('theme-switching'), SWITCH_MS + 40)
  }
  el.dataset.theme = next
  syncMeta(next)
  if (persist) store(next)
  return next
}

// [theme, setTheme, toggle]. Every mounted copy stays in step, and a change
// made in another tab follows here too.
const listeners = new Set()

export function useTheme() {
  const [theme, setState] = useState(currentTheme)

  useEffect(() => {
    listeners.add(setState)
    setState(currentTheme())
    const onStorage = (e) => {
      if (e.key !== THEME_KEY) return
      const next = valid(e.newValue) || readStored() || 'dark'
      applyTheme(next, { animate: true, persist: false })
      listeners.forEach((fn) => fn(next))
    }
    window.addEventListener('storage', onStorage)
    return () => {
      listeners.delete(setState)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setTheme = useCallback((next) => {
    const applied = applyTheme(next, { animate: true })
    listeners.forEach((fn) => fn(applied))
  }, [])

  const toggle = useCallback(() => setTheme(currentTheme() === 'light' ? 'dark' : 'light'), [setTheme])

  return [theme, setTheme, toggle]
}
