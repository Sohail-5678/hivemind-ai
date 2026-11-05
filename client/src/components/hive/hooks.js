import { useEffect, useRef, useState } from 'react'

const hasWindow = typeof window !== 'undefined'

// Wall-clock "now" that ticks only while `active`, for countdowns and elapsed
// readouts. Idle components don't keep a timer alive.
export function useNow(active, ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active, ms])
  return now
}

export function useReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => Boolean(hasWindow && window.matchMedia?.(query).matches))
  useEffect(() => {
    if (!hasWindow || !window.matchMedia) return undefined
    const mq = window.matchMedia(query)
    const onChange = () => setReduced(mq.matches)
    onChange()
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Keeps Tab inside a dialog, closes it on Escape, and hands focus back to
// whatever opened it.
export function useFocusTrap(ref, onClose) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const opener = hasWindow ? document.activeElement : null
    const first = el.querySelector('[data-autofocus]') || el.querySelector(FOCUSABLE) || el
    first.focus({ preventScroll: true })
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current?.(); return }
      if (e.key !== 'Tab') return
      const items = [...el.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement)
      if (!items.length) { e.preventDefault(); return }
      const head = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === head || !el.contains(document.activeElement))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); head.focus() }
    }
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('keydown', onKey)
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus({ preventScroll: true })
    }
  }, [ref])
}
