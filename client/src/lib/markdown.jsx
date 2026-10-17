// Tiny safe markdown renderer — builds React elements directly (no innerHTML),
// so agent/user content can never inject markup. Supports paragraphs, bold,
// inline code, italics, fenced code blocks, headings, tables, rules and lists.
import React from 'react'

function renderInline(text, keyBase) {
  const parts = []
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\b_[^_]+_\b)/g
  let last = 0
  let match
  let i = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('**')) parts.push(<strong key={`${keyBase}-b${i++}`}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('`')) parts.push(<code key={`${keyBase}-c${i++}`}>{token.slice(1, -1)}</code>)
    else parts.push(<em key={`${keyBase}-i${i++}`}>{token.slice(1, -1)}</em>)
    last = match.index + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export function Markdown({ text }) {
  if (!text) return null
  const blocks = []
  const lines = String(text).split('\n')
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trimStart().startsWith('```')) {
      const code = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) { code.push(lines[i]); i++ }
      i++
      blocks.push(<pre key={key++}><code>{code.join('\n')}</code></pre>)
      continue
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push(<hr key={key++} />); i++; continue }

    // GitHub-style table: a | row followed by a |---| separator row.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++ }
      blocks.push(
        <div className="md-table" key={key++}><table>
          <thead><tr>{head.map((c, j) => <th key={j}>{renderInline(c, `${key}h${j}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{renderInline(c, `${key}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
        </table></div>
      )
      continue
    }

    if (/^#{1,6}\s/.test(line)) {
      blocks.push(<h3 key={key++}>{renderInline(line.replace(/^#{1,6}\s/, ''), key)}</h3>)
      i++
      continue
    }
    if (/^\s*[-*]\s/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
        items.push(<li key={key++}>{renderInline(lines[i].replace(/^\s*[-*]\s/, ''), key)}</li>)
        i++
      }
      blocks.push(<ul key={key++}>{items}</ul>)
      continue
    }
    if (/^\s*\d+\.\s/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        items.push(<li key={key++}>{renderInline(lines[i].replace(/^\s*\d+\.\s/, ''), key)}</li>)
        i++
      }
      blocks.push(<ol key={key++}>{items}</ol>)
      continue
    }
    if (!line.trim()) { i++; continue }

    const para = []
    while (i < lines.length && lines[i].trim() && !/^\s*[-*]\s|^#{1,6}\s|^\s*\d+\.\s|^\s*```|^\s*\||^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      para.push(lines[i])
      i++
    }
    blocks.push(<p key={key++}>{renderInline(para.join(' '), key)}</p>)
  }

  return <>{blocks}</>
}
