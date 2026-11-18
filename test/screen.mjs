// node test/screen.mjs <raw> <cols> <rows> [cutMarker]  -> prints the reconstructed screen at the last frame boundary
import fs from 'node:fs'
import { emulate } from './vt.mjs'
const [raw, cols, rows, upto] = process.argv.slice(2)
let d = fs.readFileSync(raw, 'utf8')
const exitAt = d.lastIndexOf('\x1b[?1049l')
if (upto === 'beforeExit' && exitAt > 0) d = d.slice(0, exitAt)
else if (upto && /^\d+$/.test(upto)) { // nth frame end
  let idx = -1; for (let k = 0; k < +upto; k++) { idx = d.indexOf('\x1b[?2026l', idx + 1); if (idx < 0) break }
  if (idx > 0) d = d.slice(0, idx + 8)
}
const r = emulate(d, +cols, +rows)
console.log(r.text)
console.error(JSON.stringify({ modes: r.modes, frames: r.frames }))
