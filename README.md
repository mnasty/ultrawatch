# ultrawatch

A live terminal tracker for Claude Code workflow runs ("ultracode sessions"). It shows progress bars, every subagent's model, and what each one is doing right now, plus a streaming feed of events. It exists because the built-in `/workflows` view does not work in the VS Code extension. Run it in a separate terminal: the VS Code integrated terminal or macOS Terminal.

It is a single file, `ultrawatch.mjs`, for Node 18 or later, with no dependencies. It is **read-only**: it never writes anything to disk.

## Usage

```sh
node ~/.claude/tools/ultrawatch/ultrawatch.mjs            # live dashboard of the most recently active running run
node ~/.claude/tools/ultrawatch/ultrawatch.mjs --list     # recent runs
```

Suggested zsh alias, which you add to `~/.zshrc` yourself:

```sh
alias uw='node ~/.claude/tools/ultrawatch/ultrawatch.mjs'
```

| command | what it does |
|---|---|
| `uw` | Opens the dashboard for the most recently active **running** run anywhere under `~/.claude/projects`. If nothing is running, it opens the most recent run and says so. |
| `uw --run wf_464e` / `uw 464e` | Opens a specific run. A unique prefix is enough and the `wf_` prefix is optional. |
| `uw --all` | Shows every running run, stacked. Press `a` to toggle this. |
| `uw --session e4432b45` / `uw --project memi` | Limits run discovery to one session id (prefix) or to project folders whose name contains the substring. |
| `uw --list [--limit 50] [--json]` | Prints a table of recent runs: id, name, status, agents done/total (failed, running), tokens, tool calls, start time, time since the last activity, and session. |
| `uw --feed [--agent sky] [--backlog 50]` | An append-only event log, one line per event, that you can pipe or `tail`. It has no colour unless you pass `--color`. It is also the default when stdout is not a terminal. |
| `uw --once [--width 160] [--height 40] [--focus <agent>]` | Prints one dashboard frame (or one agent's focus view) and exits. |
| `uw --json` | Prints a machine-readable snapshot (run, phases, agents, totals, last 40 events) and exits. |
| `--color` / `--no-color` | Forces colour on or off. `NO_COLOR` is respected. |
| `--interval <ms>` | Sets the poll interval. The default is 250 ms for the TUI and 500 ms for the feed. |
| `--root <dir>` | Sets the projects directory. The default is `~/.claude/projects` or `$ULTRAWATCH_ROOT`. |

## Keys (dashboard)

| key | action |
|---|---|
| `q`, `Ctrl-C` | Quit, from any view (help included). The terminal is always restored: alternate screen, cursor and raw mode, including on SIGTERM and on a crash. SIGTERM works even when the terminal has stopped reading output (writes are non-blocking and frames are dropped instead of queued). |
| `↑`/`↓`, `k`/`j` | Select an agent. The selected row is drawn in reverse video, which reads on light and dark themes and under `NO_COLOR`. `g`/`G` jump to the first or last agent. |
| `Enter`, `f` | Focus the selected agent and show its full event stream: tool calls with their inputs summarised, previews of tool results (with duration), text snippets, and errors. Every attempt is shown, with a separator between attempts. |
| `Esc` | Go back. In focus view, `↑`/`↓`/`j`/`k` scroll, `PgUp`/`PgDn` page, `g` goes to the top and `G` follows new events. |
| `p` | Pause redraw. Data keeps loading in the background. |
| `r` | Rescan the disk for runs, agents and scripts. |
| `a` | Toggle between this run and all running runs. |
| `?` | Help. |

## The screen

**Header.** It shows the workflow name and description (from the script's `meta`), the run id and the status:

- `● running`
- `◌ idle`: no run json, no file has been written for 20 minutes, and no agent is waiting on a tool call (started less than 2 hours ago), so the run is probably dead
- `✓ completed`: shown as `(n failed)` when some agents failed
- `■ stopped`: the harness's `killed`
- `✗ failed`

It also shows the elapsed time, the start time and the run's default model. The line below it shows:

- `tokens`: the harness's own total (the sum of each agent's latest context size). When the run json exists, its `totalTokens` is used.
- `out≈`: output tokens.
- `in+cache`: all input tokens processed, including cache reads and writes, summed over every API call.
- `tools` (with tool errors), `api` calls, session, and time since the last activity.

If a session or usage limit was hit, a red banner shows when it happened and the reset time taken from the error text (`resets 2:10am (America/Los_Angeles)`). The banner turns into a yellow note once agents have produced output again after the limit.

**Progress.**

- The `agents` bar has green for done, red for failed, yellow for stopped and cyan for running. Grey is the remainder up to the number of `agent()` calls found in the script (`~N in script`). That number is a lower bound, because loops and helpers are not expanded. A `+` means the script has loops.
- There is one bar per phase from `meta.phases`. `▶` marks the current phase, `✓` a finished phase and `✗` a phase with failures.

**Agent table.** There is one row per logical agent. A retry or resume of the same agent is the same row, and `↻n` means n attempts. Columns are dropped on narrow terminals in this order: phase, ctx, out, ago, tool, time.

| column | meaning |
|---|---|
| glyph | `⠋` running (spinner), `!` stalled, `✓` done, `↺` cached (the result was reused, not re-run, in the latest launch), `✗` failed, `■` stopped, `·` pending. Grey means the agent belongs to an earlier launch of a resumed run and is not part of the final one. |
| agent | The label given in the workflow script. |
| phase | The workflow phase. |
| model | `message.model` of the agent's latest reply, shortened: `claude-opus-5-5` → `opus-5.5`, `claude-sonnet-4-5-20250929` → `sonnet-4.5`. A `~` means the agent never replied (for example, it hit the limit at once) and the run's default model is shown instead. |
| time | While it runs: from the agent's first transcript line until now. Once finished: until the harness recorded its result (the run json's per-agent `durationMs`, or the moment the journal's `result`/`failed` line was written while ultrawatch watched), never shorter than its last transcript line. |
| out | Output tokens, approximate (see Limitations). |
| ctx | Current context size: the latest `input + cache_read + cache_creation` tokens. |
| tool | Tool calls made. |
| progress | Comes from the agent's progress file when it has one (see "Progress files" below). `███░░ 2/4` is done/total, and `░░░░ 0/5` a known total with nothing done yet. `4✓` means 4 items done with no known total. `7F` means findings.md has 7 sections. With no progress file, the column shows a moving activity indicator (it stands still when the agent is idle) or the final state. |
| ago | Time since the current activity started. |
| current activity | `unreadable (EACCES)` when the transcript cannot be read. Otherwise the latest event: `Bash: <description or first line of the command>`, `Read <file>`, `Edit <file>`, `Write <file> (size)`, `WebSearch <query>`, `WebFetch <url>`, `thinking…`, the latest text in quotes, or `<last tool> ✓ · thinking…`. A trailing `⋯` means the tool is still running. A done agent shows `→ <result>` and a failed agent shows its error. After 3 minutes of silence the agent is marked `stalled 4m`, or `stalled? 4m in Bash: …` when it is waiting on a long tool call. |

Text from transcripts is made single-line and safe: escape and control characters are removed, and emoji sequences are simplified so their width is predictable (joiners, variation selectors, skin tones and tag characters are dropped, flags become letters: `🇺🇸` → `US`). Widths count emoji such as ✅ ❌ ⚡ ✨ and CJK as 2 columns, so rows never wrap.

**Feed.** It shows the most recent events across all agents, newest last. Each event has a time, a coloured agent tag and the model. Tool calls are plain, tool errors are red, assistant text is in quotes, `▶ started`, `✓ finished: <result>` and `✗ failed` are highlighted, and the usage limit is bold red. Plain successful tool results appear only in focus view. Journal events that arrive while ultrawatch is watching (`started`, `finished`, `failed`) are stamped with the time the journal line was written. The backlog read at start-up has no such times, so it uses the agent's first or last transcript line (or the run json's per-agent `startedAt + durationMs`).

