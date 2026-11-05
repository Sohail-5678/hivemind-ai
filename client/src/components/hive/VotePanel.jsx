import React, { useId, useState } from 'react'
import { useNow } from './hooks'
import { clock, plural } from './format'

const TIE_BREAK = {
  'human majority': 'The tie went to the proposal more people voted for.',
  'first proposal': 'No person broke the tie, so the first proposal won.',
}

function tallyOf(vote) {
  if (vote.tally && typeof vote.tally === 'object') return vote.tally
  const t = {}
  for (const v of vote.votes) t[v.option] = (t[v.option] || 0) + 1
  return t
}

// Debate consensus: agents and people vote together; the winner writes the answer.
export function VotePanel({ vote, you, onAction, readOnly = false }) {
  const id = useId()
  const [pending, setPending] = useState(null)
  const [error, setError] = useState(null)
  const open = Boolean(vote?.open)
  const now = useNow(open, 500)
  if (!vote || !Array.isArray(vote.options) || !vote.options.length) return null

  const votes = (Array.isArray(vote.votes) ? vote.votes : []).filter((v) => v && v.voter && v.option)
  const view = { ...vote, votes }
  const tally = tallyOf(view)
  const total = Object.values(tally).reduce((a, n) => a + (Number(n) || 0), 0)
  const mine = votes.find((v) => v.voter.kind === 'human' && you?.id && v.voter.id === you.id)?.option || null
  const left = Math.max(0, (Number(vote.deadline) || 0) - now)
  const canVote = open && !readOnly && typeof onAction === 'function' && Boolean(you)
  const winner = !open && vote.winner ? vote.options.find((o) => o.id === vote.winner) : null
  const people = Array.isArray(vote.humans) ? vote.humans.length : 0

  const cast = async (option) => {
    if (!canVote || pending) return
    setPending(option)
    setError(null)
    try { await onAction('vote', { option }) } catch (err) { setError(err?.message || 'Your vote did not go through.') } finally { setPending(null) }
  }

  return (
    <section className={`hv-vote${open ? ' is-open' : ''}`} aria-labelledby={`${id}-q`}>
      <header className="hv-vote-head">
        <div>
          <span className="label-mono">{open ? 'Vote open' : 'Vote closed'}</span>
          <h2 id={`${id}-q`} className="hv-vote-q">{vote.question || 'Which proposal should the team adopt?'}</h2>
        </div>
        {open ? (
          <span className="hv-count" aria-label={left > 0 ? `${Math.ceil(left / 1000)} seconds left` : 'Closing'}>{left > 0 ? clock(left) : 'closing'}</span>
        ) : (
          <span className="hv-count is-done">{plural(total, 'vote')}</span>
        )}
      </header>
      {open && (
        <p className="hv-vote-sub">
          {people ? `Agents have voted. ${plural(people, 'person', 'people')} in the room can vote too; ties go to the people.` : 'The agents have voted.'}
        </p>
      )}

      <ul className="hv-opts">
        {vote.options.map((o, i) => {
          const count = Number(tally[o.id]) || 0
          const voters = votes.filter((v) => v.option === o.id)
          const isMine = mine === o.id
          const isWinner = winner?.id === o.id
          return (
            <li key={o.id || i} className={`hv-opt${isWinner ? ' is-winner' : ''}${isMine ? ' is-mine' : ''}`}>
              <div className="hv-opt-head">
                <span className="hv-opt-by">{o.by ? `${o.by}’s proposal` : `Proposal ${i + 1}`}</span>
                <span className="hv-opt-count">{count}</span>
              </div>
              <p className="hv-opt-text">{o.label || o.text || 'No proposal text.'}</p>
              {o.text && o.label && o.text !== o.label && <p className="hv-opt-more">{o.text}</p>}
              <span className="hv-opt-bar" aria-hidden="true"><span style={{ width: total ? `${Math.round((count / total) * 100)}%` : '0%' }} /></span>
              <div className="hv-opt-foot">
                <span className="hv-voters">
                  {voters.map((v) => (
                    <span key={`${v.voter.kind}:${v.voter.id}`} className={`hv-voter ${v.voter.kind === 'human' ? 'human' : 'agent'}`}>
                      {v.voter.kind === 'human' && you?.id === v.voter.id ? 'You' : v.voter.name || 'Someone'}
                    </span>
                  ))}
                </span>
                {open && (
                  // aria-disabled while a vote is in flight: a disabled button
                  // drops keyboard focus, and `cast` already ignores the click.
                  <button
                    type="button"
                    className={`btn btn-sm ${isMine ? 'btn-human pressed' : ''} hv-opt-btn`}
                    aria-pressed={isMine}
                    disabled={!canVote}
                    aria-disabled={pending !== null || undefined}
                    onClick={() => cast(o.id)}
                  >
                    {pending === o.id ? 'Voting' : isMine ? 'Your vote' : mine ? 'Change vote' : 'Vote'}
                  </button>
                )}
                {isWinner && <span className="badge agent">Winner</span>}
              </div>
            </li>
          )
        })}
      </ul>

      {error && <p className="hv-error" role="alert">{error}</p>}
      {winner && (
        <p className="hv-vote-result" role="status">
          <strong>{winner.by ? `The ${winner.by}’s proposal won.` : 'A proposal won.'}</strong>
          {` ${winner.by ? `The ${winner.by}` : 'Its author'} writes the final answer.`}
          {vote.tieBreak && ` ${TIE_BREAK[vote.tieBreak] || `Tie broken by ${vote.tieBreak}.`}`}
        </p>
      )}
      {!open && !winner && <p className="hv-vote-result">The vote ended before a winner was chosen.</p>}
    </section>
  )
}
