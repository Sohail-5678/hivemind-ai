import React, { useId } from 'react'
import { useTheme } from '../lib/theme'

// One raised key in the top bar. It shows the theme it switches to: a sun in
// dark, a moon in light. The two are one drawing, so switching is a single
// short move: the disc grows, a bite slides in to cut the crescent and the
// rays fold away (index.css, .theme-toggle).
const RAYS = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2
  const p = (r) => [12 + Math.sin(a) * r, 12 - Math.cos(a) * r].map((v) => v.toFixed(2))
  const [x1, y1] = p(6.6)
  const [x2, y2] = p(8.7)
  return { x1, y1, x2, y2 }
})

export function ThemeToggle() {
  const [theme, , toggle] = useTheme()
  const mask = `tt${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const next = theme === 'light' ? 'dark' : 'light'
  const label = `Switch to ${next} theme`

  return (
    <button
      type="button"
      className={`theme-toggle is-${theme}`}
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      <svg className="tt-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <mask id={mask}>
          <rect width="24" height="24" fill="#fff" />
          <circle className="tt-bite" cx="16.6" cy="7.4" r="7.2" fill="#000" />
        </mask>
        <circle className="tt-core" cx="12" cy="12" r="8" mask={`url(#${mask})`} />
        <g className="tt-rays">
          {RAYS.map((r, i) => <line key={i} {...r} />)}
        </g>
      </svg>
    </button>
  )
}
