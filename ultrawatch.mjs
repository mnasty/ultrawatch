#!/usr/bin/env node
// ultrawatch: live terminal tracker for Claude Code workflow ("ultracode") runs.
// Single file, no dependencies, node >= 18. Strictly read-only: it never writes to disk.
// See README.md next to this file for usage, keys and column meanings.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const VERSION = '1.0.0'
export const STALL_MS = 3 * 60_000 // running agent with no transcript activity for this long = stalled
export const IDLE_MS = 20 * 60_000 // run with no json and no file activity for this long = idle (probably dead)
export const PENDING_MAX_MS = 2 * 3600_000 // ...unless an agent is still waiting on a tool call started less than this long ago
const EVENTS_PER_AGENT = 800
const FEED_KINDS = new Set(['tool', 'toolerr', 'text', 'error', 'limit', 'start', 'done', 'fail', 'user', 'status'])

// ───────────────────────── clock (frozen in tests via ULTRAWATCH_NOW) ─────────────────────────
function frozenNow() {
  const v = process.env.ULTRAWATCH_NOW
  if (!v) return null
  return isNaN(+v) ? Date.parse(v) : +v
}
let FROZEN = frozenNow()
export const now = () => (FROZEN ?? Date.now())
/** Tests only: freeze the clock at ms (null = real time). */
export function setClock(ms) { FROZEN = ms }

// ───────────────────────── colours and text width ─────────────────────────
let COLOR = true
export function setColor(on) { COLOR = !!on }
const SGR = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s))
export const c = {
  dim: SGR('2'), bold: SGR('1'), ital: SGR('3'), inv: SGR('7'),
  red: SGR('31'), green: SGR('32'), yellow: SGR('33'), blue: SGR('34'), magenta: SGR('35'), cyan: SGR('36'),
  gray: SGR('90'), white: SGR('97'), bred: SGR('1;31'), bgreen: SGR('1;32'), bcyan: SGR('1;36'), byellow: SGR('1;33'),
  banner: SGR('1;97;41'), warnBanner: SGR('1;30;43'), sel: SGR('7'),
}
const TAG_COLORS = ['36', '35', '33', '32', '34', '96', '95', '93', '92', '94', '91']
export function tagColor(s) {
  let h = 0
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) >>> 0
  const code = TAG_COLORS[h % TAG_COLORS.length]
  return (t) => (COLOR ? `\x1b[${code}m${t}\x1b[0m` : String(t))
}

const ANSI_STICKY = /\x1b\[[0-9;?]*[A-Za-z]/y
const ANSI_ALL = /\x1b\[[0-9;?]*[A-Za-z]/g
export function stripAnsi(s) { return String(s).replace(ANSI_ALL, '') }
// Terminal column width per code point. Emoji with default emoji presentation (✅ ❌ ⚡ ✨ 🚀 🫠 …) and East Asian
// wide/fullwidth characters take 2 columns; combining marks, joiners, variation selectors, skin-tone modifiers and tag
// characters take 0. Everything else (including text-presentation symbols like ✓ ✗ ⚠ ▶) takes 1.
const EMOJI_PRES = /\p{Emoji_Presentation}/u
const EXT_PICT = /\p{Extended_Pictographic}/u
function cw(cp) {
  if (cp < 0x300) return 1
  if (cp <= 0x36f) return 0
  if (cp < 0x1100) return 1
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfe0f || cp === 0xfe0e || cp === 0x20e3) return 0
  if ((cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe20 && cp <= 0xfe2f)) return 0
  if ((cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0xe0000 && cp <= 0xe007f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)) return 2
  if (cp >= 0x231a && EMOJI_PRES.test(String.fromCodePoint(cp))) return 2
  return 1
}
/** A text-presentation pictograph followed by VS16 (U+FE0F, e.g. ⚠️ ❤️) is drawn as a 2-column emoji. */
function vs16Wide(cp, k, next) { return k === 1 && next === 0xfe0f && cp >= 0xa9 && EXT_PICT.test(String.fromCodePoint(cp)) }
export function strWidth(s) {
  s = stripAnsi(s)
  let w = 0, prevK = 0, prevCp = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (cp === 0xfe0f && vs16Wide(prevCp, prevK, cp)) { w += 1; prevK = 2; prevCp = cp; continue }
    const k = cw(cp)
    w += k; prevK = k; prevCp = cp
  }
  return w
}
/** Makes emoji sequences render with a predictable width: drops joiners, variation selectors, skin tones and tag
 *  characters (a ZWJ family becomes its separate emoji), and turns flag letters (regional indicators) into ASCII. */
const NEEDS_TAMING = /[\u200d\u20e3\ufe0e\ufe0f\ud83c\udb40]/
export function tame(s) {
  s = String(s)
  if (!NEEDS_TAMING.test(s)) return s // fast path: no joiners, selectors, keycaps, flags/skin tones (U+1F1xx/1F3xx) or tags
  return s.replace(/[\u200d\ufe0e\ufe0f\u20e3\u{1f3fb}-\u{1f3ff}\u{e0000}-\u{e007f}]/gu, '')
    .replace(/[\u{1f1e6}-\u{1f1ff}]/gu, (ch) => String.fromCharCode(0x41 + ch.codePointAt(0) - 0x1f1e6))
}
/** Cut s to at most max visible columns, keeping ANSI codes, ending with … when cut. */
export function trunc(s, max) {
  s = String(s)
  if (max <= 0) return ''
  if (strWidth(s) <= max) return s
  let out = '', w = 0, i = 0, ansi = false
  const target = max - 1
  while (i < s.length) {
    if (s.charCodeAt(i) === 27) {
      ANSI_STICKY.lastIndex = i
      const m = ANSI_STICKY.exec(s)
      if (m) { out += m[0]; i += m[0].length; ansi = true; continue }
    }
    const cp = s.codePointAt(i)
    let ch = String.fromCodePoint(cp)
    let k = cw(cp)
    if (vs16Wide(cp, k, s.codePointAt(i + ch.length))) { ch += '\ufe0f'; k = 2 }
    if (w + k > target) break
    out += ch; w += k; i += ch.length
  }
  return out + (ansi && COLOR ? '\x1b[0m' : '') + '…' + ' '.repeat(Math.max(0, target - w))
}
export function fit(s, w, right = false) {
  if (w <= 0) return ''
  s = trunc(s, w)
  const pad = Math.max(0, w - strWidth(s))
  return right ? ' '.repeat(pad) + s : s + ' '.repeat(pad)
}
/** Make untrusted transcript text safe and single-line: strips escapes and control characters. */
export function clean(s, max = 400) {
  if (s == null) return ''
  s = String(s)
  if (s.length > max * 6) s = s.slice(0, max * 6)
  s = tame(s).replace(ANSI_ALL, '').replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '').replace(/\s{2,}/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
function cleanMultiline(s, max = 2000) {
  if (s == null) return []
  s = String(s).slice(0, max)
  return tame(s).replace(ANSI_ALL, '').split(/\r?\n/).map((l) => l.replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '').trimEnd())
}

// ───────────────────────── formatting ─────────────────────────
export function fmtTok(n) {
  if (n == null || isNaN(n)) return '–'
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return (n / 1000).toFixed(1) + 'k'
  if (n < 999_500) return Math.round(n / 1000) + 'k'
  if (n < 10_000_000) return (n / 1e6).toFixed(2) + 'M'
  return (n / 1e6).toFixed(1) + 'M'
}
export function fmtDur(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '–'
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's'
  const h = Math.floor(m / 60)
  if (h < 48) return h + 'h' + String(m % 60).padStart(2, '0') + 'm'
  return Math.floor(h / 24) + 'd' + (h % 24) + 'h'
}
export function fmtAgo(ms) {
  if (ms == null || isNaN(ms)) return '–'
  if (ms < 1000) return 'now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  if (h < 48) return h + 'h'
  return Math.floor(h / 24) + 'd'
}
export function fmtClock(ts) {
  if (!ts) return '--:--:--'
  const d = new Date(ts)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':')
}
function fmtWhen(ts) {
  if (!ts) return '–'
  const d = new Date(ts), n = new Date(now())
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  if (d.toDateString() === n.toDateString()) return hm
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + hm
}
function fmtBytes(n) { return n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024).toFixed(1) + 'KB' : (n / 1048576).toFixed(1) + 'MB' }

