// Vercel Edge Function — lets the client detect the STATIC runtime explicitly.
// The Node server answers the same route with { realtime: "ws" }.
export const config = { runtime: 'edge' }

export default function handler() {
  return new Response(JSON.stringify({ ok: true, realtime: 'relay', platform: 'vercel-edge' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}
