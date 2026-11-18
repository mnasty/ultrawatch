// Builds deterministic fixture trees that mimic ~/.claude/projects for ultrawatch's tests.
// Every timestamp is relative to NOW (2026-10-27T18:30:00Z), which the tests freeze via ULTRAWATCH_NOW.
import fs from 'node:fs'
import path from 'node:path'

export const NOW = Date.parse('2026-10-27T18:30:00.000Z')
const iso = (minAgo, sec = 0) => new Date(NOW - minAgo * 60_000 + sec * 1000).toISOString()

const J = (o) => JSON.stringify(o)
let msgN = 0, toolN = 0, uuidN = 0
const uuid = () => 'u' + String(++uuidN).padStart(8, '0')

// ── transcript line builders (shapes copied from real Claude Code transcripts) ──
export function userPrompt(text, ts, agentId) {
  return J({ parentUuid: null, isSidechain: true, agentId, type: 'user', message: { role: 'user', content: text }, uuid: uuid(), timestamp: ts, sessionId: 'sess', version: '2.1.303' })
}
export function apiRequest(ts, agentId, model = 'claude-opus-5-5') {
  return J({ type: 'api-request', sessionId: 'sess', agentId, id: uuid(), timestamp: ts, version: '2.1.303', querySource: 'agent:builtin:workflow-subagent', params: { model, max_tokens: 128000 } })
}
export function apiBlob(agentId, size = 2000) {
  return J({ type: 'api-request-blob', sessionId: 'sess', agentId, hash: 'h' + uuid(), message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(size) }] } })
}
function usage(ctx, out) {
  return { input_tokens: 2, cache_creation_input_tokens: Math.round(ctx * 0.1), cache_read_input_tokens: ctx - 2 - Math.round(ctx * 0.1), output_tokens: out, service_tier: 'standard' }
}
/** one assistant message split into lines per content block (like the real transcripts) */
export function assistant(blocks, ts, agentId, { ctx = 20000, out = 8, model = 'claude-opus-5-5', finalOut = null } = {}) {
  const id = 'msg_' + String(++msgN).padStart(6, '0')
  return blocks.map((b, i) => J({ parentUuid: uuid(), isSidechain: true, agentId, message: { model, id, type: 'message', role: 'assistant', content: [b], stop_reason: i === blocks.length - 1 && finalOut ? 'tool_use' : null, usage: usage(ctx, i === blocks.length - 1 && finalOut ? finalOut : out) }, type: 'assistant', uuid: uuid(), timestamp: ts, requestId: 'req_' + id }))
}
export function toolUse(name, input) { return { type: 'tool_use', id: 'toolu_' + String(++toolN).padStart(6, '0'), name, input } }
export function toolResult(tu, content, ts, agentId, isError = false) {
  return J({ parentUuid: uuid(), isSidechain: true, agentId, type: 'user', message: { role: 'user', content: [{ tool_use_id: tu.id, type: 'tool_result', content, is_error: isError }] }, uuid: uuid(), timestamp: ts, sessionId: 'sess' })
}
export function attachment(ts, agentId, att) { return J({ parentUuid: uuid(), isSidechain: true, agentId, attachment: att, type: 'attachment', uuid: uuid(), timestamp: ts }) }
export function limitLine(ts, agentId, text = "You've hit your session limit · resets 2:10am (America/Los_Angeles)") {
  return J({ parentUuid: uuid(), isSidechain: true, agentId, type: 'assistant', uuid: uuid(), timestamp: ts, message: { id: uuid(), model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', type: 'message', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: 'text', text }] }, apiError: 'usage_limit_reached', apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: Math.floor((NOW + 3 * 3600_000) / 1000), rateLimitType: 'five_hour' } } })
}
export function interrupted(ts, agentId) { return J({ type: 'user', agentId, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, timestamp: ts, uuid: uuid() }) }

const harness = (task) => [
  "[Workflow harness — user request] The harness relays, verbatim and indented below, the user request that triggered this workflow run.\n  please build it",
  "[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. The computed task text follows:\n" + task.split('\n').map((l) => '  ' + l).join('\n'),
]

function setMtime(p, minAgo) { const t = new Date(NOW - minAgo * 60_000); fs.utimesSync(p, t, t) }
function write(p, content) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content) }
function lines(arr) { return arr.flat().join('\n') + '\n' }

export function makeFixtures(root) {
  fs.rmSync(root, { recursive: true, force: true })
  msgN = 0; toolN = 0; uuidN = 0
  const proj = path.join(root, '-Users-test-proj')
  const sess = 'aaaaaaaa-1111-2222-3333-444444444444'
  const sdir = path.join(proj, sess)
  const W = (run) => path.join(sdir, 'subagents', 'workflows', run)
  const meta = (run, id, label, phase) => write(path.join(W(run), `agent-${id}.meta.json`), J({ agentType: 'workflow-subagent', description: label, workflowPhase: phase, spawnDepth: 1 }))
  const script = (run, name, text) => write(path.join(sdir, 'workflows', 'scripts', `${name}-${run}.js`), text)
  const work = path.join(root, 'work') // progress files live here

  // ───────── 1. running run: 3 agents (one done, one working with progress.md, one stalled in a long Bash) ─────────
  {
    const run = 'wf_run00001-aaa'
    script(run, 'demo-running', `export const meta = {
  name: 'demo-running',
  description: 'A running demo workflow with three agents',
  phases: [
    { title: 'Design', detail: 'two designers in parallel' },
    { title: 'Build', detail: 'one builder' }, // trailing comma and comment on purpose
  ],
}
phase('Design')
const a = await agent(\`design one; mention agent( in a string must not count\`, { label: 'design:one', phase: 'Design' })
const b = await agent('design two', { label: 'design:two', phase: 'Design' })
phase('Build')
const c = await agent('build', { label: 'build:main', phase: 'Build' })
phase('Verify')
await agent('verify', { label: 'verify', phase: 'Verify' })
`)
    // agent A: done
    const A = 'a000000000000000a'
    meta(run, A, 'design:one', 'Design')
    const tuA = toolUse('Read', { file_path: '/repo/src/app.tsx' })
    const tuA2 = toolUse('StructuredOutput', { summary: 'design one is finished' })
    write(path.join(W(run), `agent-${A}.jsonl`), lines(
      harness('Design one. Progress protocol (mandatory): your folder is ' + work + '/one/ (mkdir -p). Deliverables, in order:\n1. a sketch\n2. a page\n3. a report')
      .map((t) => userPrompt(t, iso(25), A)).concat([
      attachment(iso(25), A, { type: 'model', identity: { modelId: 'claude-opus-5-5' } }),
      apiRequest(iso(25, 1), A), apiBlob(A),
      ...assistant([{ type: 'thinking', thinking: '', signature: 'x' }, tuA], iso(24), A, { ctx: 30000, out: 12, finalOut: 120 }),
      toolResult(tuA, 'export default function App() {}', iso(24, 2), A),
      apiRequest(iso(24, 3), A),
      ...assistant([{ type: 'text', text: 'The design is done; returning.' }, tuA2], iso(20), A, { ctx: 41000, out: 30 }),
      toolResult(tuA2, 'Structured output provided successfully', iso(20, 1), A),
    ])))
    write(path.join(work, 'one', 'progress.md'), '# one\ndone: 1. a sketch | sketch.html | looked\ndone: 2. a page | page.html | looked\ndone: 3. a report | report.json | final\n')
    // agent B: running, progress.md with todo/done, current tool pending
    const B = 'b000000000000000b'
    meta(run, B, 'design:two', 'Design')
    const tuB1 = toolUse('Bash', { command: 'cd /repo && npm test\nnpm run lint', description: 'Run the unit tests' })
    const tuB2 = toolUse('WebFetch', { url: 'https://developers.cloudflare.com/workers/runtime-apis/cache/', prompt: 'what does the cache api do on workers.dev' })
    const tuB3 = toolUse('Edit', { file_path: '/repo/src/sky.js', old_string: 'a', new_string: 'b' })
    write(path.join(W(run), `agent-${B}.jsonl`), lines([
      harness('Design two. Progress protocol (mandatory): your work folder is ' + work + '/two/ (mkdir -p).\n- On start: write ' + work + '/two/progress.md listing these items as todo: W1 sky | W2 sun | W3 rain | W4 snow.').map((t) => userPrompt(t, iso(22), B)),
      apiRequest(iso(22, 1), B),
      ...assistant([tuB1], iso(21), B, { ctx: 25000, out: 9 }),
      toolResult(tuB1, 'Exit code 1\nFAIL sky.test.js\n  expected 3 got 4', iso(21, 30), B, true),
      ...assistant([{ type: 'text', text: 'One test fails; fixing the sky colour.\nSecond line of text.' }, tuB3], iso(20), B, { ctx: 27000, out: 40 }),
      toolResult(tuB3, 'The file /repo/src/sky.js has been updated successfully.', iso(20, 1), B),
      'this is not json at all {{{',
      ...assistant([tuB2], iso(1), B, { ctx: 52000, out: 7 }),
    ]))
    write(path.join(work, 'two', 'progress.md'), '# two\ntodo: W1 sky\ntodo: W2 sun\ntodo: W3 rain\ntodo: W4 snow\ndone: W1 sky | changed sky.js | sky.test.mjs passes\ndone: W2 sun | sun.js | screenshot sun.png\n')
    // agent C: running, stalled for 5 minutes inside a Bash call
    const C = 'c000000000000000c'
    meta(run, C, 'build:main', 'Build')
    const tuC = toolUse('Bash', { command: 'sleep 999 && make all', description: 'Build everything' })
    write(path.join(W(run), `agent-${C}.jsonl`), lines([
      userPrompt('Build it. No progress file for this one.', iso(12), C),
      apiRequest(iso(12, 1), C, 'claude-sonnet-4-5-20250929'),
      ...assistant([tuC], iso(5), C, { ctx: 18000, out: 5, model: 'claude-sonnet-4-5-20250929' }),
    ]))
    setMtime(path.join(W(run), `agent-${A}.jsonl`), 20); setMtime(path.join(W(run), `agent-${B}.jsonl`), 1); setMtime(path.join(W(run), `agent-${C}.jsonl`), 5)
    write(path.join(W(run), 'journal.jsonl'), lines([
      J({ type: 'launched' }),
      J({ type: 'started', key: 'v2:k1', agentId: A, label: 'design:one', phase: 'Design' }),
      J({ type: 'started', key: 'v2:k2', agentId: B, label: 'design:two', phase: 'Design' }),
      J({ type: 'result', key: 'v2:k1', agentId: A, result: { summary: 'design one is finished' } }),
      J({ type: 'started', key: 'v2:k3', agentId: C, label: 'build:main', phase: 'Build' }),
    ]))
    setMtime(path.join(W(run), 'journal.jsonl'), 12)
  }

  // ───────── 2. completed run with run json ─────────
  {
    const run = 'wf_done0001-bbb'
    const A = 'd000000000000000d'
    meta(run, A, 'judge:only', 'Judge')
    const tu = toolUse('Grep', { pattern: 'TODO', path: '/repo/src' })
    const tu2 = toolUse('StructuredOutput', { verdict: 'ship it' })
    write(path.join(W(run), `agent-${A}.jsonl`), lines([
      userPrompt('Judge the work.', iso(120), A),
      ...assistant([tu], iso(119), A, { ctx: 15000, out: 20 }),
      toolResult(tu, 'src/a.ts:3: // TODO', iso(119, 1), A),
      ...assistant([tu2], iso(110), A, { ctx: 16000, out: 300 }),
      toolResult(tu2, 'Structured output provided successfully', iso(110, 1), A),
    ]))
    write(path.join(W(run), 'journal.jsonl'), lines([J({ type: 'launched' }), J({ type: 'started', key: 'v2:j1', agentId: A, label: 'judge:only', phase: 'Judge' }), J({ type: 'result', key: 'v2:j1', agentId: A, result: { verdict: 'ship it' } })]))
    const js = path.join(sdir, 'workflows', run + '.json')
    write(js, J({ runId: run, workflowName: 'demo-done', status: 'completed', startTime: NOW - 120 * 60_000, durationMs: 10 * 60_000, timestamp: iso(110), phases: [{ title: 'Judge', detail: 'one judge' }], defaultModel: 'claude-opus-5-5', totalTokens: 16024, totalToolCalls: 2, agentCount: 1, logs: [], summary: 'A completed demo', script: "export const meta = { name: 'demo-done', description: 'A completed demo', phases: [{ title: 'Judge' }] }\nphase('Judge')\nawait agent('x')\n", workflowProgress: [{ type: 'workflow_phase', index: 1, title: 'Judge' }, { type: 'workflow_agent', index: 1, label: 'judge:only', phaseIndex: 1, phaseTitle: 'Judge', agentId: A, model: 'claude-opus-5-5', state: 'done', tokens: 16024, toolCalls: 2 }] }))
    const t = new Date(NOW - 109 * 60_000)
    fs.utimesSync(path.join(W(run), 'journal.jsonl'), t, new Date(NOW - 110 * 60_000))
    fs.utimesSync(js, t, t)
  }

  // ───────── 3. failed run: session limit (synthetic message + tool_result error + run json logs) ─────────
  {
    const run = 'wf_fail0001-ccc'
    const A = 'e000000000000000e', B = 'f000000000000000f'
    meta(run, A, 'design:gorey', 'Design'); meta(run, B, 'design:kawaii', 'Design')
    const tu = toolUse('Read', { file_path: '/repo/a.md' })
    write(path.join(W(run), `agent-${A}.jsonl`), lines([
      userPrompt('Design gorey.', iso(60), A),
      ...assistant([tu], iso(59), A, { ctx: 20000, out: 10 }),
      toolResult(tu, "You've hit your session limit · resets 2:10am (America/Los_Angeles)", iso(58), A, true),
      limitLine(iso(58, 1), A),
    ]))
    write(path.join(W(run), `agent-${B}.jsonl`), lines([userPrompt('Design kawaii.', iso(59), B), limitLine(iso(58, 2), B)]))
    write(path.join(W(run), 'journal.jsonl'), lines([J({ type: 'launched' }),
      J({ type: 'started', key: 'v2:g', agentId: A, label: 'design:gorey', phase: 'Design' }), J({ type: 'started', key: 'v2:k', agentId: B, label: 'design:kawaii', phase: 'Design' }),
      J({ type: 'failed', key: 'v2:g', agentId: A }), J({ type: 'failed', key: 'v2:k', agentId: B })]))
    const js = path.join(sdir, 'workflows', run + '.json')
    write(js, J({ runId: run, workflowName: 'demo-fail', status: 'failed', startTime: NOW - 60 * 60_000, durationMs: 2 * 60_000, timestamp: iso(57), phases: [{ title: 'Design' }], defaultModel: 'claude-opus-5-5', totalTokens: 20000, totalToolCalls: 1, logs: ["[design:gorey] failed: You've hit your session limit · resets 2:10am (America/Los_Angeles)"], summary: 'A failed demo', error: 'Error: all designers failed\n    at x (y.js:1:1)', workflowProgress: [] }))
    const t = new Date(NOW - 57 * 60_000)
    fs.utimesSync(path.join(W(run), 'journal.jsonl'), new Date(NOW - 58 * 60_000), new Date(NOW - 58 * 60_000))
    fs.utimesSync(js, t, t)
    for (const f of fs.readdirSync(W(run))) fs.utimesSync(path.join(W(run), f), new Date(NOW - 58 * 60_000), new Date(NOW - 58 * 60_000))
  }

  // ───────── 4. resumed run: cached results (no fresh start), a retry under a NEW key with the same label ─────────
  {
    const run = 'wf_resu0001-ddd'
    const A = 'a100000000000000a', B1 = 'b100000000000000b', B2 = 'b200000000000000b'
    meta(run, A, 'understand:flow', 'Understand'); meta(run, B1, 'design:x', 'Design'); meta(run, B2, 'design:x', 'Design')
    write(path.join(W(run), `agent-${A}.jsonl`), lines([userPrompt('Understand.', iso(300), A), ...assistant([{ type: 'text', text: 'done understanding' }], iso(299), A, { ctx: 9000, out: 50 })]))
    write(path.join(W(run), `agent-${B1}.jsonl`), lines([userPrompt('Design x.', iso(298), B1), ...assistant([{ type: 'text', text: 'working' }], iso(297), B1, { ctx: 9000, out: 5 }), interrupted(iso(296), B1)]))
    const tu = toolUse('Write', { file_path: '/work/x/page.html', content: '<html></html>' })
    write(path.join(W(run), `agent-${B2}.jsonl`), lines([userPrompt('Design x (resumed).', iso(10), B2), ...assistant([tu], iso(9), B2, { ctx: 12000, out: 30 }), toolResult(tu, 'File created successfully', iso(9, 1), B2), apiRequest(iso(0, -20), B2)]))
    write(path.join(W(run), 'journal.jsonl'), lines([J({ type: 'launched' }),
      J({ type: 'result', key: 'v2:u', agentId: A, result: 'cached understanding' }), // cached: result without a fresh start
      J({ type: 'started', key: 'v2:x-old', agentId: B1, label: 'design:x', phase: 'Design' }),
      J({ type: 'failed', key: 'v2:x-old', agentId: B1 }),
      J({ type: 'started', key: 'v2:x-new', agentId: B2, label: 'design:x', phase: 'Design' })]))
    // stale json from the earlier (killed) launch: older than the journal, so the run counts as running again
    const js = path.join(sdir, 'workflows', run + '.json')
    write(js, J({ runId: run, workflowName: 'demo-resume', status: 'killed', startTime: NOW - 300 * 60_000, durationMs: 4 * 60_000, timestamp: iso(296), phases: [{ title: 'Understand' }, { title: 'Design' }], defaultModel: 'claude-opus-5-5', totalTokens: 1, totalToolCalls: 0, logs: [], workflowProgress: [] }))
    fs.utimesSync(js, new Date(NOW - 296 * 60_000), new Date(NOW - 296 * 60_000))
    for (const f of fs.readdirSync(W(run))) setMtime(path.join(W(run), f), 0.5)
  }

  // ───────── 5. partial trailing line (writer mid-line) ─────────
  {
    const run = 'wf_part0001-eee'
    const A = 'a300000000000000a'
    meta(run, A, 'solo', 'Solo')
    const tu = toolUse('WebSearch', { query: 'full moon april 2026' })
    const full = lines([userPrompt('Solo.', iso(3), A), ...assistant([tu], iso(2), A, { ctx: 11000, out: 9 })])
    const next = toolResult(tu, 'results…', iso(1), A)
    write(path.join(W(run), `agent-${A}.jsonl`), full + next.slice(0, 40)) // no newline: half a line
    write(path.join(W(run), 'journal.jsonl'), lines([J({ type: 'launched' }), J({ type: 'started', key: 'v2:s', agentId: A, label: 'solo', phase: 'Solo' })]))
    write(path.join(root, 'partial-rest.txt'), next.slice(40) + '\n')
    for (const f of fs.readdirSync(W(run))) setMtime(path.join(W(run), f), 2)
  }
  // ───────── 6. emoji everywhere (wide emoji, VS16, skin tones, ZWJ, flags) ─────────
  {
    const run = 'wf_emoj0001-fff'
    const A = 'a500000000000000a'
    meta(run, A, 'emoji:✨fx', 'Shine')
    const tu = toolUse('Bash', { command: 'echo ok', description: 'Check ✅ marks ⚡ fast' })
    write(path.join(W(run), `agent-${A}.jsonl`), lines([
      userPrompt('Make it sparkle ✨.', iso(45), A),
      ...assistant([tu], iso(44), A, { ctx: 9000, out: 9 }),
      toolResult(tu, '✅ ok ❌ none', iso(44, 1), A),
      ...assistant([{ type: 'text', text: 'Working on it ✅✅✅✅✅✅ 日本語のテキスト 🚀🚀 ✨✨ ⚡ ❌ 🫠 👍🏽 ⚠️ 👨‍👩‍👧 🇺🇸 and more words to need truncation at every width whatsoever, yes indeed, many more words follow' }], iso(43), A, { ctx: 9500, out: 60 }),
    ]))
    write(path.join(W(run), 'journal.jsonl'), lines([J({ type: 'launched' }), J({ type: 'started', key: 'v2:e', agentId: A, label: 'emoji:✨fx', phase: 'Shine' })]))
    for (const f of fs.readdirSync(W(run))) setMtime(path.join(W(run), f), 43)
  }

  // ───────── 7. relaunch from an existing script: new runId, script still named after the original run ─────────
  {
    const run = 'wf_relu0001-ggg'
    const spath = path.join(sdir, 'workflows', 'scripts', 'relaunch-demo-wf_orig0001-zzz.js')
    write(spath, `export const meta = { name: 'relaunch-demo', description: 'Relaunched from an existing script', phases: [{ title: 'Fix' }, { title: 'Ship' }] }\nphase('Fix')\nawait agent('a', { label: 'fix:one' })\nphase('Ship')\nawait agent('b', { label: 'ship:it' })\n`)
    const A = 'a600000000000000a'
    meta(run, A, 'fix:one', 'Fix')
    write(path.join(W(run), `agent-${A}.jsonl`), lines([userPrompt('Fix one.', iso(50), A), ...assistant([{ type: 'text', text: 'fixed' }], iso(49), A, { ctx: 5000, out: 5 })]))
    write(path.join(W(run), 'journal.jsonl'), lines([J({ type: 'launched' }), J({ type: 'started', key: 'v2:f1', agentId: A, label: 'fix:one', phase: 'Fix' })]))
    for (const f of fs.readdirSync(W(run))) setMtime(path.join(W(run), f), 49)
    // the Workflow tool's result in the parent session's transcript names the script file
    write(path.join(proj, sess + '.jsonl'), lines([
      J({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_wf', content: `Workflow launched in the background. Run ID: ${run}\nScript file: ${spath}\n(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "..."})` }] }, timestamp: iso(50) }),
    ]))
    // 8. same, but no session transcript mention: found by the labels it uses (a decoy script lacks one of them)
    const run2 = 'wf_relb0001-hhh'
    write(path.join(sdir, 'workflows', 'scripts', 'decoy-wf_orig0003-xxx.js'), `export const meta = { name: 'decoy', phases: [] }\nawait agent('a', { label: 'lab:alpha' })\n`)
    write(path.join(sdir, 'workflows', 'scripts', 'labelled-wf_orig0002-yyy.js'), `export const meta = { name: 'labelled', description: 'Found by its labels', phases: [{ title: 'Lab' }] }\nphase('Lab')\nawait agent('a', { label: 'lab:alpha' })\nawait agent('b', { label: "lab:beta" })\n`)
    const B1 = 'a700000000000000a', B2 = 'a800000000000000a'
    meta(run2, B1, 'lab:alpha', 'Lab'); meta(run2, B2, 'lab:beta', 'Lab')
    for (const x of [B1, B2]) write(path.join(W(run2), `agent-${x}.jsonl`), lines([userPrompt('Lab.', iso(48), x), ...assistant([{ type: 'text', text: 'ok' }], iso(47), x, { ctx: 4000, out: 4 })]))
    write(path.join(W(run2), 'journal.jsonl'), lines([J({ type: 'launched' }), J({ type: 'started', key: 'v2:l1', agentId: B1, label: 'lab:alpha', phase: 'Lab' }), J({ type: 'started', key: 'v2:l2', agentId: B2, label: 'lab:beta', phase: 'Lab' })]))
    for (const f of fs.readdirSync(W(run2))) setMtime(path.join(W(run2), f), 47)
  }

  // ───────── 9. progress file choice: an input findings.md is named first, the agent's own progress.md later ─────────
  {
    const run = 'wf_prog0001-jjj'
    const A = 'a910000000000000a'
    meta(run, A, 'logo:wink', 'Design')
    write(path.join(work, 'critic', 'findings.md'), '# critic\n## F1 a\n## F2 b\n## F3 c\n## F4 d\n## F5 e\n## F6 f\n## F7 g\n## F8 h\n')
    fs.mkdirSync(path.join(work, 'mine'), { recursive: true })
    write(path.join(W(run), `agent-${A}.jsonl`), lines([
      userPrompt(`The critic's findings are in ${work}/critic/findings.md (read it in full).\n\nProgress protocol (mandatory): your folder is ${work}/mine/ (mkdir -p). FIRST read ${work}/mine/progress.md if it exists and continue from it. After each deliverable append "done: <deliverable> | files | evidence" to progress.md.`, iso(46), A),
      ...assistant([{ type: 'text', text: 'Fresh start.' }], iso(45), A, { ctx: 3000, out: 3 }),
    ]))
    write(path.join(W(run), 'journal.jsonl'), lines([J({ type: 'launched' }), J({ type: 'started', key: 'v2:p', agentId: A, label: 'logo:wink', phase: 'Design' })]))
    for (const f of fs.readdirSync(W(run))) setMtime(path.join(W(run), f), 45)
  }

  // ───────── 10. quiet runs: a 25-minute Bash still pending (running), and one pending for 3 hours (idle) ─────────
  {
    for (const [run, A, ago] of [['wf_long0001-kkk', 'a920000000000000a', 25], ['wf_dead0001-lll', 'a930000000000000a', 180]]) {
      meta(run, A, 'long:suite', 'Test')
      const tu = toolUse('Bash', { command: 'npm run e2e', description: 'Run the long suite' })
      write(path.join(W(run), `agent-${A}.jsonl`), lines([userPrompt('Run the suite.', iso(ago + 1), A), ...assistant([tu], iso(ago), A, { ctx: 6000, out: 6 })]))
      write(path.join(W(run), 'journal.jsonl'), lines([J({ type: 'launched' }), J({ type: 'started', key: 'v2:t', agentId: A, label: 'long:suite', phase: 'Test' })]))
      for (const f of fs.readdirSync(W(run))) setMtime(path.join(W(run), f), ago)
    }
  }

  // ───────── 11. live journal stamping: last transcript line 10 min ago, the result arrives later ─────────
  {
    const run = 'wf_live0001-iii'
    const A = 'a940000000000000a'
    meta(run, A, 'live:slow', 'Live')
    const tu = toolUse('Bash', { command: 'make release', description: 'Final release build' })
    write(path.join(W(run), `agent-${A}.jsonl`), lines([userPrompt('Release.', iso(20), A), ...assistant([tu], iso(10), A, { ctx: 7000, out: 7 })]))
    write(path.join(W(run), 'journal.jsonl'), lines([J({ type: 'launched' }), J({ type: 'started', key: 'v2:r', agentId: A, label: 'live:slow', phase: 'Live' })]))
    for (const f of fs.readdirSync(W(run))) setMtime(path.join(W(run), f), 10)
  }
  for (const d of [path.join(sdir, 'subagents', 'workflows')]) for (const r of fs.readdirSync(d)) { const st = fs.statSync(path.join(d, r)); void st }
  return { root, proj, sess, sdir, work }
}

/** Writes a big transcript (default 20 MB) into run dir for the performance test. */
export function makeBig(root, mb = 20) {
  const sdir = path.join(root, '-Users-big', 'bbbbbbbb-0000-0000-0000-000000000000')
  const run = 'wf_big00001-fff'
  const dir = path.join(sdir, 'subagents', 'workflows', run)
  fs.rmSync(path.join(root, '-Users-big'), { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const A = 'a900000000000000a'
  fs.writeFileSync(path.join(dir, `agent-${A}.meta.json`), J({ description: 'big:agent', workflowPhase: 'Big' }))
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines([J({ type: 'launched' }), J({ type: 'started', key: 'v2:big', agentId: A, label: 'big:agent', phase: 'Big' })]))
  const fd = fs.openSync(path.join(dir, `agent-${A}.jsonl`), 'w')
  fs.writeSync(fd, userPrompt('Big one.', iso(60), A) + '\n')
  let size = 0, i = 0
  const target = mb * 1024 * 1024
  const pad = 'lorem ipsum dolor sit amet '.repeat(400) // ~10 KB tool results
  while (size < target) {
    const sec = Math.floor((i / 4000) * 3500)
    const tu = toolUse('Bash', { command: 'echo ' + i, description: 'step ' + i })
    const chunk = lines([apiRequest(iso(59, sec), A), apiBlob(A, 8000), ...assistant([{ type: 'thinking', thinking: '' }, tu], iso(59, sec), A, { ctx: 20000 + i, out: 10 }), toolResult(tu, pad + i, iso(59, sec + 1), A)])
    fs.writeSync(fd, chunk)
    size += Buffer.byteLength(chunk)
    i++
  }
  fs.closeSync(fd)
  return { dir, run, agentFile: path.join(dir, `agent-${A}.jsonl`), steps: i, agentId: A }
}