## How data is read

Data comes from `~/.claude/projects/<project>/<session>/`:

- **`subagents/workflows/<runId>/journal.jsonl`**: `launched`, `started {key, agentId, label, phase}`, `result {key, agentId, result}` and `failed {key, agentId}`. The `key` identifies a logical agent, so a new `agentId` under the same key is a retry. Two more cases are handled:
  - When a resumed run with an edited script restarts an agent under a **new** key with the same label and phase, and the earlier slot failed or was interrupted, that is also treated as a retry.
  - A `result` with no `started` is a cached result.
- **`agent-<id>.jsonl`**: the transcript of each subagent. It is read **incrementally by byte offset**: only appended bytes are read, only complete lines are parsed, and a partial trailing line is kept until it completes. A truncated or replaced file is re-read from the start. The huge `api-request*` bookkeeping lines are never parsed: ultrawatch only peeks at the model and timestamp of `api-request`. Malformed lines are counted and skipped.
- **`agent-<id>.meta.json`**: the label and phase, used before the journal mentions the agent.
- **`<session>/workflows/<runId>.json`**: written when a run finishes or is stopped. It provides the status, `durationMs`, totals, `defaultModel`, the cached flags in `workflowProgress`, and the limit messages in `logs`. A resumed run reuses the directory, so an existing json counts only if it is not older than the journal. Otherwise the run counts as running again.
- **The workflow script**, found in this order: the run json's `script` or `scriptPath`; `<session>/workflows/scripts/<name>-<runId>.js`; for a run launched from an existing script (`Workflow({scriptPath})`, which gets a new runId but keeps the original file name), the line `<runId>\nScript file: <path>` in the parent session's transcript `<project>/<session>.jsonl` (scanned newest-first, once, then only appended bytes); and last, the newest script in `scripts/` that names every agent label seen so far (re-checked as new labels appear). `export const meta = {…}` is parsed with a small JS-literal parser and is **never evaluated**. Anything that is not a literal falls back to a best-effort regex.
- **Progress files.** Candidates come from the agent's prompt (everything it was told before its first reply) and from what it writes, ranked; the best-ranked file that exists wins, and the choice is re-checked every 3 s, so the bar moves to the agent's own file as soon as it is created:
  0. a `progress.md`/`findings.md` the agent writes itself (Write/Edit, or a Bash `>`/`>>`/`tee` target; a file it only reads does not count);
  1. `progress.md` in the agent's own folder ("your folder is /x/", "your work folder is /x/", or "/x/<your name>/", where the placeholder is matched against the label) or named within the "Progress protocol" section;
  2. `findings.md` in the agent's own folder;
  3. any other `progress.md` the prompt mentions, only when the prompt declares no tier-1 file and only if it was modified after the agent started.

  A `findings.md` outside the agent's own folder is an input (another agent's findings) and is never used. Until the chosen file exists, the column shows the activity indicator and focus view shows the expected path as "not written yet".
  - `done:` / `todo:` lines (or `- [x]` / `- [ ]`) give done/total.
  - When there are no todo lines, the total is the number of numbered "Deliverables" in the prompt, or the `listing these items as todo: a | b | c` list.
  - findings.md counts `##` sections.

