import React from 'react'

// Fixed backdrop: soft light from the top left (the same light the neumorphic
// surfaces are shaded for), a hex dot lattice that fades out toward the edges,
// and one slow orbit. A static SVG plus a single transformed layer, so it costs
// one composite per frame. Inside a room it goes quiet so the work stays in front.
export function Scene({ quiet = false }) {
  return (
    <div className={`scene${quiet ? ' quiet' : ''}`} aria-hidden="true">
      <div className="scene-light" />
      <svg className="scene-lattice" width="100%" height="100%" focusable="false">
        <defs>
          <pattern id="scene-hex-dots" width="28" height="48.5" patternUnits="userSpaceOnUse">
            <circle cx="7" cy="6" r="1" />
            <circle cx="21" cy="30.25" r="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#scene-hex-dots)" />
      </svg>
      <div className="scene-orbit">
        <svg viewBox="0 0 600 600" focusable="false">
          <circle className="orbit-ring" cx="300" cy="300" r="296" />
          <circle className="orbit-ring inner" cx="300" cy="300" r="214" />
          <circle className="orbit-arc" cx="300" cy="300" r="296" pathLength="100" transform="rotate(-90 300 300)" />
          <circle className="orbit-node" cx="300" cy="4" r="4" />
        </svg>
      </div>
    </div>
  )
}