/** claude-opus-5-5 -> opus-5.5, claude-sonnet-4-5-20250929 -> sonnet-4.5, claude-3-5-haiku-20241022 -> haiku-3.5 */
export function shortModel(m) {
  if (!m) return '?'
  let s = String(m)
  if (s === '<synthetic>') return 'synthetic'
  let suffix = ''
  const br = /\[([^\]]+)\]$/.exec(s)
  if (br) { suffix = '[' + br[1] + ']'; s = s.slice(0, br.index) }
  s = s.replace(/^.*?claude-/, '').replace(/-v\d+(?::\d+)?$/, '').replace(/@.*$/, '').replace(/-\d{8}$/, '').replace(/-latest$/, '')
  let x = /^([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(s)
  if (x) return x[1] + '-' + x[2] + (x[3] ? '.' + x[3] : '') + suffix
  x = /^(\d+)(?:-(\d{1,2}))?-([a-z]+)$/.exec(s)
  if (x) return x[3] + '-' + x[1] + (x[2] ? '.' + x[2] : '') + suffix
  return s + suffix
}

// ───────────────────────── safe JS-literal parser (for `export const meta = {...}`) ─────────────────────────
export function parseJsLiteral(src, start = 0) {
  let i = start
  const err = (m) => { throw new Error(m + ' at offset ' + i) }
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++
      if (src.startsWith('//', i)) { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j + 1; continue }
      if (src.startsWith('/*', i)) { const j = src.indexOf('*/', i + 2); if (j < 0) err('unterminated comment'); i = j + 2; continue }
      break
    }
  }
  const str = () => {
    const q = src[i++]
    let out = ''
    while (i < src.length) {
      const ch = src[i++]
      if (ch === q) return out
      if (q === '`' && ch === '$' && src[i] === '{') err('template expression')
      if (ch === '\\') {
        const e = src[i++]
        const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }
        if (e === 'u') {
          if (src[i] === '{') { const j = src.indexOf('}', i); out += String.fromCodePoint(parseInt(src.slice(i + 1, j), 16)); i = j + 1 }
          else { out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16)); i += 4 }
        } else if (e === 'x') { out += String.fromCharCode(parseInt(src.slice(i, i + 2), 16)); i += 2 }
        else if (e === '\n') { /* line continuation */ }
        else if (e === '\r') { if (src[i] === '\n') i++ }
        else out += map[e] ?? e
        continue
      }
      if (ch === '\n' && q !== '`') err('newline in string')
      out += ch
    }
    err('unterminated string')
  }
  const ident = () => {
    const re = /[A-Za-z_$][\w$]*/y
    re.lastIndex = i
    const r = re.exec(src)
    if (!r) err('unexpected ' + JSON.stringify(src[i] ?? 'EOF'))
    i += r[0].length
    return r[0]
  }
  const num = () => {
    const re = /[-+]?(?:0x[0-9a-f]+|(?:\d[\d_]*)?\.?\d*(?:e[-+]?\d+)?)/iy
    re.lastIndex = i
    const r = re.exec(src)
    if (!r || !r[0] || /^[-+.]*$/.test(r[0])) err('bad number')
    i += r[0].length
    return Number(r[0].replace(/_/g, ''))
  }
  const value = () => {
    ws()
    const ch = src[i]
    if (ch === '{') {
      i++
      const o = {}
      for (;;) {
        ws()
        if (src[i] === '}') { i++; return o }
        let k
        if (src[i] === '"' || src[i] === "'" || src[i] === '`') k = str()
        else if (/[0-9]/.test(src[i])) k = String(num())
        else k = ident()
        ws()
        if (src[i] !== ':') err('expected ":" (shorthand or computed keys are not literals)')
        i++
        o[k] = value()
        ws()
        if (src[i] === ',') { i++; continue }
        if (src[i] === '}') { i++; return o }
        err('expected "," or "}"')
      }
    }
    if (ch === '[') {
      i++
      const a = []
      for (;;) {
        ws()
        if (src[i] === ']') { i++; return a }
        a.push(value())
        ws()
        if (src[i] === ',') { i++; continue }
        if (src[i] === ']') { i++; return a }
        err('expected "," or "]"')
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') return str()
    if (ch === '-' || ch === '+' || ch === '.' || /[0-9]/.test(ch ?? '')) return num()
    const id = ident()
    if (id === 'true') return true
    if (id === 'false') return false
    if (id === 'null') return null
    if (id === 'undefined') return undefined
    err('identifier "' + id + '" is not a literal')
  }
  const v = value()
  return { value: v, end: i }
}

/** Extracts `export const meta = {...}` from a workflow script without evaluating it. */
export function extractMeta(text) {
  if (!text) return null
  const m = /export\s+const\s+meta\s*=\s*/.exec(text)
  if (!m) return null
  try {
    const v = parseJsLiteral(text, m.index + m[0].length).value
    return v && typeof v === 'object' ? v : null
  } catch (e) {
    // best effort: pull the obvious string fields out of the first ~3 KB
    const seg = text.slice(m.index, m.index + 3000)
    const strRe = (k) => new RegExp(k + "\\s*:\\s*(['\"`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1")
    const name = strRe('name').exec(seg), desc = strRe('description').exec(seg)
    const phases = [...seg.matchAll(/title\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((x) => ({ title: x[2] }))
    return { name: name?.[2], description: desc?.[2], phases, _parseError: e.message }
  }
}

/** Marks which characters of JS source are code (1) rather than string/template text or comments (0). */
export function codeMask(src) {
  const mask = new Uint8Array(src.length)
  const stack = [] // template nesting: each entry = brace depth inside ${ }
  let i = 0, mode = 'code', depth = 0
  while (i < src.length) {
    const ch = src[i]
    if (mode === 'code') {
      if (ch === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue }
      if (ch === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? src.length : j + 2; continue }
      if (ch === "'" || ch === '"') { mode = ch; mask[i] = 1; i++; continue }
      if (ch === '`') { mode = '`'; mask[i] = 1; i++; continue }
      if (ch === '{') depth++
      if (ch === '}') {
        if (stack.length && depth === stack[stack.length - 1]) { stack.pop(); mode = '`'; mask[i] = 1; i++; continue }
        depth--
      }
      mask[i] = 1; i++; continue
    }
    if (ch === '\\') { i += 2; continue }
    if (mode === '`' && ch === '$' && src[i + 1] === '{') { stack.push(depth); mode = 'code'; i += 2; continue }
    if (ch === mode) { mask[i] = 1; mode = 'code'; i++; continue }
    if (ch === '\n' && mode !== '`') mode = 'code'
    i++
  }
  return mask
}

/** Rough count of agent() calls per phase in a script (a lower-bound estimate: loops/helpers are not expanded). */
export function estimateAgents(text) {
  if (!text) return null
  const metaAt = /export\s+const\s+meta\s*=/.exec(text)
  let from = 0
  if (metaAt) { try { from = parseJsLiteral(text, metaAt.index + metaAt[0].length).end } catch { from = 0 } }
  const mask = codeMask(text)
  const isCode = (i) => i >= from && mask[i] === 1
  const marks = []
  for (const m of text.matchAll(/\bphase\(\s*(['"`])([^'"`]+)\1\s*\)/g)) if (isCode(m.index)) marks.push({ i: m.index, phase: m[2] })
  const per = {}
  let total = 0
  for (const m of text.matchAll(/(?<![\w.$])agent\s*\(/g)) {
    if (!isCode(m.index)) continue
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue
    let ph = null
    for (const mk of marks) if (mk.i < m.index) ph = mk.phase
    total++
    if (ph) per[ph] = (per[ph] || 0) + 1
  }
  const code = [...text.slice(from)].filter((_, k) => mask[from + k]).join('')
  const loops = /\.map\(|\bfor\s*\(|Promise\.all|\bparallel\(|\bwhile\s*\(/.test(code)
  return { total, perPhase: per, loops }
}

// ───────────────────────── tool summaries, limits, progress files ─────────────────────────
const base = (p) => (p ? path.basename(String(p)) : '')
function shortToolName(n) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(n || '')
  return m ? m[1].replace(/^claude[-_]/, '') + ':' + m[2] : n || 'tool'
}
export function summarizeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {}
  let short, long
  switch (name) {
    case 'Bash': {
      const cmd = String(i.command ?? '')
      const first = cmd.split('\n').find((l) => l.trim()) || ''
      short = 'Bash: ' + (i.description ? clean(i.description, 200) : clean(first, 200))
      if (i.run_in_background) short += ' (bg)'
      long = 'Bash: ' + (i.description ? clean(i.description, 200) + '  $ ' : '$ ') + clean(cmd, 1200)
      break
    }
    case 'Read':
      short = 'Read ' + base(i.file_path) + (i.offset ? ':' + i.offset : '') + (i.pages ? ' p' + i.pages : '')
      long = 'Read ' + (i.file_path ?? '') + (i.offset ? ` offset ${i.offset}` : '') + (i.limit ? ` limit ${i.limit}` : '')
      break
    case 'Edit': case 'MultiEdit':
      short = name + ' ' + base(i.file_path)
      long = name + ' ' + (i.file_path ?? '') + (i.old_string != null ? '  "' + clean(i.old_string, 80) + '" → "' + clean(i.new_string, 80) + '"' : '') + (Array.isArray(i.edits) ? ` (${i.edits.length} edits)` : '')
      break
    case 'Write':
      short = 'Write ' + base(i.file_path) + (typeof i.content === 'string' ? ` (${fmtBytes(Buffer.byteLength(i.content))})` : '')
      long = 'Write ' + (i.file_path ?? '') + (typeof i.content === 'string' ? ` (${fmtBytes(Buffer.byteLength(i.content))})` : '')
      break
    case 'NotebookEdit': short = 'NotebookEdit ' + base(i.notebook_path); long = 'NotebookEdit ' + (i.notebook_path ?? ''); break
    case 'Glob': short = 'Glob ' + clean(i.pattern, 120) + (i.path ? ' in ' + base(i.path) : ''); long = 'Glob ' + clean(i.pattern, 300) + (i.path ? ' in ' + i.path : ''); break
    case 'Grep': short = 'Grep ' + clean(i.pattern, 120) + (i.path ? ' in ' + base(i.path) : ''); long = 'Grep ' + clean(i.pattern, 300) + (i.path ? ' in ' + i.path : '') + (i.glob ? ' glob ' + i.glob : ''); break
    case 'WebSearch': short = 'WebSearch ' + clean(i.query, 200); break
    case 'WebFetch':
      short = 'WebFetch ' + clean(String(i.url ?? '').replace(/^https?:\/\/(www\.)?/, ''), 200)
      long = 'WebFetch ' + clean(i.url, 400) + (i.prompt ? '  — ' + clean(i.prompt, 400) : '')
      break
    case 'Agent': case 'Task': short = 'Agent: ' + clean(i.description || i.prompt, 200); long = 'Agent (' + (i.subagent_type || 'general') + '): ' + clean(i.description, 200) + ' — ' + clean(i.prompt, 600); break
    case 'TodoWrite': short = `TodoWrite (${Array.isArray(i.todos) ? i.todos.length : 0} items)`; break
    case 'StructuredOutput': short = 'returning result'; long = 'StructuredOutput ' + clean(JSON.stringify(i), 800); break
    case 'Skill': short = 'Skill ' + clean(i.skill, 80) + (i.args ? ' ' + clean(i.args, 80) : ''); break
    case 'ToolSearch': short = 'ToolSearch ' + clean(i.query, 120); break
    case 'Monitor': short = 'Monitor ' + clean(i.description || i.command, 150); break
    case 'Artifact': short = 'Artifact ' + (i.action || 'publish') + ' ' + base(i.file_path || i.url); break
    case 'ReportFindings': short = `ReportFindings (${Array.isArray(i.findings) ? i.findings.length : 0})`; break
    case 'SendMessage': short = 'SendMessage → ' + clean(i.to, 60); break
    default: {
      const firstStr = Object.values(i).find((v) => typeof v === 'string' && v.trim())
      short = shortToolName(name) + (firstStr ? ' ' + clean(firstStr, 150) : '')
      long = shortToolName(name) + ' ' + clean(JSON.stringify(i), 800)
    }
  }
  return { short: clean(short, 300), long: clean(long || short, 1600) }
}

const LIMIT_RE = /(?:hit|reached) your (?:[\w-]+ )?limit|usage limit reached/i
/** Recognises usage/session-limit errors. `d` is the raw transcript line when available. */
export function parseLimit(text, d) {
  const api = d && (d.apiError === 'usage_limit_reached' || d.apiError === 'rate_limit_reached')
  if (!api && !LIMIT_RE.test(text || '')) return null
  const r = /resets?\s+(?:at\s+)?([^\n"·|]+?)\s*$/im.exec(text || '')
  const info = d?.apiErrorParams?.rate_limit_info || d?.quotaLimits || {}
  return {
    text: clean(text || d?.apiError || 'usage limit', 200),
    resets: r ? clean(r[1], 60) : null,
    resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
    limitType: info.rateLimitType || null,
  }
}

export function resultPreview(content) {
  let full = ''
  if (typeof content === 'string') full = content
  else if (Array.isArray(content)) {
    full = content.map((b) => {
      if (!b || typeof b !== 'object') return ''
      if (b.type === 'text') return b.text || ''
      if (b.type === 'image') return '[image]'
      if (b.type === 'tool_reference') return '[tool ' + (b.tool_name || '?') + ']'
      return '[' + (b.type || '?') + ']'
    }).join(' ')
  } else if (content != null) full = JSON.stringify(content)
  full = full.slice(0, 6000)
  return { short: clean(full, 300) || '(empty)', full }
}

function resultText(r) {
  if (r == null) return ''
  if (typeof r === 'string') return r
  if (typeof r === 'object') {
    for (const k of ['summary', 'verdict', 'result', 'message', 'text']) if (typeof r[k] === 'string') return r[k]
    return JSON.stringify(r)
  }
  return String(r)
}

/** Progress-file candidates from an agent's prompt, ranked (lower tier wins):
 *   1  progress.md inside the agent's own folder ("your folder is …", "…/<your name>/") or named in its progress protocol
 *   2  findings.md inside the agent's own folder
 *   3  any other progress.md the prompt mentions (only used when the prompt declares no tier-1 file, and only once the
 *      file has been modified after the agent started)
 *  findings.md files elsewhere are inputs (another agent's findings) and are never used, unless the agent itself writes
 *  to them (tier 0, see Agent.observePaths). Placeholders like <your name> are resolved against the label. */
export function rankedProgressCandidates(prompt, label) {
  const out = []
  if (!prompt) return out
  const add = (p, tier) => {
    p = p.replace(/\/{2,}/g, '/')
    const e = out.find((x) => x.p === p)
    if (e) e.tier = Math.min(e.tier, tier)
    else out.push({ p, tier })
  }
  const protoIdx = prompt.search(/progress protocol/i)
  const inProto = (i) => protoIdx >= 0 && i >= protoIdx && i - protoIdx < 2500
  const own = []
  for (const m of prompt.matchAll(/folder is\s+(\/[^\s'"`<>]*?)\/<([^>]+)>/gi)) {
    let subs = []
    try { subs = fs.readdirSync(m[1], { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { /* not there yet */ }
    const toks = String(label || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1).sort((a, b) => b.length - a.length)
    const hit = subs.find((s) => toks.includes(s.toLowerCase())) || subs.find((s) => toks.some((t) => s.toLowerCase().includes(t) || t.includes(s.toLowerCase())))
    if (hit) own.push(m[1] + '/' + hit)
  }
  for (const m of prompt.matchAll(/folder is\s+(\/[^\s'"`<>]+)/gi)) {
    if (prompt[m.index + m[0].length] === '<') continue // "…/<your name>/", handled above
    own.push(m[1].replace(/[/.,;:]+$/, ''))
  }
  for (const d of own) { add(d + '/progress.md', 1); add(d + '/findings.md', 2) }
  const ownSet = new Set(own.map((d) => d.replace(/\/{2,}/g, '/')))
  for (const m of prompt.matchAll(/(?<![\w$}\]])(\/[^\s'"`<>()|,;$]+\/(?:progress|findings)\.md)\b/gi)) {
    const p = m[1], dir = path.dirname(p.replace(/\/{2,}/g, '/'))
    const findings = /findings\.md$/i.test(p)
    if (findings) { if (ownSet.has(dir)) add(p, 2); continue }
    add(p, ownSet.has(dir) || inProto(m.index) ? 1 : 3)
  }
  return out.sort((a, b) => a.tier - b.tier)
}
/** Candidate paths only, best first (kept for tests and --json). */
export function progressCandidates(prompt, label) { return rankedProgressCandidates(prompt, label).map((x) => x.p) }

/** Number of deliverables/items an agent was asked for, from its prompt (null if not stated). */
export function promptTotal(prompt) {
  if (!prompt) return null
  const t = /listing these items as todo:\s*([^\n]+)/i.exec(prompt)
  if (t) {
    const items = t[1].replace(/\.\s*$/, '').split(/\s+\|\s+/).filter((x) => x.trim())
    if (items.length) return items.length
  }
  const idx = prompt.search(/deliverables?[^\n]{0,40}:[ \t]*\n/i)
  if (idx < 0) return null
  const lines = prompt.slice(idx).split('\n').slice(1)
  let n = 0
  for (const l of lines) {
    const mm = /^\s*(\d+)[.)]\s+\S/.exec(l)
    if (mm) { if (+mm[1] === n + 1) { n++; continue } break }
    if (!l.trim() || /^\s+\S/.test(l) || /^\s*[-*•]/.test(l)) continue
    if (n) break
  }
  return n || null
}

/** Parses a progress.md / findings.md. */
export function parseProgress(text, promptN, isFindings = false) {
  const done = [], todo = []
  let findings = 0, sections = 0
  for (const raw of String(text).split('\n')) {
    const t = raw.trim()
    let m
    if ((m = /^(?:[-*]\s*)?(?:\[[xX]\]\s*)?done\s*[:–-]\s*(.*)$/i.exec(t))) done.push(m[1])
    else if ((m = /^(?:[-*]\s*)?todo\s*[:–-]\s*(.*)$/i.exec(t))) todo.push(m[1])
    else if ((m = /^[-*]\s*\[[xX]\]\s+(.*)$/.exec(t))) done.push(m[1])
    else if ((m = /^[-*]\s*\[ \]\s+(.*)$/.exec(t))) todo.push(m[1])
    else if (/^#{2,4}\s*(?:F|finding\s*#?)\d+\b/i.test(t)) findings++
    if (/^#{2,3}\s+\S/.test(t)) sections++
  }
  if (isFindings) findings = Math.max(findings, sections)
  const lastDone = done.length ? clean(done[done.length - 1], 300) : null
  if (todo.length) {
    const uniq = new Set(todo.map((x) => x.trim().toLowerCase())).size
    const total = Math.max(uniq, done.length)
    return { kind: 'items', done: done.length, total, last: lastDone }
  }
  // design agents often also log a final "done: report.json" line beyond the numbered deliverables
  if (done.length) return { kind: 'items', done: done.length, total: promptN ? Math.max(promptN, done.length) : null, last: lastDone }
  if (findings) return { kind: 'findings', done: findings, total: null, last: null }
  return { kind: 'empty', done: 0, total: promptN || null, last: null }
}

// ───────────────────────── incremental line reader ─────────────────────────
/** Reads only appended bytes of a growing file; delivers complete lines; keeps a partial trailing line for later. */
export class LineReader {
  constructor(file) {
    this.file = file
    this.offset = 0
    this.parts = []
    this.partLen = 0
    this.ino = null
    this.size = 0
    this.mtimeMs = 0
    this.exists = false
    this.error = null
    this.skipping = false
    this.resets = 0
  }
  /** Returns the number of bytes consumed. onLine receives a Buffer that is only valid during the call. */
  poll(onLine) {
    let st
    try { st = fs.statSync(this.file) } catch (e) {
      this.exists = false
      if (e.code !== 'ENOENT') this.error = `${e.code}: ${this.file}`
      return 0
    }
    this.exists = true
    this.mtimeMs = st.mtimeMs
    if (this.ino !== null && (st.ino !== this.ino || st.size < this.offset)) {
      this.offset = 0; this.parts = []; this.partLen = 0; this.skipping = false; this.resets++
      if (this.onReset) this.onReset()
    }
    this.ino = st.ino
    this.size = st.size
    if (st.size <= this.offset) return 0
    let fd
    try { fd = fs.openSync(this.file, 'r') } catch (e) { this.error = `${e.code}: ${this.file}`; return 0 }
    this.error = null
    let total = 0
    try {
      const buf = Buffer.allocUnsafe(Math.min(8 << 20, st.size - this.offset))
      while (this.offset < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - this.offset), this.offset)
        if (n <= 0) break
        this.offset += n
        total += n
        this._feed(buf.subarray(0, n), onLine)
      }
    } catch (e) {
      this.error = `${e.code || 'ERR'}: ${this.file}`
    } finally { try { fs.closeSync(fd) } catch {} }
    return total
  }
  _feed(chunk, onLine) {
    let start = 0
    for (;;) {
      const nl = chunk.indexOf(10, start)
      if (nl < 0) break
      let line = chunk.subarray(start, nl)
      if (this.parts.length) { this.parts.push(line); line = Buffer.concat(this.parts); this.parts = []; this.partLen = 0 }
      if (this.skipping) this.skipping = false
      else if (line.length) { try { onLine(line) } catch { /* a bad line never kills the reader */ } }
      start = nl + 1
    }
    if (start < chunk.length && !this.skipping) {
      const rest = Buffer.from(chunk.subarray(start)) // copy: the read buffer is reused
      this.parts.push(rest)
      this.partLen += rest.length
      if (this.partLen > 256 << 20) { this.parts = []; this.partLen = 0; this.skipping = true }
    }
  }
  get pending() { return this.partLen }
}

// ───────────────────────── agent (one transcript) ─────────────────────────
let SEQ = 0
export class Agent {
  constructor(run, id) {
    this.run = run
    this.id = id
    this.file = path.join(run.dir, `agent-${id}.jsonl`)
    this.metaFile = path.join(run.dir, `agent-${id}.meta.json`)
    this.reader = new LineReader(this.file)
    this.reader.onReset = () => this.resetState()
    this.meta = null
    this.label = null
    this.phase = null
    this.model = null
    this.attModel = null
    this.reqModel = null
    this.firstTs = null
    this.lastTs = null
    this.lastReqTs = null
    this.msgOut = new Map()
    this.toolIds = new Set()
    this.outTokens = 0
    this.ctx = 0
    this.lastOut = 0
    this.processed = 0
    this.toolCalls = 0
    this.toolErrors = 0
    this.bad = 0
    this.pending = new Map()
    this.events = []
    this.prompt = null
    this.limit = null
    this.interrupted = null
    this.lastRealTs = null // last non-synthetic assistant line
    this.progress = null
    this._cands = null
    this._observed = []
    this._lastResolve = 0
    this._progMtime = 0
    this.version = 0
  }
  /** The transcript was truncated or replaced: forget everything derived from it. */
  resetState() {
    const keep = this.events.filter((e) => e.kind === 'start' || e.kind === 'done' || e.kind === 'fail')
    Object.assign(this, { model: null, attModel: null, reqModel: null, firstTs: null, lastTs: null, lastReqTs: null, outTokens: 0, ctx: 0, lastOut: 0, processed: 0, toolCalls: 0, toolErrors: 0, bad: 0, prompt: null, promptOpen: false, limit: null, interrupted: null, lastRealTs: null, _cands: null })
    this.msgOut = new Map(); this.toolIds = new Set(); this.pending = new Map(); this.events = keep
    this.run.version++
  }
  loadMeta() {
    if (this.meta) return
    try {
      this.meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'))
      this.label = this.meta.description ? clean(this.meta.description, 200) : null
      this.phase = this.meta.workflowPhase ? clean(this.meta.workflowPhase, 100) : null
    } catch (e) { if (e.code && e.code !== 'ENOENT') this.run.noteError(`${e.code}: ${this.metaFile}`) }
  }
  poll() {
    this.loadMeta()
    const n = this.reader.poll((b) => this.onLine(b))
    if (this.reader.error) this.run.noteError(this.reader.error)
    this.refreshProgress()
    return n > 0
  }
  push(ev) {
    ev.seq = ++SEQ
    ev.agent = this
    if (!ev.ts) ev.ts = this.lastTs || now()
    this.events.push(ev)
    if (this.events.length > EVENTS_PER_AGENT * 1.25) this.events.splice(0, this.events.length - EVENTS_PER_AGENT)
    this.version++
    this.run.version++
  }
  onLine(buf) {
    // API request bookkeeping lines are huge and irrelevant: only peek at the model/timestamp of "api-request" itself.
    if (buf.length > 21 && buf[0] === 123 && buf[1] === 34 && buf.toString('latin1', 0, 20) === '{"type":"api-request') {
      if (buf[20] === 34) {
        const head = buf.toString('utf8', 0, Math.min(buf.length, 4000))
        const m = /"model":"([^"]+)"/.exec(head)
        if (m) this.reqModel = m[1]
        const t = /"timestamp":"([^"]+)"/.exec(head)
        if (t) { const ts = Date.parse(t[1]); if (ts && (!this.lastReqTs || ts > this.lastReqTs)) this.lastReqTs = ts }
      }
      return
    }
    let d
    try { d = JSON.parse(buf.toString('utf8')) } catch { this.bad++; return }
    if (d && typeof d === 'object') this.ingest(d)
  }
  ingest(d) {
    const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) || null : null
    if (ts) {
      if (!this.firstTs || ts < this.firstTs) this.firstTs = ts
      if (!this.lastTs || ts > this.lastTs) this.lastTs = ts
    }
    if (d.type === 'assistant') this.onAssistant(d, ts)
    else if (d.type === 'user') this.onUser(d, ts)
    else if (d.type === 'attachment') {
      const a = d.attachment
      if (a && a.type === 'model' && a.identity?.modelId) this.attModel = a.identity.modelId
    } else if (d.type === 'system' && (d.level === 'error' || d.subtype === 'api_error')) {
      this.push({ ts, kind: 'error', text: clean(d.content || d.error || d.subtype, 300) })
    }
  }
  onAssistant(d, ts) {
    const m = d.message || {}
    const content = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []
    if (m.model === '<synthetic>' || d.apiError || d.isApiErrorMessage) {
      this.promptOpen = false
      const text = content.map((b) => b?.text || '').join(' ').trim()
      const lim = parseLimit(text, d)
      if (lim) {
        this.limit = { ...lim, ts: ts || now() }
        this.run.noteLimit(this.limit)
        this.push({ ts, kind: 'limit', text: lim.text })
      } else this.push({ ts, kind: 'error', text: clean(text || d.apiError || 'API error', 300) })
      return
    }
    if (m.model) this.model = m.model
    if (ts) this.lastRealTs = ts
    this.promptOpen = false
    const u = m.usage
    if (u && m.id) {
      const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
      const out = u.output_tokens || 0
      // Lines are written per content block with a streaming snapshot of usage, so output_tokens is often a
      // small partial count. Estimate from the visible content (≈4 chars/token) and take the larger.
      let chars = 0
      for (const b of content) {
        if (b?.type === 'text') chars += (b.text || '').length
        else if (b?.type === 'tool_use') chars += JSON.stringify(b.input ?? {}).length + 20
        else if (b?.type === 'thinking') chars += (b.thinking || '').length
      }
      let rec = this.msgOut.get(m.id)
      if (!rec) { rec = { rep: 0, chars: 0, contrib: 0 }; this.msgOut.set(m.id, rec); this.processed += inTok }
      rec.rep = Math.max(rec.rep, out)
      rec.chars += chars
      const contrib = Math.max(rec.rep, Math.ceil(rec.chars / 4))
      this.outTokens += contrib - rec.contrib
      rec.contrib = contrib
      this.ctx = inTok
      this.lastOut = out
    }
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        if (b.id && this.toolIds.has(b.id)) continue
        if (b.id) this.toolIds.add(b.id)
        this.toolCalls++
        const s = summarizeTool(b.name, b.input)
        this.pending.set(b.id, { name: b.name, summary: s, ts })
        this.observePaths(b.name, b.input)
        this.push({ ts, kind: 'tool', tool: b.name, text: s.short, detail: s.long, id: b.id })
      } else if (b.type === 'text') {
        const t = clean(b.text, 600)
        if (t) this.push({ ts, kind: 'text', text: t, full: String(b.text).slice(0, 6000) })
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        this.push({ ts, kind: 'thinking', text: clean(b.thinking || '', 300) })
      }
    }
  }
  onUser(d, ts) {
    if (d.isMeta) return
    const ct = d.message?.content
    if (typeof ct === 'string') return this.onUserText(ct, ts)
    if (!Array.isArray(ct)) return
    const texts = []
    for (const b of ct) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'tool_result') {
        const p = this.pending.get(b.tool_use_id)
        this.pending.delete(b.tool_use_id)
        const name = p?.name || 'tool'
        const pr = resultPreview(b.content)
        const isErr = !!b.is_error
        if (isErr) {
          this.toolErrors++
          const lim = /hit your (?:[\w-]+ )?limit/i.test(pr.full) ? parseLimit(pr.full) : null
          if (lim) { this.limit = { ...lim, ts: ts || now() }; this.run.noteLimit(this.limit) }
        }
        this.push({ ts, kind: isErr ? 'toolerr' : 'result', tool: name, text: pr.short, full: pr.full, id: b.tool_use_id, dur: p?.ts && ts ? ts - p.ts : null })
      } else if (b.type === 'text' && b.text) texts.push(b.text)
    }
    if (texts.length) this.onUserText(texts.join('\n'), ts)
  }
  onUserText(text, ts) {
    // Everything the agent is told before its first reply is its prompt (the workflow harness sends it in several
    // messages: relayed user request, computed task, ...). Harness blocks indent their payload by two spaces.
    if (this.prompt == null || this.promptOpen) {
      const body = /^\[Workflow harness/.test(text) ? text.replace(/^ {2}/gm, '') : text
      this.prompt = ((this.prompt ? this.prompt + '\n\n' : '') + body).slice(0, 400_000)
      this.promptOpen = true
      this._cands = null
      this._lastResolve = 0
      const ev = this.events.find((e) => e.kind === 'prompt')
      const label = `prompt (${this.prompt.length.toLocaleString('en-US')} chars)`
      if (ev) { ev.text = label; ev.full = this.prompt.slice(0, 6000) }
      else this.push({ ts, kind: 'prompt', text: label, full: this.prompt.slice(0, 6000) })
      return
    }
    if (/^\s*\[Request interrupted/.test(text)) {
      this.interrupted = ts || now()
      this.push({ ts, kind: 'error', text: 'interrupted (run stopped)' })
      return
    }
    this.push({ ts, kind: 'user', text: 'message: ' + clean(text, 300), full: text.slice(0, 6000) })
  }
  observePaths(name, input) {
    if (!input || typeof input !== 'object') return
    const add = (p) => { if (p && !this._observed.includes(p)) { this._observed.push(p); this._lastResolve = 0 } }
    if ((name === 'Write' || name === 'Edit' || name === 'MultiEdit') && /\/(?:progress|findings)\.md$/i.test(input.file_path || '')) add(input.file_path)
    if (name === 'Bash' && typeof input.command === 'string') {
      // only files the command writes: `>> file`, `> file`, `tee [-a] file`
      for (const m of input.command.matchAll(/(?:>>?|\btee\s+(?:-a\s+)?)\s*['"]?(\/[^\s'"`$<>|;&()]+\/(?:progress|findings)\.md)\b/gi)) add(m[1])
    }
  }
  /** Picks the agent's progress file: the best-ranked candidate that exists, re-checked every few seconds so the bar
   *  moves to the agent's own file as soon as it is created. */
  pickProgress() {
    // a "<your name>" folder only resolves once the agent has created it: keep retrying until it does
    if (this._cands && this._cands.unresolved) this._cands = null
    if (!this._cands && this.prompt != null) {
      this._cands = rankedProgressCandidates(this.prompt, this.label || this.run.slotFor(this.id)?.label)
      if (/folder is\s+\/[^\s'"`<>]*?\/</i.test(this.prompt) && !this._cands.some((x) => x.tier <= 2)) this._cands.unresolved = true
    }
    const cands = [...this._observed.map((p) => ({ p, tier: 0 })), ...(this._cands || [])]
    if (!cands.length) return null
    const hasTier1 = cands.some((x) => x.tier <= 1)
    const start = this.firstTs || 0
    let best = null
    for (const x of cands) {
      if (best && x.tier >= best.tier) continue
      if (x.tier === 3 && hasTier1) continue
      let st
      try { st = fs.statSync(x.p) } catch { continue }
      if (!st.isFile()) continue
      if (x.tier === 3 && start && st.mtimeMs < start - 60_000) continue
      best = x
    }
    if (best) return { path: best.p, tier: best.tier, exists: true }
    const want = cands.filter((x) => x.tier !== 3 || !hasTier1).sort((a, b) => a.tier - b.tier)[0] || cands[0]
    return { path: want.p, tier: want.tier, exists: false }
  }
  refreshProgress() {
    const t = now()
    if (t - this._lastResolve > 3000 || !this._lastResolve) {
      this._lastResolve = t || 1
      const pick = this.pickProgress()
      if (pick && (!this.progress || pick.path !== this.progress.path || pick.exists !== !!this.progress.exists)) {
        this.progress = pick.exists ? { path: pick.path, tier: pick.tier, exists: true } : { path: pick.path, tier: pick.tier, exists: false }
        this._progMtime = 0
        this.run.version++
      } else if (!pick && this.progress) this.progress = null
    }
    if (this.progress?.exists) {
      try {
        const st = fs.statSync(this.progress.path)
        if (st.mtimeMs !== this._progMtime) {
          this._progMtime = st.mtimeMs
          const text = fs.readFileSync(this.progress.path, 'utf8')
          const kindHint = /findings\.md$/i.test(this.progress.path) ? 'findings' : null
          const p = parseProgress(text, kindHint ? null : promptTotal(this.prompt), !!kindHint)
          if (kindHint && p.kind === 'empty') p.kind = 'findings'
          const prev = this.progress
          this.progress = { ...p, path: prev.path, tier: prev.tier, exists: true, mtimeMs: st.mtimeMs }
          if (prev.done != null && p.done > prev.done && p.last) this.push({ ts: st.mtimeMs, kind: 'text', text: '✔ progress: ' + p.last, progress: true })
          this.run.version++
        }
      } catch (e) {
        if (e.code === 'ENOENT') this.progress = { path: this.progress.path, tier: this.progress.tier, exists: false }
        else this.run.noteError(`${e.code || 'ERR'}: ${this.progress.path}`)
      }
    }
  }
  get modelName() { return this.model || this.attModel || this.reqModel || null }
  lastSeen() { return Math.max(this.lastTs || 0, this.lastReqTs || 0) || null }
  activity() {
    if (this.reader.error) return { text: 'unreadable (' + this.reader.error.split(':')[0] + ')', ts: null, state: 'error' }
    let e = null
    for (let i = this.events.length - 1; i >= 0; i--) {
      const k = this.events[i].kind
      if (k === 'tool' || k === 'result' || k === 'toolerr' || k === 'text' || k === 'thinking' || k === 'error' || k === 'limit') { if (!this.events[i].progress) { e = this.events[i]; break } }
    }
    if (!e) return { text: this.reader.exists ? (this.prompt ? 'starting…' : 'loading…') : 'waiting for transcript…', ts: this.firstTs, state: 'idle' }
    let pend = null
    for (const p of this.pending.values()) if (!pend || (p.ts || 0) >= (pend.ts || 0)) pend = p
    if (pend && (pend.ts || 0) >= (e.ts || 0) - 1) return { text: pend.summary.short, ts: pend.ts, state: 'pending', tool: pend.name }
    if (e.kind === 'error' || e.kind === 'limit') return { text: e.text, ts: e.ts, state: 'error' }
    const generating = this.lastReqTs && this.lastReqTs >= (e.ts || 0)
    if (e.kind === 'thinking') return { text: 'thinking…', ts: e.ts, state: 'thinking' }
    if (e.kind === 'text') return { text: '“' + e.text + '”', ts: e.ts, state: generating ? 'thinking' : 'text' }
    if (e.kind === 'result' || e.kind === 'toolerr') {
      // find the call this result belongs to
      let call = null
      for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].kind === 'tool' && this.events[i].id === e.id) { call = this.events[i]; break }
      const what = (call ? call.text : e.tool) + (e.kind === 'toolerr' ? ' ✗' : ' ✓')
      if (generating) return { text: 'thinking… (after ' + what + ')', ts: this.lastReqTs, state: 'thinking' }
      return { text: what, ts: e.ts, state: e.kind === 'toolerr' ? 'after-error' : 'after-tool' }
    }
    return { text: e.text, ts: e.ts, state: 'tool' }
  }
}

// ───────────────────────── run (one workflow run directory) ─────────────────────────
function mapStatus(s) {
  s = String(s || '').toLowerCase()
  if (s === 'completed' || s === 'complete' || s === 'success' || s === 'succeeded' || s === 'done') return 'completed'
  if (s === 'killed' || s === 'aborted' || s === 'cancelled' || s === 'canceled' || s === 'stopped' || s === 'interrupted') return 'stopped'
  if (s === 'failed' || s === 'error' || s === 'errored') return 'failed'
  return s || 'unknown'
}

export class Run {
  constructor(info, opts = {}) {
    for (const k of ['runId', 'dir', 'sessionDir', 'sessionId', 'project', 'jsonPath']) this[k] = info[k]
    this.light = !!opts.light
    this.journal = new LineReader(path.join(this.dir, 'journal.jsonl'))
    this.slots = new Map()
    this.agents = new Map()
    this.agentSlot = new Map()
    this.keyAlias = new Map()
    this.final = null
    this.finalMtime = 0
    this.meta = null
    this.metaSource = null
    this.estimate = null
    this.scriptPath = null
    this._metaTry = 0
    this.errors = new Set()
    this.launches = 0
    this.journalBad = 0
    this.version = 0
    this.limit = null
    this.lastStatus = null
    this.statusEvents = []
    this.polled = false
  }
  noteError(msg) { if (msg && this.errors.size < 50 && !this.errors.has(msg)) { this.errors.add(msg); this.version++ } }
  noteLimit(lim) { if (!this.limit || (lim.ts || 0) >= (this.limit.ts || 0)) this.limit = lim }
  slotFor(agentId) { return this.agentSlot.get(agentId) }
  agent(id) {
    let a = this.agents.get(id)
    if (!a) { a = new Agent(this, id); this.agents.set(id, a) }
    return a
  }
  poll() {
    if (!this.light) {
      let ents = []
      try { ents = fs.readdirSync(this.dir) } catch (e) { if (e.code !== 'ENOENT') this.noteError(`${e.code}: ${this.dir}`) }
      for (const f of ents) { const m = /^agent-([\w-]+)\.jsonl$/.exec(f); if (m) this.agent(m[1]) }
      for (const a of this.agents.values()) a.poll()
    }
    this.journal.poll((b) => this.onJournal(b))
    if (this.journal.error) this.noteError(this.journal.error)
    this.loadFinal()
    this.loadMeta()
    this.polled = true
    const st = this.status()
    if (this.lastStatus && st !== this.lastStatus) this.pushStatus(`run ${st}`)
    this.lastStatus = st
  }
  pushStatus(text) {
    this.statusEvents.push({ seq: ++SEQ, ts: now(), kind: 'status', text, agent: null })
    this.version++
  }
  onJournal(buf) {
    let d
    try { d = JSON.parse(buf.toString('utf8')) } catch { this.journalBad++; return }
    if (!d || typeof d !== 'object') return
    const t = d.type
    if (t === 'launched') { this.launches++; return }
    if (d.label != null) d.label = clean(d.label, 200) || null
    if (d.phase != null) d.phase = clean(d.phase, 100) || null
    const key = d.key || (d.agentId ? 'agent:' + d.agentId : null)
    if (!key) return
    let s = this.slots.get(key) || this.keyAlias.get(key)
    if (!s && t === 'started' && d.label) {
      // a resume with an edited script gives the same agent a new key: treat it as a retry of the failed/unfinished slot
      for (const x of this.slots.values()) if (x.label === d.label && x.phase === (d.phase || x.phase) && (x.status === 'failed' || (x.status === 'running' && this.agents.get(x.attempts[x.attempts.length - 1])?.interrupted))) { s = x; break }
      if (s) { this.keyAlias.set(key, s); s.keys.push(key) }
    }
    if (!s) {
      s = { keys: [key], key, label: d.label || null, phase: d.phase || null, attempts: [], status: 'pending', result: undefined, error: null, sawStart: false, cached: false, order: this.slots.size }
      this.slots.set(key, s)
    }
    const a = d.agentId ? (this.light ? null : this.agent(d.agentId)) : null
    // Journal lines carry no timestamps. Lines that arrive while we watch are stamped with the time they were written
    // (the journal's mtime); the backlog read at start-up falls back to the agent's first/last transcript line.
    const live = this.polled
    const obs = this.journal.mtimeMs || now()
    if (d.agentId) {
      if (!s.attempts.includes(d.agentId)) s.attempts.push(d.agentId)
      this.agentSlot.set(d.agentId, s)
    }
    if (t === 'started') {
      s.label = d.label || s.label
      s.phase = d.phase || s.phase
      s.status = 'running'
      s.endObs = null
      s.sawStart = true
      s.result = undefined
      s.error = null
      if (a) a.push({ ts: live ? Math.min(obs, a.firstTs || obs) : a.firstTs || obs, kind: 'start', text: `started${s.phase ? ' · ' + s.phase : ''}${s.attempts.length > 1 ? ' · attempt ' + s.attempts.length : ''}` })
    } else if (t === 'result') {
      s.status = 'done'
      s.result = d.result
      s.endObs = live ? obs : null
      if (!s.sawStart) s.cached = true
      if (a) a.push({ ts: live ? Math.max(obs, a.lastTs || 0) : a.lastTs || obs, kind: 'done', text: (s.cached ? 'cached result: ' : 'finished: ') + clean(resultText(d.result), 300) })
    } else if (t === 'failed' || t === 'error' || t === 'errored') {
      s.status = 'failed'
      s.error = d.error || d.message || d.reason || null
      s.endObs = live ? obs : null
      if (a) a.push({ ts: live ? Math.max(obs, a.lastTs || 0) : a.lastTs || obs, kind: 'fail', text: 'failed' + (s.error ? ': ' + clean(s.error, 200) : a.limit ? ': ' + a.limit.text : '') })
    } else if (t === 'cached') {
      s.status = 'done'; s.cached = true; s.result = d.result
    }
    this.version++
  }
  loadFinal() {
    let st
    try { st = fs.statSync(this.jsonPath) } catch (e) {
      if (e.code !== 'ENOENT') this.noteError(`${e.code}: ${this.jsonPath}`)
      if (this.final) { this.final = null; this.finalMtime = 0; this.version++ }
      return
    }
    if (st.mtimeMs === this.finalMtime) return
    try {
      this.final = JSON.parse(fs.readFileSync(this.jsonPath, 'utf8'))
      this.finalMtime = st.mtimeMs
      this.version++
      // limit errors recorded in the run's logs (agents that failed on the limit)
      for (const l of Array.isArray(this.final.logs) ? this.final.logs : []) {
        if (typeof l === 'string' && LIMIT_RE.test(l)) { const lim = parseLimit(l); if (lim && !this.limit) this.limit = { ...lim, ts: this.final.timestamp ? Date.parse(this.final.timestamp) : st.mtimeMs } }
      }
    } catch (e) { this.noteError(`${e.code || 'bad json'}: ${this.jsonPath}`) }
  }
  loadMeta() {
    const labels = [...new Set([...this.slots.values()].map((x) => x.label).filter(Boolean))]
    if (this.meta && this.estimate && !(this.metaTentative && labels.length > this._metaLabels)) return
    const t = now()
    if (t - this._metaTry < 5000 && this._metaTry) return
    this._metaTry = t || 1
    let text = null
    if (this.final && typeof this.final.script === 'string') { text = this.final.script; this.metaSource = 'run json' }
    if (!text) {
      const found = this.findScript(labels)
      if (found) {
        try { text = fs.readFileSync(found.path, 'utf8'); this.scriptPath = found.path; this.metaSource = found.how; this.metaTentative = found.how === 'labels' } catch (e) { this.noteError(`${e.code}: ${found.path}`) }
      }
    }
    this._metaLabels = labels.length
    if (text) {
      this.meta = extractMeta(text) || {}
      this.estimate = estimateAgents(text)
      this.version++
    }
  }
  /** Finds the workflow script of this run. A run launched from an existing script (Workflow({scriptPath}), the usual
   *  resume/relaunch) gets a new runId but keeps the original script file name, so <name>-<runId>.js may not exist. */
  findScript(labels) {
    const p0 = this.final?.scriptPath
    if (p0 && fs.existsSync(p0)) return { path: p0, how: 'run json' }
    const sdir = path.join(this.sessionDir, 'workflows', 'scripts')
    let names = []
    try { names = fs.readdirSync(sdir).filter((n) => n.endsWith('.js')) } catch {}
    const exact = names.find((n) => n.endsWith(`-${this.runId}.js`) || n === `${this.runId}.js`)
    if (exact) return { path: path.join(sdir, exact), how: 'name' }
    // the session transcript records "<runId>\nScript file: <path>" in the Workflow tool's result
    const fromSession = this.scanSessionForScript()
    if (fromSession && fs.existsSync(fromSession)) return { path: fromSession, how: 'session transcript' }
    // last resort: the newest script that names every agent label seen so far
    if (!labels.length) return null
    let best = null
    for (const n of names) {
      const p = path.join(sdir, n)
      let st, txt
      try { st = fs.statSync(p); if (st.size > 4 << 20) continue; txt = fs.readFileSync(p, 'utf8') } catch { continue }
      const hits = labels.filter((l) => txt.includes(`'${l}'`) || txt.includes(`"${l}"`) || txt.includes('`' + l + '`')).length
      if (hits < labels.length) continue
      if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs }
    }
    return best ? { path: best.path, how: 'labels' } : null
  }
  scanSessionForScript() {
    const f = path.join(path.dirname(this.sessionDir), this.sessionId + '.jsonl')
    let st
    try { st = fs.statSync(f) } catch { return null }
    const from = this._sessScanned || 0
    if (st.size <= from) return null
    const needle = Buffer.from(this.runId + '\\nScript file: ')
    const CH = 8 << 20, OV = needle.length + 4096
    let fd
    try { fd = fs.openSync(f, 'r') } catch (e) { this.noteError(`${e.code}: ${f}`); return null }
    try {
      // newest first: the launch is usually near the end
      for (let end = st.size; end > from; ) {
        const start = Math.max(from, end - CH)
        const len = Math.min(st.size, end + OV) - start
        const buf = Buffer.allocUnsafe(len)
        const n = fs.readSync(fd, buf, 0, len, start)
        const at = buf.subarray(0, n).lastIndexOf(needle)
        if (at >= 0) {
          const rest = buf.toString('utf8', at + needle.length, Math.min(n, at + needle.length + 4096))
          const m = /^([^"\\\n]+?\.(?:m?js|ts))/.exec(rest)
          if (m) { this._sessScanned = st.size; return m[1] }
        }
        end = start
      }
    } catch (e) { this.noteError(`${e.code || 'ERR'}: ${f}`) } finally { try { fs.closeSync(fd) } catch {} }
    this._sessScanned = Math.max(0, st.size - OV)
    return null
  }
  journalMtime() { return this.journal.exists ? this.journal.mtimeMs : 0 }
  isFinished() {
    if (!this.final) return false
    if (!this.journal.exists) return true
    // a resumed run reuses the directory: the old json is stale once the journal is newer
    return this.finalMtime >= this.journalMtime() - 2000
  }
  lastActivity() {
    let t = Math.max(this.journalMtime(), this.isFinished() ? this.finalMtime : 0)
    for (const a of this.agents.values()) t = Math.max(t, a.reader.mtimeMs || 0, a.lastSeen() || 0)
    return t || null
  }
  status() {
    if (this.isFinished()) return mapStatus(this.final.status)
    const la = this.lastActivity()
    if (!la) return 'unknown'
    if (now() - la <= IDLE_MS) return 'running'
    // a long tool call (a test suite, a sub-agent, a Monitor) writes nothing while it runs
    const p = this.pendingSince()
    return p && now() - p < PENDING_MAX_MS ? 'running' : 'idle'
  }
  /** Start time of the newest tool call still waiting for its result, among agents that have not finished. */
  pendingSince() {
    let best = 0
    for (const a of this.agents.values()) {
      const s = this.agentSlot.get(a.id)
      if (s && s.status !== 'running') continue
      if (s && s.attempts[s.attempts.length - 1] !== a.id) continue
      for (const p of a.pending.values()) if ((p.ts || 0) > best) best = p.ts || 0
    }
    return best || null
  }
  /** Slots in display order, including agents seen on disk but not (yet) in the journal and cached agents from the run json. */
  slotList() {
    const list = [...this.slots.values()].sort((a, b) => a.order - b.order)
    for (const x of list) { x.inFinal = false; x.earlier = false }
    const fin = this.isFinished() ? this.final : null
    if (fin && Array.isArray(fin.workflowProgress)) {
      for (const p of fin.workflowProgress) {
        if (p.type !== 'workflow_agent') continue
        let s = p.agentId ? this.agentSlot.get(p.agentId) : null
        if (p.label != null) p.label = clean(p.label, 200)
        if (p.phaseTitle != null) p.phaseTitle = clean(p.phaseTitle, 100)
        if (!s) {
          s = list.find((x) => x.label === p.label && x.phase === (p.phaseTitle || x.phase) && !x.attempts.length)
          if (!s) {
            s = { key: 'json:' + (p.agentId || p.index), label: p.label, phase: p.phaseTitle, attempts: p.agentId ? [p.agentId] : [], status: p.state === 'done' ? 'done' : p.state === 'error' ? 'failed' : p.state === 'queued' ? 'pending' : 'running', fromJson: true, order: 1e6 + (p.index || 0) }
            list.push(s)
          }
        }
        if (p.cached) s.cached = true
        if (p.error && !s.error) s.error = p.error
        s.jsonModel = p.model
        if (p.agentId && s.attempts[s.attempts.length - 1] === p.agentId && p.startedAt && p.durationMs != null && !p.cached) {
          s.jsonStart = p.startedAt; s.jsonDur = p.durationMs
          // the harness knows when the agent really finished: move a backlog "finished" event there
          const a = this.agents.get(p.agentId)
          const end = p.startedAt + p.durationMs
          if (a && !s._endFixed) { s._endFixed = true; for (const e of a.events) if ((e.kind === 'done' || e.kind === 'fail') && e.ts < end) e.ts = end }
        }
        s.inFinal = true
      }
      // slots the final launch never touched belong to an earlier launch of a resumed run
      const anyFinal = list.some((x) => x.inFinal)
      if (anyFinal) for (const x of list) x.earlier = !x.inFinal
    }
    const seen = new Set(this.agentSlot.keys())
    const orphans = [...this.agents.values()].filter((a) => !seen.has(a.id)).sort((a, b) => (a.firstTs || 0) - (b.firstTs || 0))
    for (const a of orphans) list.push({ key: 'agent:' + a.id, label: a.label || a.id, phase: a.phase, attempts: [a.id], status: a.events.some((e) => e.kind === 'limit') ? 'failed' : 'running', orphan: true, order: 2e6 })
    return list
  }
  view() {
    const t = now()
    const status = this.status()
    const finished = this.isFinished()
    const meta = this.meta || {}
    const fin = finished ? this.final : null
    const slots = this.slotList().map((s) => this.slotView(s, status, t))
    // phases: from script meta, plus any phase names seen on agents
    const phases = []
    const metaPhases = Array.isArray(meta.phases) ? meta.phases : Array.isArray(this.final?.phases) ? this.final.phases : []
    for (const p of metaPhases) if (p && p.title) phases.push({ title: clean(p.title, 100), detail: p.detail ? clean(p.detail, 300) : '' })
    for (const s of slots) if (s.phase && !phases.some((p) => p.title === s.phase)) phases.push({ title: s.phase, detail: '' })
    const est = this.estimate
    for (const p of phases) {
      const ss = slots.filter((s) => s.phase === p.title && s.bucket !== 'earlier')
      p.total = ss.length
      for (const k of ['done', 'running', 'failed', 'stopped', 'pending']) p[k] = ss.filter((s) => s.bucket === k).length
      p.expected = est?.perPhase?.[p.title] || 0
    }
    let cur = null
    for (const s of slots) if (s.status === 'running' && s.phase) cur = s.phase
    if (!cur && !finished) for (const s of slots) if (s.phase) cur = s.phase
    for (const p of phases) p.current = p.title === cur
    const counts = { done: 0, running: 0, failed: 0, stopped: 0, pending: 0, earlier: 0 }
    for (const s of slots) counts[s.bucket]++
    const totals = { harnessTokens: 0, outTokens: 0, processed: 0, toolCalls: 0, toolCallsAll: 0, toolErrors: 0, apiCalls: 0 }
    for (const s of slots) {
      const a = s.agentId ? this.agents.get(s.agentId) : null
      if (a && !s.cached && !s.earlier) { totals.harnessTokens += a.ctx; totals.toolCalls += a.toolCalls }
    }
    for (const a of this.agents.values()) {
      totals.outTokens += a.outTokens; totals.processed += a.processed; totals.toolCallsAll += a.toolCalls; totals.toolErrors += a.toolErrors; totals.apiCalls += a.msgOut.size
    }
    if (fin) { totals.jsonTokens = fin.totalTokens ?? null; totals.jsonToolCalls = fin.totalToolCalls ?? null }
    const models = {}
    for (const s of slots) if (s.model) models[s.model] = (models[s.model] || 0) + 1
    const topModel = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] || null
    let startTs = fin?.startTime || null
    if (!startTs) {
      for (const s of slots) if (!s.cached && s.startTs && (!startTs || s.startTs < startTs)) startTs = s.startTs
    }
    const elapsedMs = fin?.durationMs ?? (startTs ? (finished ? (this.lastActivity() || t) - startTs : t - startTs) : null)
    // limit banner: is the most recent limit hit still "current" (no real model output after it)?
    let limit = null
    if (this.limit) {
      let after = false
      for (const a of this.agents.values()) if (a.lastRealTs && a.lastRealTs > (this.limit.ts || 0) + 1000) after = true
      limit = { ...this.limit, current: !after, at: this.limit.ts }
    }
    const expected = est ? Math.max(slots.length, est.total || 0) : slots.length
    return {
      runId: this.runId, name: clean(meta.name || fin?.workflowName || this.final?.workflowName || '', 120) || null,
      description: clean(meta.description || fin?.summary || this.final?.summary || '', 600), project: this.project, sessionId: this.sessionId,
      dir: this.dir, status, finished, startTs, elapsedMs, lastActivity: this.lastActivity(),
      defaultModel: fin?.defaultModel || this.final?.defaultModel || topModel, phases, slots, counts, expected,
      estimateLoops: !!est?.loops, totals, limit, errors: [...this.errors], journalBad: this.journalBad,
      launches: this.launches, jsonError: fin?.error ? clean(String(fin.error).split('\n')[0], 200) : null,
    }
  }
  slotView(s, runStatus, t) {
    const agentId = s.attempts[s.attempts.length - 1] || null
    const a = agentId ? this.agents.get(agentId) : null
    let status = s.status
    if (s.cached && status === 'done') status = 'cached'
    if (status === 'running' && runStatus !== 'running' && runStatus !== 'idle') status = 'stopped'
    if (status === 'running' && a && a.interrupted) status = 'stopped'
    const bucket = s.earlier ? 'earlier' : status === 'cached' ? 'done' : status === 'idle' ? 'running' : status
    const model = a?.modelName || s.jsonModel || null
    const assumed = !model && (this.final?.defaultModel || null)
    const startTs = s.jsonStart || a?.firstTs || null
    // a finished agent's time runs until the harness recorded its result (not just its last transcript line)
    const endTs = status === 'running' ? null : s.jsonDur != null ? s.jsonStart + s.jsonDur : Math.max(a?.lastTs || 0, s.endObs || 0) || null
    const elapsedMs = startTs ? (endTs || t) - startTs : null
    const act = a ? a.activity() : { text: s.cached ? 'cached (not re-run)' : 'no transcript', ts: null, state: 'idle' }
    const seen = a?.lastSeen() || null
    const sinceMs = seen ? t - seen : null
    const stalled = status === 'running' && runStatus === 'running' && sinceMs != null && sinceMs > STALL_MS
    let error = s.error ? clean(typeof s.error === 'string' ? s.error : JSON.stringify(s.error), 300) : null
    if (!error && status === 'failed' && a) {
      if (a.limit) error = a.limit.text
      else { const e = [...a.events].reverse().find((x) => x.kind === 'error' || x.kind === 'toolerr'); if (e) error = e.text }
    }
    const prog = a?.progress && a.progress.exists ? { kind: a.progress.kind, done: a.progress.done, total: a.progress.total, last: a.progress.last, path: a.progress.path } : a?.progress ? { kind: 'missing', path: a.progress.path, done: 0, total: null } : null
    return {
      key: s.key, label: s.label || a?.label || agentId || '?', phase: s.phase || a?.phase || null, status, bucket, idle: status === 'running' && runStatus === 'idle',
      attempts: s.attempts.length, agentIds: s.attempts, agentId, model, modelShort: model ? shortModel(model) : assumed ? '~' + shortModel(assumed) : null, modelAssumed: !!assumed,
      startTs, endTs, elapsedMs, outTokens: a?.outTokens ?? 0, ctx: a?.ctx ?? 0, toolCalls: a?.toolCalls ?? 0, toolErrors: a?.toolErrors ?? 0,
      apiCalls: a?.msgOut.size ?? 0, activity: act, lastSeen: seen, sinceMs, stalled, waitingOn: act.state === 'pending' ? act.tool : null,
      progress: prog, error, cached: !!s.cached, earlier: !!s.earlier, result: s.result !== undefined ? clean(resultText(s.result), 400) : null,
      limit: a?.limit || null, badLines: a?.bad || 0,
    }
  }
  /** Feed events (all agents of this run), sorted by time. */
  feed(n = 50, filter = null) {
    const all = []
    for (const a of this.agents.values()) {
      if (filter && !filter(a)) continue
      for (const e of a.events) if (FEED_KINDS.has(e.kind)) all.push(e)
    }
    if (!filter) all.push(...this.statusEvents)
    all.sort((x, y) => (x.ts - y.ts) || (x.seq - y.seq))
    return n ? all.slice(-n) : all
  }
}

// ───────────────────────── discovery ─────────────────────────
export function defaultRoot() { return process.env.ULTRAWATCH_ROOT || path.join(os.homedir(), '.claude', 'projects') }

export function discoverRuns(root) {
  const runs = [], errors = []
  let projects = []
  try { projects = fs.readdirSync(root, { withFileTypes: true }) } catch (e) { errors.push(`${e.code}: ${root}`); return { runs, errors } }
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const pdir = path.join(root, p.name)
    let sessions = []
    try { sessions = fs.readdirSync(pdir, { withFileTypes: true }) } catch (e) { errors.push(`${e.code}: ${pdir}`); continue }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const sdir = path.join(pdir, s.name)
      const wdir = path.join(sdir, 'subagents', 'workflows')
      const jdir = path.join(sdir, 'workflows')
      const ids = new Set()
      try { for (const r of fs.readdirSync(wdir)) if (/^wf_[\w-]+$/.test(r)) ids.add(r) } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') errors.push(`${e.code}: ${wdir}`) }
      try { for (const f of fs.readdirSync(jdir)) { const m = /^(wf_[\w-]+)\.json$/.exec(f); if (m) ids.add(m[1]) } } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') errors.push(`${e.code}: ${jdir}`) }
      for (const id of ids) runs.push({ runId: id, dir: path.join(wdir, id), sessionDir: sdir, sessionId: s.name, project: p.name, jsonPath: path.join(jdir, id + '.json') })
    }
  }
  return { runs, errors }
}

const STATUS_CACHE = new Map()
/** Cheap status (stats only, plus the small run json) for ranking runs. */
export function quickStat(info) {
  const st = (p) => { try { return fs.statSync(p) } catch { return null } }
  const j = st(path.join(info.dir, 'journal.jsonl'))
  const js = st(info.jsonPath)
  let last = Math.max(j?.mtimeMs || 0, js?.mtimeMs || 0)
  try { for (const f of fs.readdirSync(info.dir)) if (f.endsWith('.jsonl')) last = Math.max(last, st(path.join(info.dir, f))?.mtimeMs || 0) } catch {}
  const finished = !!js && (!j || js.mtimeMs >= j.mtimeMs - 2000)
  let status
  if (finished) {
    const ck = info.jsonPath + ':' + js.mtimeMs
    status = STATUS_CACHE.get(ck)
    if (!status) { try { status = mapStatus(JSON.parse(fs.readFileSync(info.jsonPath, 'utf8')).status) } catch { status = 'unknown' } STATUS_CACHE.set(ck, status) }
  }
  else if (now() - last <= IDLE_MS) status = 'running'
  else {
    // quiet for a while: still running if an agent's transcript ends on a tool call that has no result yet
    status = 'idle'
    if (now() - last < PENDING_MAX_MS) {
      let files = []
      try { files = fs.readdirSync(info.dir).filter((f) => /^agent-.*\.jsonl$/.test(f)).map((f) => ({ f: path.join(info.dir, f), m: st(path.join(info.dir, f))?.mtimeMs || 0 })) } catch {}
      files.sort((a, b) => b.m - a.m)
      for (const { f } of files.slice(0, 8)) { const p = tailPendingTool(f); if (p && now() - p < PENDING_MAX_MS) { status = 'running'; break } }
    }
  }
  return { ...info, lastActivity: last || null, status, finished }
}

/** Reads the last 512 KB of a transcript; returns the start time of a tool call that has no result yet (or null). */
export function tailPendingTool(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, 512 << 10)
    const buf = Buffer.allocUnsafe(len)
    const n = fs.readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8', 0, n).split('\n')
    if (len < size) lines.shift()
    const pend = new Map()
    for (const l of lines) {
      if (!l || l.startsWith('{"type":"api-request')) continue
      let d
      try { d = JSON.parse(l) } catch { continue }
      const ct = d?.message?.content
      if (!Array.isArray(ct)) continue
      for (const b of ct) {
        if (b?.type === 'tool_use' && b.id) pend.set(b.id, Date.parse(d.timestamp) || 0)
        else if (b?.type === 'tool_result') pend.delete(b.tool_use_id)
      }
    }
    let best = 0
    for (const t of pend.values()) best = Math.max(best, t)
    return best || null
  } catch { return null } finally { if (fd != null) try { fs.closeSync(fd) } catch {} }
}

export function selectRuns(o) {
  const root = o.root || defaultRoot()
  const { runs, errors } = discoverRuns(root)
  let list = runs
  if (o.project) list = list.filter((r) => r.project.toLowerCase().includes(String(o.project).toLowerCase()))
  if (o.session) list = list.filter((r) => r.sessionId.startsWith(o.session))
  if (o.run) {
    const x = String(o.run)
    const exact = list.filter((r) => r.runId === x || r.runId === 'wf_' + x)
    const pre = exact.length ? exact : list.filter((r) => r.runId.startsWith(x) || r.runId.startsWith('wf_' + x))
    if (!pre.length) throw new UserError(`no run matches "${x}" under ${root}` + (errors.length ? ` (${errors[0]})` : ''))
    if (pre.length > 1) throw new UserError(`"${x}" is ambiguous: ${pre.map((r) => r.runId).join(', ')}`)
    return { runs: pre.map(quickStat), note: null, errors }
  }
  if (!list.length) throw new UserError(`no workflow runs found under ${root}` + (errors.length ? ` (${errors[0]})` : ''))
  const ranked = list.map(quickStat).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
  const running = ranked.filter((r) => r.status === 'running')
  if (o.all) return { runs: running.length ? running : ranked.slice(0, 1), note: running.length ? null : 'no running runs; showing the most recent', errors, ranked }
  if (running.length) return { runs: [running[0]], note: running.length > 1 ? `${running.length} runs running, showing the most recent (--all: all of them)` : null, errors, ranked }
  return { runs: [ranked[0]], note: 'no running run; showing the most recent', errors, ranked }
}

export class UserError extends Error {}

// ───────────────────────── bars ─────────────────────────
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
export function bar(frac, w, colorFn = c.green) {
  if (w <= 0) return ''
  frac = Math.max(0, Math.min(1, frac || 0))
  const cells = frac * w
  const full = Math.floor(cells)
  const rem = Math.round((cells - full) * 8)
  let s = '█'.repeat(full)
  let used = full
  if (rem > 0 && used < w) { s += EIGHTHS[rem]; used++ }
  return colorFn(s) + c.gray('░'.repeat(w - used))
}
/** Multi-segment bar: segs = [[count, colorFn, char]], total = denominator. */
export function segBar(segs, total, w) {
  if (w <= 0) return ''
  if (!total) return c.gray('░'.repeat(w))
  const raw = segs.map(([n]) => (n / total) * w)
  const cells = raw.map(Math.floor)
  let used = cells.reduce((a, b) => a + b, 0)
  const target = Math.min(w, Math.round(segs.reduce((a, [n]) => a + n, 0) / total * w))
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) { if (used >= target) break; if (segs[i][0] > 0) { cells[i]++; used++ } }
  // every non-empty segment gets at least one cell when there is room
  segs.forEach(([n], i) => { if (n > 0 && cells[i] === 0 && used < w) { cells[i] = 1; used++ } })
  let s = ''
  segs.forEach(([, fn, ch], i) => { if (cells[i]) s += fn((ch || '█').repeat(cells[i])) })
  return s + c.gray('░'.repeat(Math.max(0, w - used)))
}
function activityBar(w, live, t) {
  if (w <= 0) return ''
  if (!live) return c.gray('░'.repeat(w))
  const span = Math.max(1, 2 * (w - 1))
  let pos = Math.floor(t / 160) % span
  if (pos >= w) pos = span - pos
  let s = ''
  for (let i = 0; i < w; i++) s += i === pos ? '▓' : Math.abs(i - pos) === 1 ? '▒' : '░'
  return c.cyan(s)
}

// ───────────────────────── rendering ─────────────────────────
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
function glyph(s, t) {
  if (s.earlier) return c.gray(s.status === 'failed' ? '✗' : s.status === 'done' ? '✓' : '■')
  switch (s.status) {
    case 'running': return s.idle ? c.yellow('◌') : s.stalled ? c.byellow('!') : c.cyan(SPIN[Math.floor(t / 100) % SPIN.length])
    case 'done': return c.green('✓')
    case 'cached': return c.green('↺')
    case 'failed': return c.bred('✗')
    case 'stopped': return c.yellow('■')
    case 'pending': return c.gray('·')
    default: return c.gray('?')
  }
}
function statusBadge(v) {
  switch (v.status) {
    case 'running': return c.bcyan('● running')
    case 'idle': return c.byellow('◌ idle ' + fmtAgo(now() - (v.lastActivity || now())))
    case 'completed': return v.counts.failed ? c.byellow(`✓ completed (${v.counts.failed} failed)`) : c.bgreen('✓ completed')
    case 'stopped': return c.byellow('■ stopped')
    case 'failed': return c.bred('✗ failed')
    default: return c.gray(v.status)
  }
}
function countsText(v, short = false) {
  const k = v.counts
  const parts = [c.green(`${k.done} done`)]
  if (k.running) parts.push(c.cyan(`${k.running} running`))
  if (k.failed) parts.push(c.red(`${k.failed} failed`))
  if (k.stopped) parts.push(c.yellow(`${k.stopped} stopped`))
  if (k.pending) parts.push(c.gray(`${k.pending} pending`))
  if (k.earlier) parts.push(c.gray(`${k.earlier} from an earlier launch`))
  const seen = v.slots.length
  const exp = v.expected > seen && !v.finished ? c.gray(` (~${v.expected} in script${v.estimateLoops ? '+' : ''})`) : ''
  return parts.join(c.gray(' · ')) + c.gray(` / ${seen} ${short ? '' : 'agents '}seen`) + exp
}

export function limitBanner(v, W) {
  const L = v.limit
  if (!L) return null
  const when = L.resets ? `resets ${L.resets}` : L.resetsAt ? `resets ${fmtWhen(L.resetsAt)}` : ''
  const msg = ` ⚠ ${L.limitType ? L.limitType.replace(/_/g, '-') + ' ' : ''}USAGE LIMIT HIT at ${fmtWhen(L.at)}${when ? ' · ' + when : ''} · ${L.current ? (v.finished ? 'agents failed on it' : 'agents are blocked until then') : 'work resumed after it'} `
  return L.current ? c.banner(fit(msg, W)) : c.yellow(trunc(msg.trim(), W))
}

function headerLines(v, W, compact = false) {
  const t = now()
  const lines = []
  const name = v.name || '(workflow script not found)'
  const right = c.gray('default ') + (v.defaultModel ? shortModel(v.defaultModel) : '?')
  const elapsed = v.elapsedMs != null ? fmtDur(v.elapsedMs) : '–'
  const left = `${c.bold(c.magenta('◆ ' + name))}  ${c.gray(v.runId)}  ${statusBadge(v)}  ${c.white(elapsed)}${c.gray(v.startTs ? ' since ' + fmtWhen(v.startTs) : '')}`
  const gap = W - strWidth(left) - strWidth(right)
  lines.push(gap >= 2 ? left + ' '.repeat(gap) + right : trunc(left, W))
  if (!compact && v.description) lines.push(c.gray(trunc(v.description, W)))
  const T = v.totals
  const tok = T.jsonTokens != null ? T.jsonTokens : T.harnessTokens
  const stats = [
    `tokens ${c.white(fmtTok(tok))}`,
    `out≈${c.white(fmtTok(T.outTokens))}`,
    `in+cache ${c.white(fmtTok(T.processed))}`,
    `tools ${c.white(String(T.jsonToolCalls ?? T.toolCalls))}` + (T.toolErrors ? c.red(` (${T.toolErrors} err)`) : ''),
    `api ${c.white(String(T.apiCalls))}`,
    `session ${c.white(v.sessionId.slice(0, 8))}`,
    v.lastActivity ? (t - v.lastActivity < 1000 ? `active ${c.white('now')}` : `active ${c.white(fmtAgo(t - v.lastActivity))} ago`) : '',
  ].filter(Boolean)
  if (!compact) lines.push(trunc(c.gray(stats.join(c.gray(' · '))), W))
  const lb = limitBanner(v, W)
  if (lb) lines.push(lb)
  if (v.jsonError && !compact && v.status !== 'completed') lines.push(c.yellow(trunc('run error: ' + v.jsonError, W)))
  return lines
}

function progressLines(v, W, maxPhaseLines) {
  const lines = []
  const k = v.counts
  const total = v.status === 'completed' ? v.slots.length : Math.max(v.expected, v.slots.length)
  const bw = Math.max(10, Math.min(40, W - 60))
  const segs = [[k.done, c.green], [k.failed, c.red], [k.stopped, c.yellow], [k.running, c.cyan, '▒']]
  lines.push(trunc(`${c.bold('agents')} ${segBar(segs, total, bw)} ${countsText(v, W < 100)}`, W))
  const ph = v.phases
  if (!ph.length) return lines
  if (ph.length > maxPhaseLines) {
    const parts = ph.map((p) => {
      const mark = p.current ? c.cyan('▶') : p.total && p.done === p.total && !p.running ? c.green('✓') : p.failed ? c.red('✗') : c.gray('·')
      return `${mark}${p.current ? c.bold(p.title) : p.total ? p.title : c.gray(p.title)} ${c.gray(p.total ? `${p.done}/${p.total}` : '–')}`
    })
    lines.push(trunc(parts.join(c.gray('  ')), W))
    return lines
  }
  const tw = Math.min(16, Math.max(...ph.map((p) => strWidth(p.title))))
  const pbw = Math.max(8, Math.min(24, Math.floor(W / 6)))
  for (const p of ph) {
    const mark = p.current ? c.cyan('▶') : p.total && p.done === p.total && !p.running && !p.failed ? c.green('✓') : p.failed && !p.running ? c.red('✗') : ' '
    const denom = v.status === 'completed' ? p.total : Math.max(p.total, p.expected || 0)
    const b = denom ? segBar([[p.done, c.green], [p.failed, c.red], [p.stopped, c.yellow], [p.running, c.cyan, '▒']], denom, pbw) : c.gray('·'.repeat(pbw))
    const cnt = p.total ? `${p.done}/${denom}${p.running ? c.cyan(` · ${p.running} running`) : ''}${p.failed ? c.red(` · ${p.failed} failed`) : ''}${p.stopped ? c.yellow(` · ${p.stopped} stopped`) : ''}` : c.gray('not started')
    const title = p.current ? c.bold(fit(p.title, tw)) : p.total ? fit(p.title, tw) : c.gray(fit(p.title, tw))
    lines.push(trunc(` ${mark} ${title} ${b} ${cnt}${p.detail ? c.gray('  ' + p.detail) : ''}`, W))
  }
  return lines
}

/** Column layout for the agent table, adapted to width. */
export function tableLayout(slots, W) {
  const labelCap = W >= 150 ? 28 : W >= 120 ? 24 : W >= 100 ? 20 : 16
  const labelW = Math.max(8, Math.min(labelCap, Math.max(5, ...slots.map((s) => strWidth(s.label) + (s.attempts > 1 ? 3 : 0)))))
  const modelW = Math.max(5, Math.min(14, Math.max(5, ...slots.map((s) => strWidth(s.modelShort || '?')))))
  const phaseW = Math.max(5, Math.min(12, Math.max(5, ...slots.map((s) => strWidth(s.phase || '')))))
  const cols = [
    { id: 'g', w: 1, title: '' },
    { id: 'label', w: labelW, title: 'agent' },
    { id: 'phase', w: phaseW, title: 'phase', drop: 1 },
    { id: 'model', w: modelW, title: 'model' },
    { id: 'el', w: 6, title: 'time', right: true, drop: 6 },
    { id: 'out', w: 5, title: 'out', right: true, drop: 3 },
    { id: 'ctx', w: 5, title: 'ctx', right: true, drop: 2 },
    { id: 'tools', w: 4, title: 'tool', right: true, drop: 5 },
    { id: 'prog', w: W >= 140 ? 16 : W >= 100 ? 13 : 10, title: 'progress' },
    { id: 'ago', w: 4, title: 'ago', right: true, drop: 4 },
    { id: 'act', w: 0, title: 'current activity' },
  ]
  const minAct = W >= 120 ? 40 : 26
  const used = () => cols.reduce((a, col) => a + col.w + 1, 0)
  for (let lvl = 1; lvl <= 6 && W - used() < minAct; lvl++) {
    const i = cols.findIndex((col) => col.drop === lvl)
    if (i >= 0) cols.splice(i, 1)
  }
  if (W - used() < minAct) { const p = cols.find((x) => x.id === 'prog'); if (p) p.w = 9 }
  if (W - used() < minAct) { const l = cols.find((x) => x.id === 'label'); if (l) l.w = Math.max(8, l.w - (minAct - (W - used()))) }
  cols[cols.length - 1].w = Math.max(8, W - used())
  return cols
}

function progressCell(s, w, t) {
  const p = s.progress
  const live = s.status === 'running' && !s.stalled && (s.sinceMs ?? 1e9) < 60_000
  const fail = s.status === 'failed'
  const colorFn = fail ? c.red : s.status === 'stopped' ? c.yellow : s.status === 'running' ? c.cyan : c.green
  if (p && (p.kind === 'items' || p.kind === 'empty') && p.total) {
    const lab = `${p.done}/${p.total}`
    const bw = Math.max(3, w - lab.length - 1)
    return bar(p.done / p.total, bw, colorFn) + ' ' + lab
  }
  if (p && (p.kind === 'items' || p.kind === 'findings') && p.done) {
    const lab = p.kind === 'findings' ? `${p.done}F` : `${p.done}✓`
    const bw = Math.max(3, w - strWidth(lab) - 1)
    const b = s.status === 'running' ? activityBar(bw, live, t) : s.bucket === 'done' ? c.green('█'.repeat(bw)) : colorFn('▒'.repeat(bw))
    return b + ' ' + lab
  }
  if (s.bucket === 'done') return c.green('█'.repeat(w - 5)) + c.green(' done')
  if (fail) return c.red('▒'.repeat(Math.max(1, w - 5))) + c.red(' fail')
  if (s.status === 'stopped') return c.yellow('▒'.repeat(Math.max(1, w - 5))) + c.yellow(' stop')
  if (s.status === 'pending') return c.gray('·'.repeat(w))
  return activityBar(w, live, t)
}

function activityCell(s, t) {
  const a = s.activity
  if (s.earlier) return c.gray(`earlier launch, not part of the final one · ${s.status}${s.error ? ': ' + s.error : ''}`)
  if (s.status === 'failed') return c.red(s.error ? '✗ ' + s.error : '✗ failed')
  if (s.bucket === 'done' && s.result) return c.green('→ ') + c.gray(s.result)
  let text = a.text || ''
  let fn = (x) => x
  if (a.state === 'error') fn = c.red
  else if (a.state === 'after-error') fn = c.red
  else if (a.state === 'thinking') fn = c.ital
  else if (a.state === 'text') fn = c.white
  else if (a.state === 'pending') text = text + c.gray(' ⋯')
  if (a.state === 'after-tool' || a.state === 'after-error') text = text + (s.status === 'running' ? c.gray(' · thinking…') : '')
  if (s.status === 'stopped') fn = c.gray
  let pre = ''
  if (s.idle) pre = c.yellow(`idle ${fmtAgo(s.sinceMs)} · `)
  if (s.stalled) pre = c.byellow(s.waitingOn ? `stalled? ${fmtAgo(s.sinceMs)} in ` : `stalled ${fmtAgo(s.sinceMs)} · `)
  return pre + fn(text)
}

function rowLine(s, cols, t, selected, attrs = false) {
  const cells = cols.map((col) => {
    let v
    switch (col.id) {
      case 'g': v = glyph(s, t); break
      case 'label': v = (s.status === 'pending' ? c.gray : (x) => tagColor(s.label)(x))(s.label) + (s.attempts > 1 ? c.yellow(` ↻${s.attempts}`) : ''); break
      case 'phase': v = c.gray(s.phase || ''); break
      case 'model': v = s.modelShort ? c.blue(s.modelShort) : c.gray('?'); break
      case 'el': v = fmtDur(s.elapsedMs); break
      case 'out': v = fmtTok(s.outTokens); break
      case 'ctx': v = fmtTok(s.ctx); break
      case 'tools': v = String(s.toolCalls) + (s.toolErrors ? '' : ''); break
      case 'prog': v = progressCell(s, col.w, t); break
      case 'ago': v = s.activity.ts ? c.gray(fmtAgo(t - s.activity.ts)) : ''; break
      case 'act': v = activityCell(s, t); break
    }
    return fit(v, col.w, col.right)
  })
  const line = cells.join(' ')
  if (!selected) return line
  // reverse video reads on light and dark themes alike; it is an attribute, not a colour, so the TUI uses it under
  // NO_COLOR too. Plain-text output (no escapes at all) marks the row with ▸ after the status glyph instead.
  if (COLOR || attrs) return '\x1b[7m' + stripAnsi(line) + '\x1b[0m'
  const g = cells[0]
  return g + '▸' + line.slice(g.length + 1)
}

function tableHeader(cols) { return c.gray(cols.map((col) => fit(col.title, col.w, col.right)).join(' ')) }

function feedLine(e, W, tagW, opts = {}) {
  const mw = opts.modelW || 10
  const a = e.agent
  const slot = a ? a.run.slotFor(a.id) : null
  const label = slot?.label || a?.label || a?.id || ''
  const model = a?.modelName ? shortModel(a.modelName) : ''
  const time = c.gray(fmtClock(e.ts))
  if (e.kind === 'status') return trunc(`${time} ${c.bold(c.magenta('◆ ' + e.text))}`, W)
  const tag = tagColor(label)(fit(label, tagW)) + (opts.noModel ? '' : ' ' + c.blue(fit(model, mw)))
  let text
  switch (e.kind) {
    case 'toolerr': text = c.red(`✗ ${e.tool}: ${e.text}`); break
    case 'error': text = c.red('✗ ' + e.text); break
    case 'limit': text = c.bred('⚠ ' + e.text); break
    case 'text': text = e.progress ? c.green(e.text) : c.white('“' + e.text + '”'); break
    case 'start': text = c.cyan('▶ ' + e.text); break
    case 'done': text = c.bgreen('✓ ') + c.green(e.text); break
    case 'fail': text = c.bred('✗ ' + e.text); break
    case 'user': text = c.magenta(e.text); break
    default: text = e.text
  }
  return trunc(`${time} ${tag} ${text}`, W)
}

/** Main dashboard frame. state: {sel, all, paused, note}. H = Infinity for --once. */
export function renderMain(runs, W, H, state = {}) {
  const t = now()
  const views = runs.map((r) => r.view())
  const out = []
  const multi = views.length > 1
  const allSlots = []
  views.forEach((v, ri) => v.slots.forEach((s) => allSlots.push({ v, s, ri })))
  const sel = Math.max(0, Math.min(state.sel || 0, allSlots.length - 1))
  const finite = Number.isFinite(H)
  const small = finite && H < 22
  const top = []
  const body = [] // {line, slotIndex}
  const cols = tableLayout(allSlots.map((x) => x.s), W)
  if (multi) top.push(c.bold(`${views.length} runs`) + c.gray(` · ${views.filter((v) => v.status === 'running').length} running`))
  let idx = 0
  views.forEach((v, ri) => {
    const head = [...headerLines(v, W, multi || small), ...progressLines(v, W, small || multi ? 0 : 6)]
    if (!multi) top.push(...head, tableHeader(cols))
    else { if (ri) body.push({ line: '' }); for (const l of head) body.push({ line: l }); body.push({ line: tableHeader(cols) }) }
    if (!v.slots.length) body.push({ line: c.gray('  no agents yet' + (v.status === 'running' ? ' (waiting for the first agent to start)' : '')) })
    for (const s of v.slots) { body.push({ line: rowLine(s, cols, t, idx === sel && !state.noSel, !!state.attrs), slot: idx }); idx++ }
  })
  const footer = footerLine(W, state, views)
  const feedTitle = (n) => c.gray('── feed ' + '─'.repeat(Math.max(0, W - 9)))
  let bodyRows, feedRows
  if (!finite) { bodyRows = body.length; feedRows = state.feedLines ?? 12 }
  else {
    const avail = H - top.length - 1 /* feed title */ - 1 /* footer */
    const wantFeed = Math.max(3, Math.floor(avail * 0.35))
    bodyRows = Math.max(1, Math.min(body.length, avail - Math.min(wantFeed, Math.max(0, avail - body.length))))
    if (avail - bodyRows < 3) bodyRows = Math.max(1, Math.min(body.length, avail - 3))
    feedRows = Math.max(0, avail - bodyRows)
  }
  // window the body so that the selected row is visible
  let startRow = 0
  if (body.length > bodyRows) {
    const selRow = body.findIndex((b) => b.slot === sel)
    startRow = Math.max(0, Math.min(body.length - bodyRows, selRow - Math.floor(bodyRows / 2)))
  }
  const shown = body.slice(startRow, startRow + bodyRows).map((b) => b.line)
  if (startRow > 0 && shown.length) shown[0] = c.gray(fit(`  ↑ ${startRow} more`, W))
  if (startRow + bodyRows < body.length && shown.length > 1) shown[shown.length - 1] = c.gray(fit(`  ↓ ${body.length - startRow - bodyRows} more`, W))
  out.push(...top, ...shown)
  if (feedRows > 0) {
    out.push(feedTitle())
    const evs = []
    for (const r of runs) evs.push(...r.feed(Math.max(feedRows, 1)))
    evs.sort((x, y) => (x.ts - y.ts) || (x.seq - y.seq))
    const tagW = Math.max(6, Math.min(W >= 120 ? 18 : 14, Math.max(6, ...allSlots.map((x) => strWidth(x.s.label)))))
    const modelW = Math.max(5, Math.min(12, Math.max(5, ...allSlots.map((x) => strWidth(x.s.modelShort || '')))))
    const lines = evs.slice(-feedRows).map((e) => feedLine(e, W, tagW, { noModel: W < 70, modelW }))
    if (!lines.length) lines.push(c.gray('  (no events yet)'))
    out.push(...lines)
    if (finite) while (out.length < H - 1) out.push('')
  }
  out.push(footer)
  return finite ? out.slice(0, H) : out
}

function footerLine(W, state, views) {
  if (state.once) {
    const errs = views.flatMap((v) => v.errors)
    return c.gray(`ultrawatch ${VERSION} · ${fmtClock(now())}`) + (errs.length ? c.red(` · ⚠ ${errs.length} read error(s): ${errs[0]}`) : '') + (state.note ? c.yellow(' · ' + state.note) : '')
  }
  const errs = views.flatMap((v) => v.errors)
  const right = [state.paused ? c.byellow(' PAUSED ') : '', state.note ? c.yellow(state.note) : '', errs.length ? c.red(`⚠ ${errs.length} read error(s): ${errs[0]}`) : '', c.gray(fmtClock(now()))].filter(Boolean).join(c.gray(' · '))
  const variants = ['q quit · ↑↓/jk select · ⏎/f focus · p pause · r rescan · a all runs · ? help', 'q quit · jk select · ⏎ focus · p pause · a all · ? help', 'q · jk · ⏎ · p · a · ?']
  const keys = variants.find((k) => strWidth(k) + strWidth(right) + 1 <= W) || variants[2]
  const gap = W - strWidth(keys) - strWidth(right)
  return gap >= 1 ? c.gray(keys) + ' '.repeat(gap) + right : trunc(c.gray(keys) + ' ' + right, W)
}

/** Focus view: one agent's full event stream (all attempts). */
export function renderFocus(run, slotKey, W, H, state = {}) {
  const t = now()
  const v = run.view()
  const s = v.slots.find((x) => x.key === slotKey) || v.slots[0]
  const out = []
  if (!s) return ['(no agent)', c.gray('Esc back')]
  const head1 = `${c.gray('← Esc')}  ${glyph(s, t)} ${c.bold(tagColor(s.label)(s.label))}  ${c.gray(s.phase || '')}  ${c.blue(s.modelShort || '?')}${s.model ? c.gray(' (' + s.model + ')') : ''}  ${c.white(s.status)}${s.attempts > 1 ? c.yellow(` · attempt ${s.attempts}/${s.attempts}`) : ''}  ${c.gray('agent ' + (s.agentId || '?'))}`
  out.push(trunc(head1, W))
  out.push(trunc(c.gray(`time ${fmtDur(s.elapsedMs)} · out≈${fmtTok(s.outTokens)} · ctx ${fmtTok(s.ctx)} · tools ${s.toolCalls}${s.toolErrors ? ` (${s.toolErrors} err)` : ''} · api ${s.apiCalls} · started ${fmtWhen(s.startTs)}${s.lastSeen ? ' · last activity ' + (t - s.lastSeen < 1000 ? 'now' : fmtAgo(t - s.lastSeen) + ' ago') : ''}`), W))
  if (s.progress) {
    const p = s.progress
    const pc = p.kind === 'missing' ? c.gray('not written yet') : progressCell(s, 24, t)
    out.push(trunc(`${c.gray('progress')} ${pc}  ${c.gray(p.path || '')}`, W))
    if (p.last) out.push(trunc(c.gray('  last done: ') + p.last, W))
  }
  out.push(trunc(c.gray('now: ') + activityCell(s, t), W))
  if (s.error) out.push(trunc(c.red('error: ' + s.error), W))
  out.push(c.gray('─'.repeat(W)))
  // events
  const lines = []
  for (let ai = 0; ai < s.agentIds.length; ai++) {
    const a = run.agents.get(s.agentIds[ai])
    if (s.agentIds.length > 1) lines.push(c.yellow(`── attempt ${ai + 1} · agent ${s.agentIds[ai]} ${a ? '· ' + shortModel(a.modelName) : ''} ──`))
    if (!a) continue
    let lastThinking = false
    const evs = [...a.events].sort((x, y) => (x.ts - y.ts) || (x.seq - y.seq))
    for (const e of evs) {
      if (e.kind === 'thinking') { if (!lastThinking) lines.push(`${c.gray(fmtClock(e.ts))} ${c.gray(c.ital('· thinking' + (e.text ? ': ' + e.text : '')))}`); lastThinking = true; continue }
      lastThinking = false
      const tm = c.gray(fmtClock(e.ts))
      switch (e.kind) {
        case 'tool': lines.push(`${tm} ${c.cyan('▸')} ${e.detail || e.text}`); break
        case 'result': lines.push(`${tm}   ${c.gray('↳ ' + (e.dur != null ? fmtDur(e.dur) + ' ' : '') + e.text)}`); break
        case 'toolerr': lines.push(`${tm}   ${c.red('↳ ✗ ' + e.text)}`); break
        case 'text': {
          if (e.progress) { lines.push(`${tm} ${c.green(e.text)}`); break }
          const ls = cleanMultiline(e.full || e.text, 3000).filter((x) => x.trim())
          ls.slice(0, 6).forEach((l, i) => lines.push(`${i ? '         ' : tm} ${c.white(i ? '  ' + l : '“ ' + l)}`))
          if (ls.length > 6) lines.push(`           ${c.gray('… ' + (ls.length - 6) + ' more lines')}`)
          break
        }
        case 'prompt': lines.push(`${tm} ${c.magenta('◆ ' + e.text)}  ${c.gray(clean(e.full, 300))}`); break
        case 'start': lines.push(`${tm} ${c.cyan('▶ ' + e.text)}`); break
        case 'done': lines.push(`${tm} ${c.bgreen('✓ ' + e.text)}`); break
        case 'fail': lines.push(`${tm} ${c.bred('✗ ' + e.text)}`); break
        case 'limit': lines.push(`${tm} ${c.bred('⚠ ' + e.text)}`); break
        case 'error': lines.push(`${tm} ${c.red('✗ ' + e.text)}`); break
        case 'user': lines.push(`${tm} ${c.magenta(e.text)}`); break
        default: lines.push(`${tm} ${e.text}`)
      }
    }
  }
  if (!lines.length) lines.push(c.gray('  (no events yet)'))
  const finite = Number.isFinite(H)
  const avail = finite ? Math.max(1, H - out.length - 1) : lines.length
  const maxScroll = Math.max(0, lines.length - avail)
  const scroll = Math.min(state.scroll || 0, maxScroll)
  if (state) state.scroll = scroll
  const end = lines.length - scroll
  const vis = lines.slice(Math.max(0, end - avail), end).map((l) => trunc(l, W))
  out.push(...vis)
  if (finite) while (out.length < H - 1) out.push('')
  const pos = scroll ? c.yellow(`scrolled ↑${scroll} (G: follow)`) : c.gray('following new events')
  out.push(trunc(c.gray('Esc back · ↑↓/jk scroll · PgUp/PgDn · g top · G follow · q quit · ') + pos + c.gray(` · ${lines.length} lines`), W))
  return finite ? out.slice(0, H) : out
}

export function renderHelp(W, H) {
  const L = [
    c.bold('ultrawatch ' + VERSION + ' — keys'),
    '',
    '  q / Ctrl-C     quit (terminal restored)',
    '  ↑ ↓ / k j      select an agent (focus view: scroll)',
    '  Enter / f      focus the selected agent: its full event stream',
    '  Esc            back to the dashboard',
    '  p              pause / resume redraw (data keeps loading)',
    '  r              rescan the disk for runs and agents',
    '  a              toggle: this run / all running runs',
    '  ?              this help',
    '',
    c.bold('columns'),
    '  glyph     ⠋ running  ! stalled  ✓ done  ↺ cached  ✗ failed  ■ stopped  · pending',
    '  agent     label from the workflow script (↻n = n attempts: retries/resumes)',
    '  model     message.model of the agent\'s latest reply, shortened (claude-opus-5-5 → opus-5.5)',
    '  time      agent elapsed (first to last transcript line, or until now while running)',
    '  out       output tokens (≈: the transcript stores streaming snapshots)',
    '  ctx       current context: latest input + cache read + cache creation tokens',
    '  tool      tool calls made',
    '  progress  done/total from the agent\'s progress.md (or N✓ / NF findings), else activity',
    '  ago       time since the current activity started',
    '  activity  latest tool call, text or thinking; "stalled" after 3 min of silence',
    '',
    c.gray('press any key to return (q quits)'),
  ]
  const out = L.map((l) => trunc(l, W))
  return Number.isFinite(H) ? out.slice(0, H) : out
}

// ───────────────────────── modes ─────────────────────────
function makeRuns(sel, opts) { return sel.runs.map((r) => new Run(r, opts)) }

export function snapshot(runs) {
  return runs.map((r) => {
    const v = r.view()
    return {
      ...v,
      slots: v.slots.map((s) => ({ ...s, activity: { ...s.activity, ago: s.activity.ts ? now() - s.activity.ts : null } })),
      feed: r.feed(40).map((e) => ({ ts: e.ts, time: new Date(e.ts).toISOString(), kind: e.kind, agent: e.agent ? (r.slotFor(e.agent.id)?.label || e.agent.label || e.agent.id) : null, agentId: e.agent?.id || null, model: e.agent?.modelName || null, text: e.text })),
    }
  })
}

function listRuns(o) {
  const root = o.root || defaultRoot()
  const { runs, errors } = discoverRuns(root)
  let list = runs
  if (o.project) list = list.filter((r) => r.project.toLowerCase().includes(String(o.project).toLowerCase()))
  if (o.session) list = list.filter((r) => r.sessionId.startsWith(o.session))
  const ranked = list.map(quickStat).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)).slice(0, o.limit || 30)
  const rows = ranked.map((q) => {
    const run = new Run(q, { light: q.finished })
    run.poll()
    const v = run.view()
    const tok = v.totals.jsonTokens ?? v.totals.harnessTokens
    const tools = v.totals.jsonToolCalls ?? v.totals.toolCalls
    return { runId: v.runId, name: v.name || '(no script)', status: v.status, done: v.counts.done, failed: v.counts.failed, running: v.counts.running, total: v.slots.length - v.counts.earlier, earlier: v.counts.earlier, tokens: tok, tools, started: v.startTs, age: v.lastActivity ? now() - v.lastActivity : null, session: v.sessionId, project: v.project, limit: v.limit ? (v.limit.resets || '') : null }
  })
  if (o.json) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return }
  const W = o.width || process.stdout.columns || 140
  const head = ['run', 'name', 'status', 'agents', 'tokens', 'tools', 'started', 'active', 'session']
  const lines = [c.gray(fit(head[0], 16) + ' ' + fit(head[1], 26) + ' ' + fit(head[2], 12) + ' ' + fit(head[3], 13) + ' ' + fit(head[4], 7, true) + ' ' + fit(head[5], 5, true) + ' ' + fit(head[6], 13) + ' ' + fit(head[7], 6, true) + ' ' + head[8])]
  for (const r of rows) {
    const st = r.status === 'running' ? c.cyan(r.status) : r.status === 'completed' ? c.green(r.status) : r.status === 'failed' ? c.red(r.status) : c.yellow(r.status)
    const ag = `${r.done}/${r.total}` + (r.failed ? c.red(` ${r.failed}✗`) : '') + (r.running && r.status === 'running' ? c.cyan(` ${r.running}⟳`) : '')
    lines.push(trunc(fit(r.runId, 16) + ' ' + fit(r.name, 26) + ' ' + fit(st, 12) + ' ' + fit(ag, 13) + ' ' + fit(fmtTok(r.tokens), 7, true) + ' ' + fit(String(r.tools ?? '–'), 5, true) + ' ' + fit(fmtWhen(r.started), 13) + ' ' + fit(fmtAgo(r.age), 6, true) + ' ' + c.gray(r.session.slice(0, 8)) + (r.limit != null ? c.red(' ⚠limit') : ''), W))
  }
  if (!rows.length) lines.push(c.gray('(no runs found under ' + root + ')'))
  for (const e of errors) lines.push(c.red('⚠ ' + e))
  process.stdout.write(lines.join('\n') + '\n')
}

function onceMode(o) {
  const sel = selectRuns(o)
  const runs = makeRuns(sel)
  for (const r of runs) r.poll()
  if (o.json) { process.stdout.write(JSON.stringify(o.all ? snapshot(runs) : snapshot(runs)[0], null, 2) + '\n'); return }
  const W = o.width || process.stdout.columns || 120
  const H = o.height || Infinity
  let lines
  if (o.focus) {
    const r = runs[0]
    const s = r.view().slots.find((x) => x.label.includes(o.focus) || x.key === o.focus || (x.agentId || '').startsWith(o.focus))
    if (!s) throw new UserError(`no agent matches "${o.focus}"`)
    lines = renderFocus(r, s.key, W, H, {})
  } else lines = renderMain(runs, W, H, { once: true, noSel: true, note: sel.note, feedLines: o.feedLines ?? 12 })
  process.stdout.write(lines.join('\n') + '\n')
}

function feedMode(o) {
  const sel = selectRuns(o)
  let runs = makeRuns(sel)
  const tty = process.stdout.isTTY
  const W = tty ? process.stdout.columns || 120 : 100000
  const match = o.agent ? (a) => { const l = (a.run.slotFor(a.id)?.label || a.label || a.id).toLowerCase(); return l.includes(String(o.agent).toLowerCase()) } : null
  const write = (s) => { try { process.stdout.write(s) } catch { process.exit(0) } }
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0) })
  for (const r of runs) r.poll()
  const tagW = 18
  for (const r of runs) {
    const v = r.view()
    write(c.bold(c.magenta(`# ${v.name || '(workflow script not found)'} ${v.runId}`)) + c.gray(` · ${v.status} · ${v.counts.done}/${v.slots.length} done · ${v.dir}`) + '\n')
    if (v.limit) write(stripAnsiIf(limitBanner(v, 200)) + '\n')
  }
  if (sel.note) write(c.yellow('# ' + sel.note) + '\n')
  let lastSeq = 0
  const collect = () => { const evs = []; for (const r of runs) evs.push(...r.feed(0, match)); return evs }
  const initial = collect()
  for (const e of initial) lastSeq = Math.max(lastSeq, e.seq)
  const backlog = o.backlog ?? 20
  for (const e of backlog > 0 ? initial.slice(-backlog) : []) write(feedLine(e, W, tagW) + '\n')
  if (o.once) return
  let lastDiscover = now()
  const tick = () => {
    for (const r of runs) { try { r.poll() } catch (e) { r.noteError(String(e.message)) } }
    if (o.all && now() - lastDiscover > 5000) {
      lastDiscover = now()
      try {
        const s2 = selectRuns({ ...o, run: null })
        for (const q of s2.runs) if (!runs.some((r) => r.runId === q.runId)) { const nr = new Run(q); nr.poll(); for (const e of nr.feed(0)) lastSeq = Math.max(lastSeq, e.seq); runs.push(nr); write(c.bold(c.magenta(`# now also watching ${q.runId}`)) + '\n') }
      } catch {}
    }
    const evs = collect().filter((e) => e.seq > lastSeq)
    for (const e of evs) { lastSeq = Math.max(lastSeq, e.seq); write(feedLine(e, W, tagW) + '\n') }
  }
  setInterval(tick, o.interval || 500)
}
function stripAnsiIf(s) { return COLOR ? s : stripAnsi(s) }

function tuiMode(o) {
  const out = process.stdout
  const stdin = process.stdin
  let sel = selectRuns(o)
  let runs = makeRuns(sel)
  const singleId = runs[0].runId
  for (const r of runs) r.poll()
  const st = { attrs: true, mode: 'main', sel: 0, all: !!o.all, paused: false, scroll: 0, note: sel.note, focusKey: null, focusRun: null }
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    // If the terminal stopped reading our output, leaving raw mode (tcsetattr with TCSADRAIN) would wait for the
    // output to drain, forever. Then skip it: node resets the terminal modes itself on exit without draining.
    const stuck = out.writableLength > 0
    if (!stuck) try { out._handle?.setBlocking?.(true) } catch {} // the restore sequence must reach the terminal before exit
    try { out.write('\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?1049l') } catch {}
    try { if (stdin.isTTY && !stuck) stdin.setRawMode(false) } catch {}
    try { stdin.pause() } catch {}
  }
  process.on('exit', restore)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(); process.exit(sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 129) })
  process.on('uncaughtException', (e) => { restore(); console.error('ultrawatch crashed:', e && e.stack || e); process.exit(1) })
  process.on('unhandledRejection', (e) => { restore(); console.error('ultrawatch crashed:', e && e.stack || e); process.exit(1) })
  // Node makes TTY writes blocking. If the terminal stops reading, a blocking write would freeze the event loop, and
  // with it the q/Ctrl-C/SIGTERM handlers. Non-blocking writes keep us responsive; render() applies back-pressure.
  try { out._handle?.setBlocking?.(false) } catch {}
  out.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J')
  let lastFrame = ''
  let lastRender = 0
  let pendingRender = null
  const slotsFlat = () => runs.flatMap((r) => r.view().slots.map((s) => ({ r, s })))
  const render = (force = false) => {
    if (st.paused && !force) return
    // back-pressure: if the terminal is not keeping up (or not reading at all), do not queue more frames
    if (out.writableLength > 256 << 10) return
    const W = Math.max(20, (out.columns || 80))
    const H = Math.max(5, (out.rows || 24))
    let lines
    if (st.mode === 'help') lines = renderHelp(W - 1, H)
    else if (st.mode === 'focus' && st.focusRun) lines = renderFocus(st.focusRun, st.focusKey, W - 1, H, st)
    else lines = renderMain(runs, W - 1, H, st)
    const frame = '\x1b[?2026h\x1b[H' + lines.map((l) => l + '\x1b[0m\x1b[K').join('\r\n') + '\x1b[J\x1b[?2026l'
    if (frame !== lastFrame || force) { out.write(frame); lastFrame = frame }
    lastRender = Date.now()
  }
  const schedule = () => {
    const wait = 60 - (Date.now() - lastRender)
    if (wait <= 0) render(true)
    else if (!pendingRender) pendingRender = setTimeout(() => { pendingRender = null; render(true) }, wait)
  }
  const rediscover = () => {
    try {
      const s2 = selectRuns({ ...o, run: null, all: true })
      const ranked = s2.ranked || s2.runs
      const want = st.all ? s2.runs : [{ runId: singleId }]
      const next = []
      for (const q of want) {
        const ex = runs.find((r) => r.runId === q.runId) || (st.focusRun && st.focusRun.runId === q.runId ? st.focusRun : null)
        if (ex) { next.push(ex); continue }
        const info = ranked.find((x) => x.runId === q.runId) || (q.dir ? q : null)
        if (info) { const nr = new Run(info); nr.poll(); next.push(nr) }
      }
      if (next.length) runs = next
      const otherRunning = ranked.filter((x) => x.status === 'running' && !runs.some((r) => r.runId === x.runId))
      st.note = !st.all && otherRunning.length ? `${otherRunning.length} other run(s) running · a: show all` : st.all ? s2.note : null
    } catch (e) { st.note = String(e.message) }
  }
  const tick = () => {
    for (const r of runs) { try { r.poll() } catch (e) { r.noteError('poll: ' + e.message) } }
    if (st.mode === 'focus' && st.focusRun && !runs.includes(st.focusRun)) { try { st.focusRun.poll() } catch {} }
    render()
  }
  rediscover()
  setInterval(tick, o.interval || 250)
  setInterval(rediscover, 3000)
  out.on('resize', () => { lastFrame = ''; render(true) })
  if (stdin.isTTY) {
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    stdin.on('data', (data) => {
      for (const key of splitKeys(data)) onKey(key)
      schedule()
    })
  }
  const onKey = (k) => {
    if (k === '\x03' || k === 'q') { restore(); process.exit(0) }
    if (st.mode === 'help') { st.mode = st.prevMode || 'main'; return }
    if (k === '?') { st.prevMode = st.mode; st.mode = 'help'; return }
    if (k === 'p') { st.paused = !st.paused; if (st.paused) render(true); return }
    if (k === 'r') { for (const r of runs) { r._metaTry = 0 } rediscover(); tick(); return }
    if (st.mode === 'focus') {
      const page = Math.max(1, (out.rows || 24) - 10)
      if (k === '\x1b' || k === 'h' || k === '\x1b[D') { st.mode = 'main'; st.scroll = 0; return }
      if (k === 'k' || k === '\x1b[A' || k === '\x1bOA') st.scroll = (st.scroll || 0) + 1
      else if (k === 'j' || k === '\x1b[B' || k === '\x1bOB') st.scroll = Math.max(0, (st.scroll || 0) - 1)
      else if (k === '\x1b[5~' || k === ' ' && false) st.scroll = (st.scroll || 0) + page
      else if (k === '\x1b[6~') st.scroll = Math.max(0, (st.scroll || 0) - page)
      else if (k === 'g' || k === '\x1b[H' || k === '\x1b[1~') st.scroll = 1e9
      else if (k === 'G' || k === '\x1b[F' || k === '\x1b[4~') st.scroll = 0
      return
    }
    const flat = slotsFlat()
    if (k === 'k' || k === '\x1b[A' || k === '\x1bOA') st.sel = Math.max(0, st.sel - 1)
    else if (k === 'j' || k === '\x1b[B' || k === '\x1bOB') st.sel = Math.min(Math.max(0, flat.length - 1), st.sel + 1)
    else if (k === 'g' || k === '\x1b[H') st.sel = 0
    else if (k === 'G' || k === '\x1b[F') st.sel = Math.max(0, flat.length - 1)
    else if (k === '\r' || k === '\n' || k === 'f' || k === 'l' || k === '\x1b[C') {
      const x = flat[Math.min(st.sel, flat.length - 1)]
      if (x) { st.mode = 'focus'; st.focusRun = x.r; st.focusKey = x.s.key; st.scroll = 0 }
    } else if (k === 'a') { st.all = !st.all; st.sel = 0; rediscover(); tick() }
  }
  render(true)
  // test hook: simulate a crash inside the running TUI to prove the terminal is restored
  if (process.env.ULTRAWATCH_TEST_CRASH_MS) setTimeout(() => { throw new Error('simulated crash (ULTRAWATCH_TEST_CRASH_MS)') }, +process.env.ULTRAWATCH_TEST_CRASH_MS)
}

export function splitKeys(data) {
  const keys = []
  let i = 0
  while (i < data.length) {
    if (data[i] === '\x1b') {
      const m = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(data.slice(i))
      if (m) { keys.push(m[0]); i += m[0].length; continue }
      keys.push('\x1b'); i++; continue
    }
    const cp = data.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    keys.push(ch)
    i += ch.length
  }
  return keys
}

// ───────────────────────── CLI ─────────────────────────
const USAGE = `ultrawatch ${VERSION} — live tracker for Claude Code workflow runs

usage: ultrawatch [options]

  (default)            live dashboard of the most recently active running run
  --run <id|prefix>    pick a run (wf_ prefix optional)
  --session <id>       only runs from this session (prefix ok)
  --project <substr>   only runs from projects whose folder name contains this
  --all                show every running run, stacked (toggle with "a")
  --list               table of recent runs and exit (--limit N, --json)
  --feed               append-only event log (default when stdout is not a TTY)
     --agent <substr>  only events of agents whose label contains this
     --backlog <n>     events printed before following (default 20)
  --once               print one dashboard frame and exit (--width, --height, --focus <agent>)
  --json               machine-readable snapshot and exit
  --color / --no-color force colours on/off (NO_COLOR is respected)
  --root <dir>         projects directory (default ~/.claude/projects or $ULTRAWATCH_ROOT)
  --interval <ms>      poll interval (default 250 TUI, 500 feed)
  -h, --help / -v, --version
`
export function parseArgs(argv) {
  const o = {}
  const needs = { '--run': 'run', '--session': 'session', '--project': 'project', '--agent': 'agent', '--root': 'root', '--width': 'width', '--height': 'height', '--limit': 'limit', '--interval': 'interval', '--backlog': 'backlog', '--focus': 'focus', '--feed-lines': 'feedLines' }
  const flags = { '--all': 'all', '--list': 'list', '--feed': 'feed', '--once': 'once', '--json': 'json', '--color': 'color', '--no-color': 'noColor', '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version' }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]
    let val = null
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq) }
    if (needs[a]) {
      const v = val ?? argv[++i]
      if (v == null) throw new UserError(`${a} needs a value`)
      o[needs[a]] = ['width', 'height', 'limit', 'interval', 'backlog', 'feedLines'].includes(needs[a]) ? Number(v) : v
    } else if (flags[a]) o[flags[a]] = true
    else if (!a.startsWith('-') && !o.run) o.run = a
    else throw new UserError(`unknown option ${a} (see --help)`)
  }
  return o
}

export function main(argv = process.argv.slice(2)) {
  let o
  try { o = parseArgs(argv) } catch (e) { process.stderr.write('ultrawatch: ' + e.message + '\n'); process.exit(2) }
  if (o.help) { process.stdout.write(USAGE); return }
  if (o.version) { process.stdout.write(VERSION + '\n'); return }
  const noColorEnv = process.env.NO_COLOR != null && process.env.NO_COLOR !== ''
  setColor(o.noColor ? false : o.color ? true : !noColorEnv && !!process.stdout.isTTY)
  try {
    if (o.list) return listRuns(o)
    if (o.json) return onceMode(o)
    if (o.feed) return feedMode(o)
    if (o.once) return onceMode(o)
    if (!process.stdout.isTTY) return feedMode(o)
    if (noColorEnv && !o.color) setColor(false)
    return tuiMode(o)
  } catch (e) {
    if (e instanceof UserError) { process.stderr.write('ultrawatch: ' + e.message + '\n'); process.exit(1) }
    throw e
  }
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) main()
