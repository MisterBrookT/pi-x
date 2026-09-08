# Pix

**Pix equips Pi with the essential tools for everyday coding.** It is a focused [Pi](https://github.com/earendil-works/pi-mono) package with web access, bounded subagents, visible todo tracking, structured questions, and optional LSP.

## Philosophy

Pix sits between naive Pi and heavier agent systems such as OMP. Pi is beautifully minimal, but a fresh installation lacks several capabilities that are useful in everyday coding. Larger systems are powerful, but their broader prompts, command surfaces, and automation can consume more context and introduce features that many tasks do not need.

Pix keeps Pi's small, understandable core and supplies the practical missing pieces as one self-contained package. It is easy to install, behaves like Pi, and adds tools only where they provide a clear benefit:

- current web research and source retrieval;
- bounded parallel delegation;
- visible multi-step todo tracking;
- structured questions when user judgment is required;
- optional language-server diagnostics;
- prompt and startup-overhead inspection.

In the input editor, Pix shows a subtle but readable inline suggestion: zsh-style prefix matching reuses the newest matching prompt from the current session, with lightweight macOS dictionary completion as a fallback for prose words. Tab accepts the suggestion. `/complete on` adds AI completion: a small cloud model (Haiku 4.5 through `pix-anthropic` by default; `/complete model` picks another) predicts what you will type next from the last few turns, in your own voice, and proposes a likely next message when the editor is empty. Longer predictions wrap onto up to three lines below the cursor. While it is on, the history and dictionary suggestions step aside so the ghost text always comes from the model. Requests are debounced and cancelled on every keystroke, send only the last few turns, and the feature stays off until you enable it. Pix commands still use menus to complete supported arguments such as `/tool computer off`. `Shift+Enter` continues ordered and bullet lists. Pasted images and substantial text appear as compact rows such as `▣ image 1  294×490` and `▤ paste 1  42 lines`; Pix restores their full content before Pi processes the prompt. Image detection uses the actual pasted file, not terminal-specific paths or filenames.

Pix deliberately does not include unevaluated complexity: autonomous memory, an MCP umbrella, nested agent hierarchies, persistent planning machinery, or broad automation frameworks. A feature belongs in Pix only when it solves a recurring coding need and its value can be measured against its prompt, latency, and maintenance cost.

| | Naive Pi | Pix | OMP |
| --- | --- | --- | --- |
| Base system prompt | ~404 tokens | ~829 tokens | ~5,998 tokens |
| Core approach | Minimal file and shell tools | Pi plus focused coding essentials | Broad agent platform |
| Web access | No | Yes | Yes |
| Parallel subagents | No | Yes, bounded | Yes |
| Todo tracking | Example only | Yes | Yes |
| Structured questions | Example only | Yes | Yes |
| LSP diagnostics | No | Optional | Yes |
| User-facing surface | Small | Eight Pix commands | Broad |

Prompt counts use a GPT tokenizer on clean base prompts captured during Pix's design, excluding personal and project `AGENTS.md`, skills, and conversation context. Provider tokenizers and OMP's conditional configuration can produce different totals. `docs/system-prompts.html` contains the full public-safe naive-Pi → Pix comparison.

## Install

### Prerequisites

- [Pi coding agent](https://github.com/earendil-works/pi-mono) installed and available as `pi`
- Node.js 22 or newer

Install Pix:

```bash
pi install npm:@brooktang/pi-x
```

Or install the current GitHub version:

```bash
pi install git:github.com/MisterBrookT/pi-x
```

Or ask an agent:

```text
Help me install Pix from https://github.com/MisterBrookT/pi-x. Verify that Pi and Node.js 22+ are available, install Pix using the repository's documented Pi command, and do not change unrelated Pi configuration.
```

Restart Pi.

## What it adds

- `web_search` and content fetching through `pi-web-access`
  - Normal Web exposes Search → Fetch → Retrieve, with a tested 1,000 estimated-token budget.
  - Provider, proxy, and model selection use backend configuration rather than per-call overrides.
  - `source_check` and `video_content` are optional and off by default; enable them under `/tool` → Web → Enter. Explicit saved choices still win.
  - Video timestamp/frame controls are exposed only by `video_content`. This is an interface split, not a security restriction on which URLs the fetch backend can read.
  - Ordinary fetching does not expose browser-cookie opt-in or forced large repository cloning.
- `subagent` through `pi-subagents`
- `background` for long shell commands: start, inspect, or stop a job; completion or failure automatically wakes the agent
- opt-in `/goal` mode to continue unfinished work, with explicit completion/blockers and a continuation limit
- `todo` plus the `/todo` terminal view
- inline local-history and macOS word completion, optional AI completion via `/complete`, plus a restrained smart editor that continues lists and compacts pasted images
- `question` for structured user choices, adapted from Pi's official example
- `computer` for driving desktop apps and browser pages, when `@injaneity/pi-computer-use` is installed
- `lsp_diagnostics` and `lsp_fix` through configurable `pi-lsp`
- `/fast` for persistent priority-processing control on supported providers
- `/context` for the context-window breakdown, and `Alt+E` to export the exact active prompt
- a configurable footer with cache efficiency and latest-response token speed

For Claude Pro/Max plan usage, use `/login pix-anthropic` and select a model under the separate `pix-anthropic` provider. Pix leaves Pi's native `anthropic` provider unchanged; that provider uses Anthropic's third-party extra-usage billing.

> **Anthropic subscription warning:** `pix-anthropic` is an unofficial, OMP-derived compatibility transport that reproduces Claude Code's request fingerprint. Anthropic may change or reject this behavior, and using it may risk account restriction. Use Pi's native `anthropic` provider if that risk is unacceptable.
>
> `pix-anthropic` has its own provider and credential namespace, so Pi updates cannot overwrite Pix's implementation or the built-in `anthropic` provider. Pix vendors a reviewed OMP snapshot and tests both its locked Pi version and the latest Pi release; protocol updates are adopted deliberately.

## Compatibility

| Component | Supported |
| --- | --- |
| Pi | Current release; verified with 0.84.4 and tested weekly against latest |
| Node.js | 22 or newer |
| macOS and Linux | Supported |
| Windows | Expected to work; not yet verified |
| Language servers | Optional and installed separately |

## Commands

| Command | Purpose |
| --- | --- |
| `/complete [on\|off\|model\|status]` | Toggle AI inline completion or pick its model; persists across sessions |
| `/fast [on\|off\|status]` | Toggle priority processing and remember the preference |
| `/footer` | Choose footer metrics; choices persist across sessions |
| `/goal [objective]` | Open goal configuration, or start with an objective; also `status`, `pause` (`stop`), `resume`, and `clear` |
| `/todo [on\|off]` | Show todo state or toggle tracking for this session |
| `/tool` | Open the tool panel; also `/tool list`, `/tool <name\|capability> [on\|off]`, and capability actions such as `/tool computer check` |
| `/context` | Show what is filling the context window |
| `/subagent-config` | Alias for `/tool subagent roles`: configure role models, effort, and fallback |

| Shortcut | Purpose |
| --- | --- |
| `Alt+E` | Export the effective Pix system prompt to `.pix/system-prompt.md` |

`/tool` is the single place tools are turned on and off. Everyday tools are
listed individually; Web, Subagent, Computer, and MCP are one row each, because
choosing what the assistant may do should not require knowing that computer use
ships eleven backend primitives. Rows use fixed functional groups (Core tools,
Workflow, Code checks, Capabilities, Other), alphabetically within each group,
not ordered by changing token costs. Type in the top-level panel to search names,
groups, origins, or hidden child-tool names; Backspace edits and Esc clears the
search before closing. Arrow keys select, `Space` toggles the row, and `Enter`
opens a capability to reach its individual tools. Inside a capability, `Esc`
returns to the previous search. A
capability can also offer maintenance actions as verbs on its own row, which the
capability view lists: `/tool computer check` reports backend and permission
state, and `/tool computer stop` closes the managed browser and releases its
resources. Keeping them there avoids naming one optional capability twice in the
command list.

Computer and MCP start off. Every active tool's schema is re-sent on every
request, so a capability most sessions never touch is a standing charge on the
context window and on the model's attention. Turning Computer on enables the
`computer` script wrapper alone, which calls its primitives internally, so the
capability costs one schema rather than twelve. Choices are shared across sessions in `~/.pi/agent/pix-tools.json` (or the configured Pi agent directory). Opening `/tool`, interacting with its panel, or starting a model turn rereads the file. Changes survive reloads, restarts, and branch navigation. Old per-session tool records are ignored so opening an older conversation cannot undo current settings. Existing session-only preferences must be chosen once again; MCP remains off until explicitly enabled in shared settings.

Token figures in `/tool` and `/context` are estimates from serialized schema
length, not counts from the provider's tokenizer. They are accurate enough to
compare rows and decide what to disable.

Fast mode uses OpenAI's `service_tier: "priority"`, Anthropic's `speed: "fast"`, or Google's priority tier according to the active direct provider, including `pix-anthropic`. Availability and any extra charges are determined by the provider. The preference persists across sessions, the footer shows `fast` while active, and it does not affect subagents. Anthropic models without upstream fast-mode support automatically use normal speed and show a warning instead of failing.

Pix exposes only two built-in roles from `pi-subagents`: `worker` for scoped implementation and verification, and `scout` for codebase discovery and navigation. The main agent sees these responsibilities in the tool description and chooses a role by task; the role's configured model is resolved at launch. Each can use a different model, effort, and cross-provider fallback through `/tool subagent roles` (or the `/subagent-config` alias). In `/tool`, open Subagent and press **R** to edit roles. The picker shows resolved mappings and saves only the chosen field in user settings; existing fallback and permission settings stay unchanged. Changes affect new children, not running ones; project/provider overrides can take precedence. Turning subagents on or off is also done in `/tool`.

Delegation guidance keeps the critical path with the main assistant: delegate bounded independent side tasks, continue useful work, and wait only when child results are required and no useful independent work remains. Small or tightly coupled tasks should stay with the main assistant.

The `subagent` tool exposes four actions: `start`, `status`, `steer`, and `stop`.
For example, `{action:"start", tasks:[{agent:"scout", task:"Locate the parser"}]}`
starts one asynchronous task. Multiple tasks start in parallel, capped at four
concurrent agents and eight tasks. Parallel tasks use separate git worktrees;
review and integrate their changes yourself. A single task uses the current
working directory, so do not overlap writers there.

Use the returned run ID with `status`, `steer` (plus `message`), or `stop`.
Completion notifications arrive automatically. The main assistant and Todo
handle dependencies such as A/B → C after reading the earlier results.
Workflow scripting, scheduling, missions, and administrative actions are not
exposed through this tool. Models and safety controls remain backend-configured.
The full definition has a tested budget of 2,000 estimated tokens; estimates are
character-based, not provider token counts. Subagents notify the parent automatically;
Pix does not expose a separate `bg_wait` tool. The `subagent_supervisor` tool
remains available for child communication. Explicit blocking waits and external-job
wait subscriptions are not part of Pix's tool surface.

## Goal mode

Use `/goal Fix the parser bug and pass the regression tests` when a task should
continue beyond a plan or progress report. Pix resumes unfinished work after the
agent settles, but waits quietly for background commands and subagents. It stops
on reported completion with verification evidence, a blocker, interruption, or
10 automatic continuations. Open `/goal` without arguments for the configuration
menu: inspect status and pause reasons, start or replace the objective, resume,
pause, or clear it. Opening the menu changes nothing. New sessions start with
goal off. `/goal pause` stops future continuations; `Esc` interrupts current
work. Ordinary supplementary messages keep an active goal enabled, and transient
model errors do not pause it while Pi is still retrying or recovering context.
An error that remains after recovery does pause it. `/goal resume` explicitly
restarts a paused goal; ordinary text such as “go on” does not turn goal mode
back on.

The footer shows `goal on` only while a goal is active, including its waiting
state. Inactive goals add nothing to the footer; `/goal status` shows their details.
An active goal remains visible even when the project path is long.

Goal mode adds no judge model or dependency. The objective survives compaction.
`/reload` preserves this session's goal status, objective, and continuation count
without starting another turn. Reopening a closed session or navigating to a
different branch restores active goals paused, never silently restarted. See
[Goal mode](docs/goal-mode.md) for controls, verification limits, and implementation.

## Background commands

`background` keeps long commands from blocking the conversation. The agent starts
one, does other work or yields, then resumes automatically when it finishes or
fails. There is no need to say “continue,” poll, or watch every log line.

```json
{"action":"start","command":"npm run check"}
{"action":"status","id":"1"}
{"action":"stop","id":"1"}
```

Omit `id` from `status` to list jobs. Up to four run at once; the latest 32 are
retained in memory. Completion includes a short output tail; `status` provides
Pi's bounded Bash output and a full log path when truncated. An optional
`timeout` is in seconds. Explicitly stopped jobs do not wake the agent.

This minimal version requires a persistent TUI or RPC session. Jobs stop on exit,
reload, session replacement, or branch navigation; they do not survive restarts.
Use ordinary `bash` in print/JSON mode. There is no stdin interaction, output
watcher, or scheduler. Toggle the tool with `/tool background off` (this prevents
new tool calls, not existing jobs). Like Bash, it executes local commands with
Pi's permissions; extensions that guard or sandbox only the `bash` tool must
also cover `background` before enabling it.

## Computer use

When a task can only be done through a graphical interface, `computer` drives
desktop apps and browser pages. The model writes one JavaScript program against
a small `cua` API rather than one tool call per click, so a multi-step flow or a
loop costs a single round trip.

It is optional. Install the backend to enable it:

```bash
pi install npm:@injaneity/pi-computer-use
```

On macOS the helper needs **Accessibility** and **Screen & System Audio
Recording** in System Settings. These cannot be granted programmatically, so
`/tool computer check` reports what is missing and links to the exact settings pane.

```js
await cua.roots({ app: "Notes" });
const state = await cua.observe({ root: "@r1" });
await state.act(
  { action: "setText", ref: "@e7", text: "hello" },
  { text: "hello", until: "present" },   // verify the result, do not assume it
);
```

Actions are counted against a budget, every backend call is traced back to the
model, and actions on irreversible controls such as Send or Delete require
confirmation before they run. Prefer a CLI, an API, or `osascript` first;
`computer` is for interfaces that expose nothing else. See
[`docs/adr/0001-computer-use.md`](docs/adr/0001-computer-use.md) for the design
and its tradeoffs.

Todo can create a whole plan in one call with `replace`, rather than adding each step separately:

```json
{"action":"replace","items":[
  {"text":"Inspect backend"},
  {"text":"Inspect frontend"},
  {"text":"Summarize","dependsOn":["1","2"]}
]}
```

`replace` replaces the existing list, restarts IDs at `1`, and makes every item pending. Invalid plans leave the old list untouched. Use `add` to append a step and `set` to update its status. Nested items use `parentId` (put parents first); dependencies may point to later items in the same replacement.

Optional `dependsOn` IDs block work until all prerequisites are done. Independent ready items may be delegated in parallel, but Todo never launches subagents automatically. To reopen a completed prerequisite, first reset its active/done dependents to pending; Todo does not silently reset other tasks.

## LSP

Pix does not download language servers. Install only what your projects need. For TypeScript, either Biome or `typescript-language-server` can provide diagnostics; repository typecheck and tests remain authoritative.

## Design boundaries

- Delegate only genuinely independent or context-heavy work.
- Default limits: 4 concurrent children, 8 per run, 24 per session, and one level of delegation.
- Use todo for meaningful multi-step work, not every response; optional dependencies form a validated DAG without acting as an automatic scheduler.
- No autonomous memory, MCP umbrella, agent hub, or plan framework.
- Pix compresses verbose upstream prompt guidance into three short rules for todo, subagents, and LSP.
- Dependency administration commands are hidden; Pix keeps eight user-facing commands, with related actions as verbs on the command that already owns them and rare inspection on a shortcut.

## Development

```bash
npm install
npm run check
npm run smoke:anthropic  # live OAuth check: Fable 5.1, Opus 5, Sonnet 5 at minimal
```

`docs/system-prompts.html` contains the complete public-safe naive-Pi and Pix prompts. `npm run bench` compares naive Pi with the active Pix prompt on the current machine and reports health and startup speed. Future task-performance checks are scoped in `ROADMAP.md`.

## Acknowledgements

Pix is built on Pi and the work of its extension community. Special thanks to:

- **Pi**, for the coding harness, extension API, and official todo and question examples adapted by Pix.
- **LazyPi**, whose curated package catalog demonstrated a practical combination of web access, subagents, and todo tracking.
- **pi-web-access**, **pi-subagents**, and **pi-lsp**, which provide Pix's web, delegation, and language-server capabilities.

See `THIRD_PARTY_NOTICES.md` for repositories and licenses.

## License

MIT. See `THIRD_PARTY_NOTICES.md` for bundled and referenced upstream work.
