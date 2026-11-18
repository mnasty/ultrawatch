#!/usr/bin/env node
// ultrawatch test runner: node test/run.mjs [--update] [--skip-pty] [--skip-big]
// Builds fixtures under test/fixtures, checks parsed state, snapshot frames (80 + 160 columns), CLI modes,
// performance on a 20 MB transcript and terminal restore inside a real pseudo-terminal.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeFixtures, makeBig, NOW } from './make-fixtures.mjs'

process.env.TZ = 'UTC'
process.env.ULTRAWATCH_NOW = String(NOW)
delete process.env.NO_COLOR
const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOL = path.join(HERE, '..', 'ultrawatch.mjs')
const FIX = path.join(HERE, 'fixtures')
const SNAP = path.join(HERE, 'snapshots')
const UPDATE = process.argv.includes('--update')
const SKIP_PTY = process.argv.includes('--skip-pty')
const SKIP_BIG = process.argv.includes('--skip-big')

const m = await import(TOOL)
m.setColor(false)

let pass = 0, fail = 0
const failures = []
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log('  ok   ' + name) } else { fail++; failures.push(name); console.log('  FAIL ' + name + (extra ? '\n       ' + String(extra).split('\n').join('\n       ') : '')) }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, `expected ${JSON.stringify(b)}\n got      ${JSON.stringify(a)}`) }
function section(t) { console.log('\n' + t) }
function snapshot(name, text) {
  const p = path.join(SNAP, name + '.txt')
  if (UPDATE || !fs.existsSync(p)) { fs.mkdirSync(SNAP, { recursive: true }); fs.writeFileSync(p, text); ok(true, `snapshot ${name} (written)`); return }
  const want = fs.readFileSync(p, 'utf8')
  if (want === text) { ok(true, `snapshot ${name}`); return }
  const a = want.split('\n'), b = text.split('\n')
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  ok(false, `snapshot ${name}`, `first difference at line ${i + 1}:\n- ${a[i]}\n+ ${b[i]}\n(run with --update to accept)`)
}
const cli = (args, env = {}) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20000 })

const fx = makeFixtures(FIX)
const runInfo = (id) => m.discoverRuns(FIX).runs.find((r) => r.runId === id)
const load = (id) => { const r = new m.Run(runInfo(id)); r.poll(); return r }
const listing = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(p + ':' + fs.statSync(p).mtimeMs); if (e.isDirectory()) walk(p) } }; walk(dir); return out.sort().join('\n') }

// ───────────────────────── unit pieces ─────────────────────────
section('helpers')
eq(m.shortModel('claude-opus-5-5'), 'opus-5.5', 'shortModel opus-5-5')
eq(m.shortModel('claude-sonnet-4-5-20250929'), 'sonnet-4.5', 'shortModel dated sonnet')
eq(m.shortModel('claude-3-5-haiku-20241022'), 'haiku-3.5', 'shortModel old-style haiku')
eq(m.shortModel('claude-opus-4-1@20250805'), 'opus-4.1', 'shortModel vertex style')
eq(m.shortModel('us.anthropic.claude-opus-4-20250514-v1:0'), 'opus-4', 'shortModel bedrock style')
eq(m.shortModel('claude-opus-5-5[1m]'), 'opus-5.5[1m]', 'shortModel keeps context suffix')
eq(m.shortModel('gpt-5'), 'gpt-5', 'shortModel unknown passthrough')
eq(m.summarizeTool('Bash', { command: 'ls -la\nrm x', description: 'List files' }).short, 'Bash: List files', 'Bash uses description')
eq(m.summarizeTool('Bash', { command: '\n  npm test --silent\nmore' }).short, 'Bash: npm test --silent', 'Bash falls back to first command line')
eq(m.summarizeTool('Read', { file_path: '/a/b/c.txt', offset: 40 }).short, 'Read c.txt:40', 'Read basename')
eq(m.summarizeTool('Write', { file_path: '/a/b.html', content: 'x'.repeat(2048) }).short, 'Write b.html (2.0KB)', 'Write basename + size')
eq(m.summarizeTool('WebSearch', { query: 'full moon' }).short, 'WebSearch full moon', 'WebSearch query')
eq(m.summarizeTool('WebFetch', { url: 'https://www.example.com/x' }).short, 'WebFetch example.com/x', 'WebFetch strips scheme')
eq(m.summarizeTool('mcp__claude-vscode__getDiagnostics', { uri: 'file:///x' }).short, 'vscode:getDiagnostics file:///x', 'mcp tool name')
eq(m.clean('a\x1b[31mred\x1b[0m\x07\nb', 50), 'aredb'.replace('redb', 'red b'), 'clean strips escapes/control chars')
const lim = m.parseLimit("You've hit your session limit · resets 2:10am (America/Los_Angeles)")
eq([!!lim, lim?.resets], [true, '2:10am (America/Los_Angeles)'], 'parseLimit reset text')
eq(m.parseLimit('all good'), null, 'parseLimit ignores normal text')
eq(m.trunc('abcdefghij', 5), 'abcd…', 'trunc ascii')
eq(m.strWidth(m.trunc('日本語テキスト', 7)), 7, 'trunc wide chars keeps width')
eq(m.splitKeys('j\x1b[A\x1b\rq'), ['j', '\x1b[A', '\x1b', '\r', 'q'], 'splitKeys')
eq(m.parseArgs(['--run', 'wf_x', '--width=90', '--once']), { run: 'wf_x', width: 90, once: true }, 'parseArgs')

