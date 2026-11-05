// Tiny safe markdown renderer. Builds React elements directly (no innerHTML),
// so agent and user content can never inject markup. Supports paragraphs, bold,
// inline code, italics, fenced code blocks, headings, tables, rules and lists.
// Every element carries an md-* class; the look lives in index.css.
import React from 'react'

// @mentions (`@critic check the numbers`) call on an agent, so they read as a
// token. An email address doesn't qualify: the @ has to start a word.
const MENTION = /^(\s?)(@[A-Za-z][\w-]*)$/

function renderInline(text, keyBase) {
  const parts = []
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\b_[^_]+_\b|(?:^|\s)@[A-Za-z][\w-]*)/g
  let last = 0
  let match
  let i = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const token = match[0]
    const mention = token.match(MENTION)
    if (mention) {
      if (mention[1]) parts.push(mention[1])
      parts.push(<span key={`${keyBase}-m${i++}`} className="md-mention">{mention[2]}</span>)
    } else if (token.startsWith('**')) {
      parts.push(<strong key={`${keyBase}-b${i++}`} className="md-strong">{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      parts.push(<code key={`${keyBase}-c${i++}`} className="md-code">{token.slice(1, -1)}</code>)
    } else {
      parts.push(<em key={`${keyBase}-i${i++}`} className="md-em">{token.slice(1, -1)}</em>)
    }
    last = match.index + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

const FENCE = /^\s*```/
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
const HEADING = /^#{1,6}\s/
const BULLET = /^\s*[-*]\s/
const NUMBERED = /^\s*(\d+)\.\s/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}/
const PARA_BREAK = /^\s*[-*]\s|^#{1,6}\s|^\s*\d+\.\s|^\s*```|^\s*\||^\s*(-{3,}|\*{3,}|_{3,})\s*$/

export function Markdown({ text }) {
  if (!text) return null
  const blocks = []
  const lines = String(text).split('\n')
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code. An unterminated fence (mid-stream) runs to the end of the text.
    if (FENCE.test(line)) {
      const lang = line.trim().slice(3).trim().split(/\s+/)[0].slice(0, 20)
      const code = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) { code.push(lines[i]); i++ }
      i++
      blocks.push(
        <pre key={key++} className="md-pre" data-lang={lang || undefined}>
          <code className="md-code-block">{code.join('\n')}</code>
        </pre>
      )
      continue
    }
    if (RULE.test(line)) { blocks.push(<hr key={key++} className="md-hr" />); i++; continue }

    // GitHub-style table: a | row followed by a |---| separator row.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && TABLE_ROW.test(lines[i])) { rows.push(cells(lines[i])); i++ }
      blocks.push(
        <div className="md-table" key={key++} role="region" aria-label="Table" tabIndex={0}>
          <table>
            <thead><tr>{head.map((c, j) => <th key={j}>{renderInline(c, `${key}h${j}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{renderInline(c, `${key}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
      continue
    }

    if (HEADING.test(line)) {
      blocks.push(<h3 key={key++} className="md-h">{renderInline(line.replace(HEADING, ''), key)}</h3>)
      i++
      continue
    }
    if (BULLET.test(line)) {
      const items = []
      while (i < lines.length && BULLET.test(lines[i])) {
        items.push(<li key={key++} className="md-li">{renderInline(lines[i].replace(BULLET, ''), key)}</li>)
        i++
      }
      blocks.push(<ul key={key++} className="md-ul">{items}</ul>)
      continue
    }
    if (NUMBERED.test(line)) {
      const start = Number(line.match(NUMBERED)[1]) || 1
      const items = []
      while (i < lines.length && NUMBERED.test(lines[i])) {
        items.push(<li key={key++} className="md-li">{renderInline(lines[i].replace(NUMBERED, ''), key)}</li>)
        i++
      }
      blocks.push(<ol key={key++} className="md-ol" start={start === 1 ? undefined : start}>{items}</ol>)
      continue
    }
    if (!line.trim()) { i++; continue }

    const para = []
    while (i < lines.length && lines[i].trim() && !PARA_BREAK.test(lines[i])) {
      para.push(lines[i])
      i++
    }
    // A lone "|" line that isn't a table would otherwise loop forever.
    if (!para.length) { para.push(lines[i]); i++ }
    blocks.push(<p key={key++} className="md-p">{renderInline(para.join(' '), key)}</p>)
  }

  return <>{blocks}</>
}
