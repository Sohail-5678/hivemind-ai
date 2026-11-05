import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ROLES, agentCard } from '@shared/swarm/roles.js'
import { useFocusTrap } from './hooks'
import { glyph } from './format'

// Tints JSON keys, strings and literals. Builds elements, never HTML.
const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?/g
function highlight(json) {
  const out = []
  let last = 0
  let m
  JSON_TOKEN.lastIndex = 0
  while ((m = JSON_TOKEN.exec(json)) !== null) {
    if (m.index > last) out.push(json.slice(last, m.index))
    const cls = m[1] ? (m[2] ? 'k' : 's') : 'l'
    out.push(<span key={m.index} className={`hv-json-${cls}`}>{m[1] || m[0]}</span>)
    if (m[2]) out.push(m[2])
    last = m.index + m[0].length
  }
  if (last < json.length) out.push(json.slice(last))
  return out
}

// The A2A-style agent card for one role: discovery metadata only. HiveMind
// publishes these as static JSON and exposes no A2A RPC endpoint.
export function AgentCardModal({ agent, onClose }) {
  if (!agent) return null
  return <CardDialog agent={agent} onClose={onClose} />
}

function CardDialog({ agent, onClose }) {
  const id = useId()
  const ref = useRef(null)
  const [copied, setCopied] = useState(false)
  useFocusTrap(ref, onClose)

  const role = ROLES[agent.role] ? agent.role : null
  const base = role ? ROLES[role] : null
  const card = useMemo(() => (role ? agentCard(role) : null), [role])
  const json = card ? JSON.stringify(card, null, 2) : ''
  const pretty = useMemo(() => (json ? highlight(json) : null), [json])
  const instance = base && agent.name && agent.name !== base.name
  const focus = agent.focus || (instance && agent.name.includes(' · ') ? agent.name.split(' · ').slice(1).join(' · ') : '')

  useEffect(() => {
    if (!copied) return undefined
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  // Lock page scroll behind the dialog; restore whatever was there before.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
    } catch {
      // Clipboard can be blocked (insecure origin, permissions): select the text instead.
      const pre = ref.current?.querySelector('pre')
      if (pre && typeof window !== 'undefined') {
        const range = document.createRange()
        range.selectNodeContents(pre)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }
  }

  const dialog = (
    <div className="hv-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div ref={ref} className="hv-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-desc`} tabIndex={-1}>
        <div className="hv-modal-head">
          <span className="hv-modal-disc" aria-hidden="true">{glyph(agent.glyph || base?.glyph)}</span>
          <div className="hv-modal-title">
            <span className="label-mono">Agent card</span>
            <h3 id={`${id}-title`}>{agent.name || base?.name || 'Agent'}</h3>
            {instance && <span className="hv-modal-role">{`${base.name} role${focus ? `, focus: ${focus}` : ''}`}</span>}
          </div>
          <button type="button" className="btn btn-icon btn-ghost hv-modal-close" onClick={() => onClose?.()} aria-label="Close agent card" data-autofocus>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2 L12 12 M12 2 L2 12" /></svg>
          </button>
        </div>

        <p id={`${id}-desc`} className="hv-modal-desc">{base?.description || agent.description || 'No description.'}</p>

        {base?.skills?.length > 0 && (
          <section className="hv-modal-sec">
            <h4 className="label-mono">Skills</h4>
            <ul className="hv-skills">
              {base.skills.map((s) => (
                <li key={s.id} className="hv-skill">
                  <span className="hv-skill-name">{s.name}</span>
                  <span className="hv-skill-desc">{s.description}</span>
                  {Array.isArray(s.tags) && s.tags.length > 0 && (
                    <span className="hv-skill-tags">{s.tags.map((t) => <span key={t} className="badge">{t}</span>)}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="hv-modal-sec">
          <div className="hv-modal-sec-head">
            <h4 className="label-mono">A2A card</h4>
            {card && (
              <button type="button" className="btn btn-sm hv-copy" onClick={copy} aria-live="polite">
                {copied ? 'Copied' : 'Copy JSON'}
              </button>
            )}
          </div>
          {card
            ? <pre className="hv-json" tabIndex={0} aria-label="Agent card JSON">{pretty}</pre>
            : <p className="hv-empty">This step has no published card.</p>}
          <p className="hv-modal-note">Discovery metadata in the A2A card format. Agents here have no tools and no web access; they work from the conversation and the shared board.</p>
        </section>
      </div>
    </div>
  )

  // Portal out of the panel so no transformed ancestor can trap the overlay.
  return typeof document !== 'undefined' && document.body ? createPortal(dialog, document.body) : dialog
}