section('script meta (no eval)')
const scriptText = fs.readFileSync(path.join(fx.sdir, 'workflows', 'scripts', 'demo-running-wf_run00001-aaa.js'), 'utf8')
const meta = m.extractMeta(scriptText)
eq([meta.name, meta.phases.map((p) => p.title)], ['demo-running', ['Design', 'Build']], 'meta literal with comments + trailing commas')
eq(m.extractMeta("export const meta = { name: 'x', phases: [{ title: `T` }], fn: foo() }").name, 'x', 'meta with non-literal falls back')
const est = m.estimateAgents(scriptText)
eq([est.total, est.perPhase], [4, { Design: 2, Build: 1, Verify: 1 }], 'agent() estimate ignores strings')
eq(m.parseJsLiteral("{a:1,'b':[true,null,-2.5e1,0x10],c:`t`,}").value, { a: 1, b: [true, null, -25, 16], c: 't' }, 'parseJsLiteral values')
let threw = false
try { m.parseJsLiteral('{a: process.exit(1)}') } catch { threw = true }
ok(threw, 'parseJsLiteral refuses code')

section('progress files')
eq(m.promptTotal('x\nDeliverables, in order:\n1. a\n   - sub\n2. b\n3. c\nReturn things.\n4. not this'), 3, 'promptTotal counts numbered deliverables')
eq(m.promptTotal('write progress.md listing these items as todo: a | b | c | d.\n'), 4, 'promptTotal counts todo items')
eq(m.parseProgress('todo: a\ntodo: b\ntodo: c\ndone: a | x\n'), { kind: 'items', done: 1, total: 3, last: 'a | x' }, 'parseProgress todo/done')
eq(m.parseProgress('# t\ndone: 1. x\ndone: 2. y\ndone: report\n', 2), { kind: 'items', done: 3, total: 3, last: 'report' }, 'parseProgress done beyond deliverables')
eq(m.parseProgress('# f\n## F1 a\n- x\n## F2 b\n', null, true).done, 2, 'parseProgress findings sections')
const evalParent = path.join(fx.work, 'eval')
fs.mkdirSync(path.join(evalParent, 'sun'), { recursive: true }); fs.mkdirSync(path.join(evalParent, 'logo'), { recursive: true })
eq(m.progressCandidates(`Progress protocol: your folder is ${evalParent}/<your name>/ (mkdir -p). Append to findings.md.`, 'eval:sun').slice(0, 2), [evalParent + '/sun/progress.md', evalParent + '/sun/findings.md'], 'placeholder folder resolved from label')
eq(m.progressCandidates('see $A/dusk/progress.md and /real/dir/progress.md', 'x')[0], '/real/dir/progress.md', 'paths after $VAR are not taken')
fs.rmSync(evalParent, { recursive: true, force: true })

// ───────────────────────── fixture runs ─────────────────────────
section('running run')
const R = load('wf_run00001-aaa')
const V = R.view()
eq(V.status, 'running', 'status running (no run json)')
eq(V.slots.map((s) => [s.label, s.status]), [['design:one', 'done'], ['design:two', 'running'], ['build:main', 'running']], 'slots and statuses')
eq(V.slots.map((s) => s.modelShort), ['opus-5.5', 'opus-5.5', 'sonnet-4.5'], 'models from message.model')
eq(V.slots[0].progress && [V.slots[0].progress.done, V.slots[0].progress.total], [3, 3], 'design agent progress = done lines / deliverables')
eq(V.slots[1].progress && [V.slots[1].progress.done, V.slots[1].progress.total], [2, 4], 'edit-stage progress = done / todo items')
eq(V.slots[2].progress, null, 'no progress file -> activity indicator')
eq([V.slots[2].stalled, V.slots[2].waitingOn], [true, 'Bash'], 'stalled detection while waiting on Bash')
eq([V.slots[1].stalled, V.slots[1].activity.state, V.slots[1].activity.text], [false, 'pending', 'WebFetch developers.cloudflare.com/workers/runtime-apis/cache/'], 'current activity = pending WebFetch')
eq([V.slots[1].toolCalls, V.slots[1].toolErrors, V.slots[1].badLines], [3, 1, 1], 'tool calls, tool errors, malformed line skipped')
eq(V.slots.map((s) => s.ctx), [41000, 52000, 18000], 'context size = input + cache read + cache creation')
eq(V.totals.harnessTokens, 41000 + 52000 + 18000, 'run tokens = sum of latest contexts')
eq([V.counts.done, V.counts.running, V.expected], [1, 2, 4], 'counts and script estimate')
eq(V.phases.map((p) => [p.title, p.done, p.running, p.current]), [['Design', 1, 1, false], ['Build', 0, 1, true]], 'phase grouping + current phase')
const feed = R.feed(100)
ok(feed.some((e) => e.kind === 'toolerr' && /expected 3 got 4/.test(e.text)), 'feed has the tool error')
ok(feed.every((e, i) => i === 0 || feed[i - 1].ts <= e.ts), 'feed is time-ordered')
ok(!feed.some((e) => e.kind === 'result'), 'feed omits plain tool results')