Everything is polled: stat calls every 250 ms, reads only when sizes change, and a directory rescan every 3 s for new runs.

## Limitations

- **Output tokens are approximate.** Transcripts store a streaming snapshot of `usage` on each content block, so `output_tokens` is often a partial count. ultrawatch uses the larger of the reported count and an estimate from the visible content (about 4 characters per token). Hidden thinking is not counted, so treat `out≈` as a lower bound.
- `tokens` follows the harness's definition (the sum of the latest context sizes). It matches the run json `totalTokens` to within about 0.2%, and tool calls match exactly on finished runs.
- A run whose Claude Code process died without writing its json shows as `running` for 20 minutes after the last write, then as `idle`. If it died while an agent was waiting on a tool call, it shows as `running` (with that agent `stalled?`) for up to 2 hours.
- Emoji width follows Unicode's Emoji_Presentation property, which matches VS Code's terminal (Unicode 11+ widths) and macOS Terminal. A terminal using older width tables may draw some emoji 1 column wide, which leaves a gap but never wraps.
- Script discovery by labels can pick the wrong script if two scripts in the session use exactly the same labels; the session-transcript lookup runs first, so this only matters when the transcript is missing.
- The `~N in script` estimate does not expand loops or helper functions.
- A run with no script on disk shows as `(workflow script not found)` and has no phase list beyond the phases its agents report.

## Tests

```sh
node ~/.claude/tools/ultrawatch/test/run.mjs              # full suite (about 40 s, including pseudo-terminal tests)
node ~/.claude/tools/ultrawatch/test/run.mjs --skip-pty   # without the pseudo-terminal tests
node ~/.claude/tools/ultrawatch/test/run.mjs --update     # accept new snapshot frames
```

The suite builds fixtures in `test/fixtures/`: a running run, a completed run, a failed run with a session-limit error, a resumed run with cached results and a retry, a partial trailing line, a run full of emoji, two relaunched runs (script found via the session transcript, and via labels), an agent whose prompt names an input findings.md before its own progress.md, a run quiet for 25 minutes inside one Bash call (running) and one for 3 hours (idle), a journal result arriving late, and a generated 20 MB transcript. It checks:

- the parsed state
- snapshot frames at 80 and 160 columns (`test/snapshots/`)
- every CLI mode
- feed latency for appended lines
- performance: the first frame under 1.5 s and an incremental tick under 50 ms on 20 MB
- the TUI inside a real pseudo-terminal (`script`): keys, a single synchronized write per frame, resize, and terminal restore after `q`, Ctrl-C, SIGTERM and a crash
- SIGTERM while the terminal has stopped reading output (`test/stuck-term.py`): exits promptly and leaves the tty cooked
- that no test process is left running (each pseudo-terminal test runs in its own process group, killed on timeout)
- that nothing is written into the watched tree

`test/vt.mjs` is a small VT100 emulator that rebuilds screens from captured pty output (`test/screen.mjs <raw> <cols> <rows>`).
