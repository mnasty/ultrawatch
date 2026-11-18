// Minimal VT100 screen emulator, enough to reconstruct what a terminal would show from ultrawatch's TUI output.
// Supports: CUP (ESC[r;cH / ESC[H), EL (ESC[K), ED (ESC[J, ESC[2J), SGR (ignored), DEC private modes (tracked), CR, LF,
// deferred autowrap, wide characters. Returns the screen text plus flags (alt screen, cursor visibility).
import { strWidth } from '../ultrawatch.mjs'
export function emulate(data, cols, rows) {
  const blank = () => Array.from({ length: cols }, () => ' ')
  let screen = Array.from({ length: rows }, blank)
  let r = 0, col = 0, wrapPending = false
  const modes = { alt: false, cursor: true, sync: false }
  let frames = 0, maxRowWritten = 0
  const scroll = () => { screen.shift(); screen.push(blank()) }
  let i = 0
  while (i < data.length) {
    const ch = data[i]
    if (ch === '\x1b') {
      const m = /^\x1b\[(\?)?([0-9;]*)([A-Za-z~])/.exec(data.slice(i, i + 32))
      if (!m) { i++; continue }
      i += m[0].length
      const priv = !!m[1], args = m[2] ? m[2].split(';').map(Number) : [], fin = m[3]
      if (priv && (fin === 'h' || fin === 'l')) {
        const on = fin === 'h'
        for (const a of args) { if (a === 1049) { modes.alt = on; if (on) screen = Array.from({ length: rows }, blank) } else if (a === 25) modes.cursor = on; else if (a === 2026) { modes.sync = on; if (!on) frames++ } }
        continue
      }
      if (fin === 'H') { r = Math.max(0, (args[0] || 1) - 1); col = Math.max(0, (args[1] || 1) - 1); wrapPending = false }
      else if (fin === 'K') { for (let k = col; k < cols; k++) screen[r][k] = ' ' }
      else if (fin === 'J') {
        if (args[0] === 2) screen = Array.from({ length: rows }, blank)
        else { for (let k = col; k < cols; k++) screen[r][k] = ' '; for (let rr = r + 1; rr < rows; rr++) screen[rr] = blank() }
      }
      continue
    }
    if (ch === '\r') { col = 0; wrapPending = false; i++; continue }
    if (ch === '\n') { r++; wrapPending = false; if (r >= rows) { r = rows - 1; scroll() } i++; continue }
    const cp = data.codePointAt(i)
    const s = String.fromCodePoint(cp)
    i += s.length
    const w = strWidth(s)
    if (w === 0) continue
    if (wrapPending || col + w > cols) { col = 0; r++; wrapPending = false; if (r >= rows) { r = rows - 1; scroll() } }
    screen[r][col] = s
    if (w === 2 && col + 1 < cols) screen[r][col + 1] = ''
    col += w
    maxRowWritten = Math.max(maxRowWritten, r)
    if (col >= cols) { col = cols - 1; wrapPending = true }
  }
  return { text: screen.map((l) => l.join('').trimEnd()).join('\n'), modes, frames }
}