section('completed run')
const C = load('wf_done0001-bbb').view()
eq([C.status, C.name, C.totals.jsonTokens, C.totals.toolCalls, C.totals.jsonToolCalls], ['completed', 'demo-done', 16024, 2, 2], 'status, name, totals agree with run json')
eq(C.slots[0].result, 'ship it', 'result preview from journal')
eq(C.elapsedMs, 600000, 'elapsed from run json durationMs')

section('failed run with session limit')
const F = load('wf_fail0001-ccc').view()
eq([F.status, F.counts.failed], ['failed', 2], 'failed status + failed agents')
ok(F.limit && F.limit.current && F.limit.resets === '2:10am (America/Los_Angeles)', 'limit banner data (reset time from the error text)', JSON.stringify(F.limit))
ok(/session limit/.test(F.slots[0].error || ''), 'failed agent shows the limit error', F.slots[0].error)
eq([F.slots[1].model, F.slots[1].modelShort], [null, '~opus-5.5'], 'synthetic messages do not set a model (run default shown as assumed)')

section('resumed run (cached results, retry under a new key)')
const RR = load('wf_resu0001-ddd').view()
eq(RR.status, 'running', 'stale run json (older than journal) -> running again')
eq(RR.slots.map((s) => [s.label, s.status, s.attempts]), [['understand:flow', 'cached', 1], ['design:x', 'running', 2]], 'cached slot + merged retry')
eq(RR.slots[1].activity.state, 'thinking', 'api request after the last event = model is thinking')

section('partial trailing line')
const P = load('wf_part0001-eee')
const pa = [...P.agents.values()][0]
ok(pa.reader.pending > 0, 'partial line held back')
eq(P.view().slots[0].activity.state, 'pending', 'tool still pending before the rest arrives')
fs.appendFileSync(pa.file, fs.readFileSync(path.join(FIX, 'partial-rest.txt'), 'utf8'))
P.poll()
eq([pa.reader.pending, pa.events.filter((e) => e.kind === 'result').length, pa.bad], [0, 1, 0], 'completed line parsed once, no garbage')
eq(P.view().slots[0].activity.state, 'after-tool', 'activity moves on after the result')

section('file appearing mid-run, truncation, permission errors')
{
  const dir = runInfo('wf_part0001-eee').dir
  const nid = 'a400000000000000a'
  const f = path.join(dir, `agent-${nid}.jsonl`)
  fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: 'late agent' }, timestamp: new Date(NOW - 1000).toISOString() }) + '\n')
  P.poll()
  ok(P.agents.has(nid) && P.view().slots.some((s) => s.agentId === nid), 'new transcript picked up without restart')
  fs.writeFileSync(f, '')
  P.poll()
  eq(P.agents.get(nid).prompt, null, 'truncated transcript resets the agent state')
  fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: 'again' }, timestamp: new Date(NOW).toISOString() }) + '\n')
  fs.chmodSync(f, 0o000)
  let err = null
  try { P.poll() } catch (e) { err = e }
  const v = P.view()
  fs.chmodSync(f, 0o644)
  fs.rmSync(f)
  ok(!err && (process.getuid?.() === 0 || v.errors.some((e) => /EACCES/.test(e))), 'unreadable file is reported, not thrown', JSON.stringify(v.errors))
}

// the appends above used the real clock; put the partial run back in the frozen past
for (const f of fs.readdirSync(runInfo('wf_part0001-eee').dir)) { const t = new Date(NOW - 120_000); fs.utimesSync(path.join(runInfo('wf_part0001-eee').dir, f), t, t) }
{ const t = new Date(NOW - 120_000); fs.utimesSync(runInfo('wf_part0001-eee').dir, t, t) }

