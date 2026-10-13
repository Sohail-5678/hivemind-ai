import React from 'react'

// Fixed spatial backdrop: navy depth gradients, drifting cobalt/red orbs, and a
// perspective floor grid. Purely decorative, pointer-events off.
export function Scene() {
  return (
    <div className="scene" aria-hidden="true">
      <div className="orb cobalt" />
      <div className="orb red" />
      <div className="orb sky" />
      <div className="scene-grid" />
    </div>
  )
}