section('run finishing while watched')
{
  const info = runInfo('wf_run00001-aaa')
  const r = new m.Run(info)
  r.poll()
  eq(r.status(), 'running', 'running before the json appears')
  fs.writeFileSync(info.jsonPath, JSON.stringify({ runId: info.runId, status: 'completed', workflowName: 'demo-running', totalTokens: 5, totalToolCalls: 6, durationMs: 1000, startTime: NOW - 1000, workflowProgress: [] }))
  r.poll()
  const v = r.view()
  eq([v.status, v.slots.find((s) => s.label === 'design:two').status], ['completed', 'stopped'], 'flips to completed; unfinished agents show as stopped')
  ok(r.feed(5).some((e) => e.kind === 'status' && /completed/.test(e.text)), 'status change appears in the feed')
  fs.rmSync(info.jsonPath)
}

section('emoji and wide characters')
{
  eq(['✅', '❌', '⚡', '✨', '🫠', '🚀', '日本'].map(m.strWidth), [2, 2, 2, 2, 2, 2, 4], 'emoji presentation + CJK are 2 columns')
  eq(['✓', '✗', '⚠', '▶', '◆', '↻', '⠋', 'é', 'é'].map(m.strWidth), [1, 1, 1, 1, 1, 1, 1, 1, 1], 'UI glyphs and accents are 1 column')
  eq([m.strWidth('⚠️'), m.strWidth('👍🏽'), m.strWidth('‍')], [2, 2, 0], 'VS16 makes a text symbol wide; skin tone and ZWJ add nothing')
  eq([m.clean('👨‍👩‍👧 ⚠️ 👍🏽 🇺🇸'), m.strWidth(m.clean('👨‍👩‍👧 ⚠️ 👍🏽 🇺🇸'))], ['👨👩👧 ⚠ 👍 US', 14], 'clean() tames emoji sequences to predictable widths')
  for (const W of [7, 8, 9, 10]) ok(m.strWidth(m.trunc('ab✅✅⚠️cd✨ef', W)) <= W, `trunc never exceeds ${W} columns with emoji`)
  const E = load('wf_emoj0001-fff')
  for (const W of [80, 120, 160]) {
    const once = m.renderMain([E], W, Infinity, { once: true, noSel: true })
    ok(once.every((l) => m.strWidth(l) <= W), `emoji run --once fits ${W} columns`, once.map((l) => m.strWidth(l)).join(','))
    const tui = m.renderMain([E], W, 30, { sel: 0 })
    ok(tui.length === 30 && tui.every((l) => m.strWidth(l) <= W), `emoji run TUI frame fits ${W}x30`)
    const fo = m.renderFocus(E, E.view().slots[0].key, W, 30, {})
    ok(fo.length === 30 && fo.every((l) => m.strWidth(l) <= W), `emoji run focus frame fits ${W}x30`)
  }
  snapshot('emoji-80', m.renderMain([load('wf_emoj0001-fff')], 80, Infinity, { once: true, noSel: true }).join('\n'))
  snapshot('emoji-160', m.renderMain([load('wf_emoj0001-fff')], 160, Infinity, { once: true, noSel: true }).join('\n'))
}

section('relaunched run (script named after the original run)')
{
  const RL = load('wf_relu0001-ggg')
  const v = RL.view()
  eq([v.name, v.phases.map((p) => p.title), RL.metaSource], ['relaunch-demo', ['Fix', 'Ship'], 'session transcript'], 'script found via the session transcript')
  const LB = load('wf_relb0001-hhh')
  eq([LB.view().name, LB.metaSource, path.basename(LB.scriptPath)], ['labelled', 'labels', 'labelled-wf_orig0002-yyy.js'], 'script found by its agent labels (decoy lacks one)')
}

section('progress file choice')
{
  const PR = load('wf_prog0001-jjj')
  const a = [...PR.agents.values()][0]
  const own = path.join(fx.work, 'mine', 'progress.md')
  const s0 = PR.view().slots[0]
  eq([s0.progress.kind, s0.progress.path], ['missing', own], 'own progress.md (not the input findings.md) is the candidate before it exists')
  fs.writeFileSync(own, 'todo: a\ntodo: b\ntodo: c\ntodo: d\ndone: a | x\ndone: b | y\n')
  m.setClock(NOW + 4000)
  PR.poll()
  const s1 = PR.view().slots[0]
  eq([s1.progress.kind, s1.progress.done, s1.progress.total, s1.progress.path], ['items', 2, 4, own], 'switches to the own progress.md once it exists (re-checked every 3 s)')
  // an agent that writes a file itself always wins
  const other = path.join(fx.work, 'mine', 'extra', 'progress.md')
  fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, 'done: z\n')
  a.observePaths('Bash', { command: `cat >> ${other} <<'EOF'\ndone: z\nEOF` })
  a.observePaths('Bash', { command: `cat ${fx.work}/critic/findings.md` })
  PR.poll()
  eq([PR.view().slots[0].progress.path, a._observed.length], [other, 1], 'a file the agent writes (>> redirect) outranks the prompt; a file it only reads does not count')
  m.setClock(NOW)
  fs.rmSync(path.join(fx.work, 'mine'), { recursive: true, force: true })
  eq(m.progressCandidates(`input ${fx.work}/critic/findings.md\nProgress protocol: your folder is /x/me/. Append to progress.md.`, 'a'), ['/x/me/progress.md', '/x/me/findings.md'], 'findings.md outside the own folder is never a candidate')
  eq(m.parseProgress('todo: a\n', 5).total, 1, 'todo list total')
  const empty = m.renderMain([load('wf_run00001-aaa')], 160, Infinity, { once: true, noSel: true })
  void empty
}

section('quiet runs with a pending tool call')
{
  eq([load('wf_long0001-kkk').status(), m.quickStat(runInfo('wf_long0001-kkk')).status], ['running', 'running'], '25 min in one Bash call: still running (view + quickStat)')
  eq([load('wf_dead0001-lll').status(), m.quickStat(runInfo('wf_dead0001-lll')).status], ['idle', 'idle'], 'pending for 3 h: idle')
  const v = load('wf_long0001-kkk').view().slots[0]
  eq([v.stalled, v.waitingOn], [true, 'Bash'], 'shown as stalled? while waiting')
}

section('live journal lines are stamped when they were written')
{
  const info = runInfo('wf_live0001-iii')
  const r = new m.Run(info)
  r.poll()
  fs.appendFileSync(path.join(info.dir, 'journal.jsonl'), JSON.stringify({ type: 'result', key: 'v2:r', agentId: 'a940000000000000a', result: 'released' }) + '\n')
  const t = new Date(NOW - 60_000); fs.utimesSync(path.join(info.dir, 'journal.jsonl'), t, t)
  r.poll()
  const done = r.feed(0).find((e) => e.kind === 'done')
  eq(done && done.ts, NOW - 60_000, 'finish event at the journal write time, not the last transcript line')
  const s = r.view().slots[0]
  eq([s.status, s.elapsedMs], ['done', 19 * 60_000], 'agent time runs until the result was recorded')
  const order = r.feed(0).map((e) => e.ts)
  ok(order.every((x, i) => !i || order[i - 1] <= x), 'feed stays in time order')
}

section('selection and small display fixes')
{
  const lines = m.renderMain([load('wf_run00001-aaa')], 100, 24, { sel: 1, attrs: true })
  const selLine = lines.find((l) => l.includes('\x1b[7m'))
  ok(selLine && /design:two/.test(selLine) && !/\x1b\[48;5/.test(lines.join('')), 'selected row uses reverse video (no fixed dark background)')
  const plain = m.renderMain([load('wf_run00001-aaa')], 100, 24, { sel: 1 })
  ok(plain.some((l) => /^⠋▸design:two/.test(l) || /^.▸design:two/.test(l)), 'plain text keeps the status glyph and marks the row with ▸')
  const v = load('wf_run00001-aaa').view()
  void v
  const fo = m.renderFocus(load('wf_run00001-aaa'), load('wf_run00001-aaa').view().slots[1].key, 160, 20, {})
  ok(/q quit · following new events/.test(fo[fo.length - 1]), 'focus footer wording')
  const pr = m.renderMain([load('wf_run00001-aaa')], 160, Infinity, { once: true, noSel: true })
  void pr
}

// ───────────────────────── frames ─────────────────────────
section('snapshot frames')
for (const W of [80, 160]) {
  snapshot(`running-${W}`, m.renderMain([load('wf_run00001-aaa')], W, Infinity, { once: true, noSel: true }).join('\n'))
  snapshot(`failed-${W}`, m.renderMain([load('wf_fail0001-ccc')], W, Infinity, { once: true, noSel: true }).join('\n'))
  snapshot(`resumed-${W}`, m.renderMain([load('wf_resu0001-ddd')], W, Infinity, { once: true, noSel: true }).join('\n'))
  const lines = m.renderMain([load('wf_run00001-aaa')], W, 24, { sel: 1 })
  snapshot(`tui-${W}x24`, lines.join('\n'))
  ok(lines.length === 24 && lines.every((l) => m.strWidth(l) <= W), `TUI frame fits ${W}x24 exactly`, lines.map((l) => m.strWidth(l)).join(','))
  const r = load('wf_run00001-aaa')
  const fl = m.renderFocus(r, r.view().slots[1].key, W, 30, {})
  snapshot(`focus-${W}`, fl.join('\n'))
  ok(fl.length === 30 && fl.every((l) => m.strWidth(l) <= W), `focus frame fits ${W}x30`)
}
{
  const small = m.renderMain([load('wf_run00001-aaa')], 60, 12, {})
  ok(small.length === 12 && small.every((l) => m.strWidth(l) <= 60), 'tiny terminal (60x12) still fits')
  const all = m.renderMain([load('wf_run00001-aaa'), load('wf_resu0001-ddd')], 120, 40, { sel: 3 })
  ok(all.length === 40 && all.join('\n').includes('demo-resume') && all.join('\n').includes('demo-running'), 'stacked view of two runs')
}

// ───────────────────────── CLI ─────────────────────────
const before = listing(FIX)
section('CLI')
{
  const l = cli(['--root', FIX, '--list', '--width', '140'])
  ok(l.status === 0 && /wf_run00001-aaa/.test(l.stdout) && /demo-fail\s+failed/.test(l.stdout) && !/\x1b\[/.test(l.stdout), '--list (no colour when piped)', l.stderr + l.stdout)
  const j = cli(['--root', FIX, '--json', '--run', 'wf_fail'])
  let parsed = null
  try { parsed = JSON.parse(j.stdout) } catch {}
  ok(parsed && parsed.status === 'failed' && parsed.limit && parsed.slots.length === 2, '--json snapshot', j.stderr)
  const d = cli(['--root', FIX, '--once', '--width', '100'])
  ok(d.status === 0 && /demo-resume/.test(d.stdout), 'default = most recently active running run', d.stdout.split('\n')[0])
  const col = cli(['--root', FIX, '--once', '--run', 'run0', '--color'])
  ok(/\x1b\[/.test(col.stdout), '--color forces colour')
  const nc = cli(['--root', FIX, '--once', '--run', 'run0', '--color'], { NO_COLOR: '1' })
  ok(/\x1b\[/.test(nc.stdout), '--color beats NO_COLOR')
  const amb = cli(['--root', FIX, '--once', '--run', 'wf_'])
  ok(amb.status === 1 && /ambiguous/.test(amb.stderr), 'ambiguous --run prefix is an error', amb.stderr)
  const none = cli(['--root', path.join(FIX, 'nope'), '--once'])
  ok(none.status === 1 && /no workflow runs|ENOENT/.test(none.stderr), 'missing root is reported', none.stderr)
  const fd = cli(['--root', FIX, '--feed', '--once', '--run', 'run0', '--agent', 'two', '--backlog', '50'])
  ok(fd.status === 0 && /design:two/.test(fd.stdout) && !/design:one\s/.test(fd.stdout.split('\n').slice(1).join('\n')) && !/\x1b\[/.test(fd.stdout), '--feed --agent filter, plain text', fd.stdout)
  const bad = cli(['--bogus'])
  ok(bad.status === 2, 'unknown option exits 2')
  const piped = spawnSync(process.execPath, [TOOL, '--root', FIX, '--run', 'run0', '--backlog', '3'], { encoding: 'utf8', timeout: 4000, env: process.env })
  ok(/^# demo-running/.test(piped.stdout) && piped.stdout.trim().split('\n').length === 4, 'stdout not a TTY -> feed mode (header + 3 backlog lines)', piped.stdout)
}

section('live feed (append while following)')
{
  const os = await import('node:os')
  const busy = os.loadavg()[0] > 2 * os.cpus().length
  const limit = busy ? 5000 : 1000
  await new Promise((resolve) => {
    const info = runInfo('wf_part0001-eee')
    const f = fs.readdirSync(info.dir).find((x) => x.endsWith('.jsonl') && x.startsWith('agent-'))
    const child = spawn(process.execPath, [TOOL, '--root', FIX, '--feed', '--run', 'part', '--backlog', '0', '--interval', '200'], { env: { ...process.env, ULTRAWATCH_NOW: '' } })
    let out = ''
    let wroteAt = 0
    let finished = false
    // append only once the feed is up (it prints its header after the first poll)
    child.stdout.on('data', (d) => {
      out += d
      if (wroteAt) return
      wroteAt = -1
      setTimeout(() => {
        wroteAt = Date.now()
        fs.appendFileSync(path.join(info.dir, f), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'm-live', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu-live', name: 'Grep', input: { pattern: 'LIVE_MARKER' } }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n')
      }, 300)
    })
    const iv = setInterval(() => {
      if (out.includes('LIVE_MARKER') && !finished) { finished = true; clearInterval(iv); const lag = Date.now() - wroteAt; child.kill(); ok(lag < limit, `appended tool call shown in the feed within ${limit / 1000} s (${lag} ms${busy ? ', machine heavily loaded' : ''})`); resolve() }
    }, 20)
    setTimeout(() => { if (finished) return; finished = true; clearInterval(iv); child.kill(); ok(false, 'appended tool call shown in the feed', out); resolve() }, 20000)
  })
}

// ───────────────────────── performance ─────────────────────────
if (!SKIP_BIG) {
  section('performance (20 MB transcript)')
  const bigRoot = path.join(HERE, 'tmp-big')
  const big = makeBig(bigRoot, 20)
  const size = fs.statSync(big.agentFile).size
  // Wall-clock limits are the requirement. On a machine so loaded that wall time mostly measures waiting for a CPU
  // (load average above 2x the core count), the CPU time this process spent is checked against the same limit.
  const os = await import('node:os')
  const busy = os.loadavg()[0] > 2 * os.cpus().length
  const cpuMs = (c0) => { const u = process.cpuUsage(c0); return (u.user + u.system) / 1000 }
  const within = (wall, cpu, lim) => wall < lim || (busy && cpu < lim)
  const note = (wall, cpu) => `${wall.toFixed(1)} ms wall, ${cpu.toFixed(1)} ms CPU${busy ? `, load ${os.loadavg()[0].toFixed(0)} on ${os.cpus().length} cores` : ''}`
  const t0 = performance.now(), c0 = process.cpuUsage()
  const br = new m.Run(m.discoverRuns(bigRoot).runs[0])
  br.poll()
  const frame = m.renderMain([br], 160, 50, {})
  const first = performance.now() - t0, firstCpu = cpuMs(c0)
  ok(within(first, firstCpu, 1500), `first frame for ${(size / 1048576).toFixed(1)} MB < 1500 ms (${note(first, firstCpu)})`)
  eq(br.view().slots[0].toolCalls, big.steps, 'all tool calls counted')
  ok(frame.length === 50, 'big frame rendered')
  const add = []
  for (let i = 0; i < 5; i++) add.push(JSON.stringify({ type: 'assistant', timestamp: new Date(NOW).toISOString(), message: { id: 'm-x' + i, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu-x' + i, name: 'Read', input: { file_path: '/x/' + i } }], usage: { input_tokens: 1, output_tokens: 1 } } }))
  fs.appendFileSync(big.agentFile, add.join('\n') + '\n')
  const t1 = performance.now(), c1 = process.cpuUsage()
  br.poll()
  m.renderMain([br], 160, 50, {})
  const tick = performance.now() - t1, tickCpu = cpuMs(c1)
  ok(within(tick, tickCpu, 50), `incremental tick < 50 ms (${note(tick, tickCpu)})`)
  const t2 = performance.now(), c2 = process.cpuUsage()
  for (let i = 0; i < 10; i++) { br.poll(); m.renderMain([br], 160, 50, {}) }
  const idle = (performance.now() - t2) / 10, idleCpu = cpuMs(c2) / 10
  ok(within(idle, idleCpu, 20), `idle tick < 20 ms (${note(idle, idleCpu)})`)
  fs.rmSync(bigRoot, { recursive: true, force: true })
}

// ───────────────────────── pseudo-terminal ─────────────────────────
const hasScript = fs.existsSync('/usr/bin/script')
if (!SKIP_PTY && hasScript && process.platform === 'darwin') {
  section('TUI in a pseudo-terminal (script)')
  const { emulate } = await import('./vt.mjs')
  const outDir = path.join(HERE, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  // Runs in its own process group: on timeout the whole group (sh, script, node) is killed, so nothing leaks.
  const pty = (name, cols, rows, keys, extraEnv = '', args = `--root '${FIX}' --run run0`) => new Promise((resolve) => {
    const raw = path.join(outDir, name + '.raw')
    fs.rmSync(raw, { force: true })
    // keys wait for what is on screen (w <text>: until the captured output contains it), not for fixed delays,
    // so the tests hold up on a heavily loaded machine. script -F flushes the capture after every write.
    const pre = `w() { n=0; while [ $n -lt 300 ] && ! grep -aq "$1" '${raw}' 2>/dev/null; do sleep 0.1; n=$((n+1)); done; }; f() { n=0; while [ $n -lt 300 ] && [ ! -f "$1" ]; do sleep 0.1; n=$((n+1)); done; }; `
    const cmd = `( ${pre}${keys} ) | script -F -q '${raw}' sh -c "stty cols ${cols} rows ${rows}; ${extraEnv} exec '${process.execPath}' '${TOOL}' ${args}" >/dev/null 2>&1`
    const ch = spawn('sh', ['-c', cmd], { env: { ...process.env, ULTRAWATCH_NOW: '' }, detached: true, stdio: 'ignore' })
    const killAll = () => { try { process.kill(-ch.pid, 'SIGKILL') } catch {} }
    const timer = setTimeout(() => { killAll(); console.log(`  (pty ${name} timed out; process group killed)`) }, 45000)
    ch.on('exit', () => { clearTimeout(timer); killAll(); resolve(fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : '') })
  })
  const restoredOk = (d) => d.includes('\x1b[?1049h') && d.includes('\x1b[?25l') && d.lastIndexOf('\x1b[?1049l') > d.lastIndexOf('\x1b[?2026h') && d.lastIndexOf('\x1b[?25h') > d.lastIndexOf('\x1b[?25l')
  for (const [cols, rows] of [[80, 24], [160, 45]]) {
    const d = await pty(`q-${cols}`, cols, rows, "w demo-running; sleep 0.3; printf j; sleep 0.4; printf '\\r'; w 'Esc back'; sleep 0.3; printf '\\033'; sleep 0.5; printf '?'; w 'keys'; sleep 0.3; printf x; sleep 0.5; printf q")
    ok(restoredOk(d), `${cols}x${rows}: alt screen + cursor restored after q`)
    // every frame is bracketed by synchronized-output begin/end (one write per frame: no flicker)
    const parts = d.split('\x1b[?2026h').slice(1)
    const frames = parts.length
    ok(frames >= 3 && parts.every((p) => p.includes('\x1b[?2026l') && p.indexOf('\x1b[?2026l') > p.indexOf('\x1b[H')), `${cols}x${rows}: ${frames} frames, each a home + full repaint inside one synchronized update`)
    ok(!/\x1b\[2J/.test(d.slice(d.indexOf('\x1b[?2026h'))), `${cols}x${rows}: no full-screen clears between frames`)
    const screen = emulate(d.slice(0, d.lastIndexOf('\x1b[?1049l')), cols, rows).text
    fs.writeFileSync(path.join(outDir, `screen-${cols}x${rows}.txt`), screen)
    ok(/demo-running/.test(screen) && screen.split('\n').length === rows, `${cols}x${rows}: final screen shows the dashboard`)
    const focus = emulate(d.slice(0, d.indexOf('\x1b[?2026l', d.indexOf('\r') > 0 ? d.indexOf('← Esc') : 0) + 8), cols, rows).text
    ok(/← Esc/.test(d) && /ultrawatch .* keys/.test(d), `${cols}x${rows}: focus view and help were shown`)
    void focus
  }
  const ct = await pty('ctrlc', 100, 30, "w demo-running; sleep 0.3; printf '\\003'")
  ok(restoredOk(ct), 'Ctrl-C restores the terminal')
  const pidf = path.join(outDir, 'sigterm.pid')
  fs.rmSync(pidf, { force: true })
  const term = await pty('sigterm', 100, 30, `w demo-running; f '${pidf}'; sleep 0.3; kill -TERM $(cat '${pidf}')`, '', `--root '${FIX}' --run run0 & p=\\$!; echo \\$p > '${pidf}'; wait \\$p`)
  ok(restoredOk(term), 'SIGTERM restores the terminal')
  const crash = await pty('crash', 100, 30, 'w demo-running; w simulated', 'ULTRAWATCH_TEST_CRASH_MS=700')
  ok(restoredOk(crash) && /simulated crash/.test(crash), 'a crash restores the terminal and prints the error')
  const rsf = path.join(outDir, 'resized.flag')
  fs.rmSync(rsf, { force: true })
  const rs = await pty('resize', 120, 30, `w demo-running; f '${rsf}'; sleep 1.2; printf q`, '', `--root '${FIX}' --run run0 </dev/tty & p=\\$!; n=0; while [ \\$n -lt 300 ] && ! grep -aq demo-running '${path.join(outDir, 'resize.raw')}'; do sleep 0.1; n=\\$((n+1)); done; stty cols 70 rows 20 </dev/tty; kill -WINCH \\$p; touch '${rsf}'; wait \\$p`)
  ok(restoredOk(rs), 'resize run exits cleanly on q')
  const endAt = rs.lastIndexOf('\x1b[?2026l')
  const lastFrame = rs.slice(rs.lastIndexOf('\x1b[?2026h', endAt), endAt)
  const lfl = lastFrame.replace(/\x1b\[\?2026[hl]|\x1b\[H|\x1b\[J/g, '').split('\n').map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, ''))
  ok(lfl.length === 20 && lfl.every((l) => m.strWidth(l) <= 70), 'resize (SIGWINCH) re-lays out the frame for 70x20', lfl.length + ' lines, widths ' + lfl.map((l) => m.strWidth(l)).join(','))
  // terminal stops reading output: SIGTERM must still work (no blocking write / drain) and the tty ends cooked
  const pyOut = spawnSync('python3', [path.join(HERE, 'stuck-term.py'), TOOL, FIX, path.join(outDir, 'stuck.pid')], { encoding: 'utf8', timeout: 30000 })
  let stuck = null
  try { stuck = JSON.parse(pyOut.stdout.trim().split('\n').pop()) } catch {}
  ok(stuck && stuck.exited && stuck.secs < 2 && stuck.icanon && stuck.echo, 'SIGTERM exits promptly while the terminal is not reading, tty left cooked', pyOut.stdout + pyOut.stderr)
  // nothing from these tests may keep running
  await new Promise((r) => setTimeout(r, 300))
  const left = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(TOOL) && l.includes(FIX))
  ok(left.length === 0, 'no ultrawatch test process left running', left.join('\n'))
} else console.log('\n(skipping pseudo-terminal tests)')

section('read-only')
const after = listing(FIX)
const changed = after.split('\n').filter((l) => !before.includes(l) && !/partial-rest|wf_part0001-eee/.test(l))
ok(changed.length === 0, 'ultrawatch wrote nothing into the watched tree', changed.slice(0, 5).join('\n'))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1) }
