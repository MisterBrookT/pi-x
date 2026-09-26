# Pix guide

[Back to Pix](../README.md) · [Installation](../README.md#install)

Detailed usage, configuration, and design boundaries.

## What it adds

- `web_search`, `fetch_content`, and `get_search_content`, implemented in Pix's own `src/web/`
  - Search runs through your Pi `openai-codex` or `openai` login; a Codex subscription needs no separate API key. Set `openaiApiKey` in `web-search.json` to use a key instead.
  - Fetching extracts readable markdown, returns raw bodies on request, and converts PDFs to text. Large results are stored for an hour and read back by slice or by `findText`.
  - Every request, including each redirect hop, is checked against private, loopback, link-local, and reserved addresses, and DNS answers are validated in full so a rebind cannot reach an internal service. Exempt a range you control with `ssrf.allowRanges`, for example `["198.18.0.0/15"]` for a TUN/fake-IP proxy.
  - `/tool` → Web → **C** tests access and adjusts the inline size limit, allowed ranges, and proxy. Settings are read per call, so a saved change applies without `/reload`.
  - Video analysis, GitHub repository cloning, browser-cookie fetching, and the interactive search curator are not included.
- `subagent` through `pi-subagents`
- `background` for long shell commands: start, inspect, or stop a job; completion or failure automatically wakes the agent
- opt-in `/goal` mode to continue unfinished work, with explicit completion/blockers and a continuation limit
- `todo` plus the `/todo` terminal view
- inline local-history and macOS word completion, optional AI completion via `/complete`, plus a restrained smart editor that continues lists and compacts pasted images
- `question` for structured user choices, adapted from Pi's official example
- `computer` for driving desktop apps and browser pages, when `@injaneity/pi-computer-use` is installed
- `lsp_diagnostics` and `lsp_fix` through configurable `pi-lsp`
- `/fast` for persistent priority-processing control on supported providers
- `/export` to save and open the full recorded session, current system prompt, and tool definitions in your browser
- `/context` for the context-window breakdown, `Alt+E` to export the exact active prompt, and `/context html` (`Alt+H`) to open the whole context as a readable page in your browser
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
| `/rc [off\|status\|reset\|tailnet]` | Control this live Pi session from the Pix Remote web app |
| `/todo [on\|off]` | Show todo state or toggle tracking for this session |
| `/tool` | Open the tool panel; also `/tool list`, `/tool <name\|capability> [on\|off\|auto\|default]`, and capability actions such as `/tool computer check` |
| `/export [path]` | Save Pi’s session viewer and open it in your browser: current effective system prompt, tools, and recorded conversation history. `.jsonl` exports remain save-only |
| `/context` | Show what fills the current context window; `/context html` opens that window as an HTML page, with compaction applied |
| `/subagent-config` | Alias for `/tool subagent roles`: configure role models, effort, and fallback |

| Shortcut | Purpose |
| --- | --- |
| `Alt+E` | Export the effective Pix system prompt to `.pix/system-prompt.md` |
| `Alt+H` | Write the full context — prompt, tool schemas, and messages — to `.pix/context.html` and open it in your browser |

`/tool` is the single place for persistent tool preferences. Everyday tools are
listed individually; Web, Subagent, Computer, and MCP are one row each, because
choosing what the assistant may do should not require knowing that computer use
ships eleven backend primitives. Rows use fixed functional groups (Core tools,
Workflow, Code checks, Capabilities, Optional built-ins, Other), alphabetically within each group,
not ordered by changing token costs. Type in the top-level panel to search names,
groups, origins, or hidden child-tool names; Backspace edits and Esc clears the
search before closing. Arrow keys select; `Space` toggles ordinary tools on/off, or cycles on-demand tools **auto → on → off → auto**. `Enter` opens a capability, or changes an individual tool. `Delete` (forward delete) restores the default without saving an override. Inside a capability, `Esc` returns to the previous search. Auto uses the theme's accent color, distinct from muted off and green on. Rows show the effective policy and mark inherited choices `default`: Read is `on · default`, Computer is `auto · default`, and Grep is `off · default`. Policy is separate from runtime state: an `auto` tool may already be active. Individual rows show active/inactive; capability rows show active counts. A capability's policy reflects its primary tools; differing primary policies show `mixed`, and cycling restores defaults. Secondary tools retain their own policies in the advanced view. A
capability can also offer maintenance actions as verbs on its own row, which the
capability view lists: `/tool computer check` reports backend and permission
state, and `/tool computer stop` closes the managed browser and releases its
resources. Keeping them there avoids naming one optional capability twice in the
command list.

### Tools in model context

Everyday tools stay available: Pi's `read`, `bash`, `edit`, and `write`, Todo, Subagent, web search and retrieval, Background, and Question. One `discover_tools` entry point activates specialists by capability description or exact tool name, for example `{query:"browser interaction"}`. It uses bounded keyword matching (two matches by default, at most five), not another model call. The selected tools become callable on the next model request.

Pi's separate `grep`, `find`, and `ls` tools are off by default, grouped under Optional built-ins, and not discoverable. Use Bash (`rg`, `find`, `ls`) without loading extra schemas, or explicitly enable those tool alternatives through `/tool`.

Computer, LSP diagnostics/fixes, subagent supervisor communication, specialist source/video analysis, and configured MCP tools start deferred. Computer discovery exposes only the script wrapper, not its backend primitives. Missing integrations are not installed automatically, and activation does not grant system permissions. The Goal tool is exposed while goal mode is active, unless explicitly overridden.

Web stays on by default but also supports on-demand activation: choose `auto` in the panel or run `/tool web auto`. This preference persists; search and retrieval schemas remain absent until discovered. Individual web tools can be configured separately.

Discovery is session-local: it survives subsequent turns and branch navigation, but resets on reload or a new session. It never writes preferences. `/tool <name|capability> on` keeps tools enabled; `off` blocks discovery; `auto` selects on-demand activation for discoverable tools. `/tool <name|capability> default` (or Delete in the panel) removes overrides and restores defaults. For ordinary tools without discovery, the older `auto` command remains a default-reset alias. Existing saved on/off choices remain authoritative. Choices live in `~/.pi/agent/pix-tools.json` (or the configured Pi agent directory) and survive reloads, restarts, and branch navigation. Opening the panel or starting a turn rereads them; old conversation entries cannot undo current preferences.

This reduces initially exposed tool schemas and their tool-specific guidance, not conversation history or global/project instructions. UI features such as the footer, graph layout, and editor suggestions are unchanged. Pi records tool changes in its transcript; provider support determines how those changes affect prompt caching.

`/export` preserves recorded history, including older turns that compaction removed from the active window. Its prompt and tool definitions describe the current state, not an exact reconstruction of every historical provider request. If browser opening fails, the saved HTML path is shown. `/context html` instead describes the current window after compaction.

Token figures in `/tool` and `/context` are estimates from serialized schema
length, not counts from the provider's tokenizer. They are accurate enough to
compare rows and decide what to disable.

Fast mode uses OpenAI's `service_tier: "priority"`, Anthropic's `speed: "fast"`, or Google's priority tier according to the active direct provider, including `pix-anthropic`. Availability and any extra charges are determined by the provider. The preference persists across sessions, the footer shows `fast` while active, and it does not affect subagents. Anthropic models without upstream fast-mode support automatically use normal speed and show a warning instead of failing.

Pix exposes only two built-in roles from `pi-subagents`: `worker` for scoped implementation and verification, and `scout` for codebase discovery and navigation. The main agent sees these responsibilities in the tool description and chooses a role by task; the role's configured model is resolved at launch. Each can use a different model, effort, and cross-provider fallback through `/tool subagent roles` (or the `/subagent-config` alias). In `/tool`, open Subagent and press **R** to edit roles. The picker shows resolved mappings and saves only the chosen field in user settings; existing fallback and permission settings stay unchanged. Changes affect new children, not running ones; project/provider overrides can take precedence. Turning subagents on or off is also done in `/tool`.

If `subagents.defaultExtensions` is configured, children use that explicit extension list rather than inheriting ambient parent extensions. Roles using `pix-anthropic/*` must include the installed Pix `extensions/pix-anthropic/index.ts` path in that list. Loading only this provider extension keeps the child tool surface small; no model-name change is needed.

Delegation guidance leaves organization to the model: use subagents when delegation or parallel work would help. Todo guidance asks only to track multi-step work and keep progress current.

The `subagent` tool exposes four actions: `start`, `status`, `steer`, and `stop`.
For example, `{action:"start", tasks:[{agent:"scout", task:"Locate the parser"}]}`
starts one asynchronous task. Multiple tasks start in parallel, capped at four
concurrent agents and eight tasks. Tasks share the current working directory by
default, including uncommitted changes; do not overlap writers. For parallel
isolation, pass `worktree:true` on `start` (requires a clean git working tree).
Worktree changes are not merged automatically; review and integrate them yourself.
Each child gets fresh, task-only context by default. Pass `context:"fork"` on
`start` only when it needs the parent conversation. The main agent selects the
role and states the scope in the task; role tools and permissions remain
configured separately and delegation cannot elevate them.

Use the returned run ID with `status`, `steer` (plus `message`), or `stop`.
Completion notifications arrive automatically. The main assistant and Todo
handle dependencies such as A/B → C after reading the earlier results.
Workflow scripting, scheduling, missions, and administrative actions are not
exposed through this tool. Models and safety controls remain backend-configured.
The full definition has a tested budget of 2,000 estimated tokens; estimates are
character-based, not provider token counts. Subagents notify the parent automatically;
Pix does not expose a separate `bg_wait` tool. `subagent_supervisor` is discovered when needed: a child that hits a decision it cannot make pauses and asks, and this is how the main agent answers. Explicit blocking waits and external-job
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
[Goal mode](goal-mode.md) for controls, verification limits, and implementation.

## Background commands

`background` keeps long commands from blocking the conversation. The agent starts
one, does other work or yields, then resumes automatically when it finishes or
fails. There is no need to say “continue,” poll, or watch every log line.

```json
{"action":"start","command":"npm run check"}
{"action":"start","command":"long-benchmark","reminder":"fixed","intervalSeconds":120}
{"action":"status","id":"1"}
{"action":"stop","id":"1"}
```

Omit `id` from `status` to list jobs. Up to four run at once; the latest 32 are
retained in memory. Each model request also receives a short, request-local
list of currently running shell jobs and active async subagent run IDs; it
does not wake the agent or include logs or subagent transcripts. Subagent state
comes from lifecycle events, so a run already active before a Pix reload may
not appear until a new event; use `subagent status` for the authoritative view. Completion includes a short output tail; `status` provides
Pi's bounded Bash output and a full log path when truncated. An optional
`timeout` is in seconds. While a job runs, hidden health-check messages wake
the agent at 1, 2, 4, then every 8 minutes by default (intervals, not elapsed
times). Set `reminder: "fixed"` and `intervalSeconds` (10–3600) for a steady
interval, or `reminder: "off"` for completion-only wakes. Exponential checks
start at the chosen interval and double up to at least 8 minutes. Completion,
stop, exit, reload, and branch changes cancel future checks; an inactive goal
does not wake. Explicitly stopped jobs do not wake the agent.

This minimal version requires a persistent TUI or RPC session. Jobs stop on exit,
reload, session replacement, or branch navigation; they do not survive restarts.
Use ordinary `bash` in print/JSON mode. There is no stdin interaction, output
output watcher or persistent scheduler. Toggle the tool with
`/tool background off` (this prevents new tool calls, not existing jobs). Like Bash, it executes local commands with
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
[`docs/adr/0001-computer-use.md`](adr/0001-computer-use.md) for the design
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

Use one `set` call for multiple status changes instead of issuing a call per item:

```json
{"action":"set","updates":[
  {"id":"1","status":"done"},
  {"id":"2","status":"done"},
  {"id":"3","status":"active"}
]}
```

Todo state reminders are saved as hidden conversation messages when the plan changes, not removed and reinserted on every request. Unchanged state adds nothing; reload reuses saved reminders, and compaction restores missing state. This preserves the earlier conversation prefix for cached continuation without guaranteeing a particular cache-hit percentage.

Updates are atomic: an invalid ID, duplicate ID, or blocked transition leaves every item unchanged. Dependencies are checked against the final state, so array order does not matter. For a single change, `{"action":"set","id":"1","status":"done"}` still works; do not mix top-level `id`/`status` with `updates`.

Optional `dependsOn` IDs block work until all prerequisites are done. Independent ready items may be delegated in parallel, but Todo never launches subagents automatically. To reopen a completed prerequisite, reset its active/done dependents to pending first or in the same batch; Todo does not silently reset other tasks.

## Remote control

The [iPhone user story and acceptance checklist](remote-mobile.md) tracks rendering, pictures, keyboard, and touch navigation beyond the initial connection.

`/rc` connects the **current Pi conversation** to Pix Remote. On the Mac, a hub binds only to `127.0.0.1:8787` (override with `PIX_REMOTE_PORT`); the first Pi session hosts it, and other `/rc` sessions join its session list. Prompts sent from the phone enter that same terminal transcript. While Pi is working, a phone message steers the current turn (like Enter in the terminal), and **Stop** aborts it (like Escape). The ⚡ button next to ＋ opens quick actions while Pi is idle: **Reload Pi** (like `/reload`; remote stays on), **New chat** (asks first; the phone follows the new conversation and remote stays on) and **Compact**. Typing `/reload`, `/new` or `/compact` on the phone does the same. Other slash commands are sent as ordinary text. The Mac footer shows `remote on` only while this Pi session is exposed; `/rc off` removes this session and clears the indicator, as does quitting Pi. `/rc status` gives the same answer explicitly.

**No VPN on the phone:** point `PIX_REMOTE_RELAY_URL` (or private `~/.pi/agent/pix-remote/relay.json` containing `{"origin":"https://your-relay.example"}`) at a relay you operate. `/rc` opens its QR code. Without a configured relay, `/rc` explains the setup instead of silently switching networks. The Mac and phone each make an outbound WebSocket to a Cloudflare Worker/Durable Object, which forwards opaque encrypted frames. The Mac encrypts session data and decrypts requests locally; the phone does the reverse using a random pairing key carried **only in the QR URL fragment**, not the HTTP request. AES-256-GCM protects prompts, replies, and snapshots in transit through the relay. The key is stored on the Mac at `~/.pi/agent/pix-remote/relay-key` (mode 600) and on the phone in this site's local storage; the QR disappears from the address bar after pairing. Run `/rc` for each Pi session you want to share. The QR appears only the first time; later `/rc` just turns sharing on, so refresh the saved phone page. Use `/rc pair` to show the QR for another device, or `/rc reset` to revoke old devices and pair again. The relay sees connection metadata and the opaque room ID, but does not store transcript data. The Mac must stay awake and connected. If `qrencode` is unavailable (`brew install qrencode`), `/rc` displays the pairing URL instead. The QR is a password: keep it private. `/rc pair` shows the existing QR again. `/rc reset` rotates the relay key and opens a new QR, revoking previously paired phones; run it in the Pi session hosting the hub. `/rc off` disconnects the session but does **not** revoke the pairing key.

The mobile app is JavaScript served by the relay operator. Encryption protects data from passive relay observation, **not** from an operator who changes the web app to steal its key. Do not use an untrusted `PIX_REMOTE_RELAY_URL`. The included Worker is self-hostable, not a bundled public relay service. Do not send package users to someone else's personal relay. Cloudflare limits and availability still apply.

**Private alternative:** `/rc tailnet` uses private Tailscale Serve; `/rc tailnet pair` shows its QR again (same-tailnet devices only). Its separate token is stored at `~/.pi/agent/pix-remote/token` (mode 600). Pix does not enable Funnel or replace unrelated Serve routes. `/rc off` does not alter Serve settings. You can add either mobile page to your iPhone Home Screen via Safari's Share menu.

Consecutive tool calls appear as one collapsed activity row with a running/failed count; expand it to inspect individual calls and their input/output. This follows [assistant-ui's Tool group pattern](https://www.assistant-ui.com/elements/tool-group) using native HTML disclosure elements instead of importing its React runtime. Images in Pi user messages and tool results are fetched from the authenticated Mac hub through the encrypted relay, not embedded in transcript snapshots. The phone can attach a picture; Safari converts it to a bounded JPEG before sending it into Pi's normal image prompt API. The current limit is about 900 KB per stored image (1.2 MB base64) and 24 cached images per session; oversized/unsupported images show an honest placeholder, and Markdown image URLs are not fetched. Tool dialogs, permission prompts, and model switching stay in the terminal; the app shows up to the latest 200 transcript items (fewer if needed to fit an encrypted relay frame) and truncates long tool output. The hosting Pi process must stay running. If it exits, another connected Pi session restarts the hub and relay on its next heartbeat.

The relay source and generic Wrangler config live in `relay/`; attach your own custom domain to its Worker in your Cloudflare account. No account, domain, or key is shipped in Pix. Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` only in the deployment environment, never in Git. For code-only releases use `wrangler versions upload` then `wrangler versions deploy <version-id>@100 --yes`; manage domain triggers separately. The configured URL must serve the matching mobile app and Worker. Run `npm run test:relay-ui` for a phone-sized browser journey against the deployed relay, `npm run test:relay-session` for a real Pi session with a scripted model, and `npm run test:relay-workflow` for a phone-driven Pi turn that executes six real tools and verifies the collapsed activity UI. They use disposable keys and fixture messages, never your private transcript. Run `npm run test:remote-ui` for the offline loopback UI regression check. It uses a fixture hub, checks the iPhone-sized chat, live updates, drawer, and prompt delivery, and saves an offline report under `.private/var/runs/test-ui/remote-cli-<timestamp>/`. Install the Playwright Chromium browser with `npx playwright install chromium`, or set `PIX_TEST_BROWSER_PATH` to a compatible executable. For actual iOS Simulator Safari interaction, run `./scripts/verify-remote-simulator.sh` on a Mac with Xcode, an iPhone 17 Pro simulator, and `xcodegen` installed. It runs an XCTest UI journey against a deterministic local fixture, records the simulator screen, and saves the video and `.xcresult` under `.private/var/runs/test-ui/remote-simulator-<timestamp>/`. Use `PIX_TEST_SIMULATOR_ID` for a different available device. This verifies Safari controls and the local hub, not a provider-backed Pi turn or the private-network connection. Simulator and browser checks do not establish behavior on a physical iPhone; retest the latest renderer, picker, and gestures there.

## MCP

Pix owns the MCP entry point, backed by a pinned, MIT-attributed `pi-mcp-adapter` 2.34.0 source snapshot in `vendor/mcp/`. Existing configuration discovery, authentication stores, `/mcp` commands, direct-tool names, and scripting are retained. Remove the standalone `npm:pi-mcp-adapter` entry from Pi's package settings and reload; do not load both. Configuration and credentials do not need conversion.

MCP defaults to **auto**. Startup and reconnect cannot activate deferred or disabled tools. Discover `mcp` for gateway calls or `mcpScript` for scripts; exact-name discovery loads only that tool. Configured search-mode direct tools can still be activated by an explicit MCP search. Custom-prefix tools share the MCP panel and policy.

See `vendor/mcp/UPSTREAM.md` for provenance and updates. Integration tests cover Pi 0.86.1, a local stdio server, and the scripting worker—not live remote OAuth providers.

## LSP

Pix does not download language servers. Install only what your projects need. For TypeScript, either Biome or `typescript-language-server` can provide diagnostics; repository typecheck and tests remain authoritative.

## Design boundaries

- Delegate only genuinely independent or context-heavy work.
- Default limits: 4 concurrent children, 8 per run, 24 per session, and one level of delegation.
- Use todo for meaningful multi-step work, not every response; optional dependencies form a validated DAG and an optional `agent` assigns an item to a subagent role at planning time. The plan output names prerequisites and the ready set. The compact widget uses a left-to-right graph when it fits, packing parallel tasks into the same column; narrow terminals use a top-to-bottom graph. Each task appears once, with rails for branches and joins. Completed prerequisites remain checked nodes. It focuses on six open tasks plus immediate prerequisites (at most twelve nodes), and reports omitted tasks or dependencies. Unrelated line crossings use `╳`, distinct from joins. If even the vertical graph cannot fit the terminal, an explicitly labelled list replaces it; `/todo` always shows the full dependency list. Connections express only actual dependencies, not wave-wide barriers. Nothing is scheduled or updated automatically; the model owns every status change.
- No autonomous memory, agent hub, or plan framework.
- Pix registers concise guidance on its own tools using Pi's `promptSnippet` and `promptGuidelines`. Discovery has one always-available rule; specialist guidance joins the effective prompt only while its tool is active. Pix does not rewrite the assembled system prompt or personal/project instructions. Context exports show the actual effective prompt unchanged.
- Dependency administration commands are hidden; Pix keeps eight user-facing commands, with related actions as verbs on the command that already owns them and rare inspection on a shortcut.

## Development

```bash
npm install
npm run check
npm run smoke:anthropic  # live OAuth check: Fable 5.1, Opus 5, Sonnet 5 at minimal
```

[prompt comparison](system-prompts.html) contains the complete public-safe naive-Pi and Pix prompts. `npm run bench` compares naive Pi with the active Pix prompt on the current machine and reports health and startup speed. Future task-performance checks are scoped in [roadmap](../ROADMAP.md).

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

Pix deliberately does not include unevaluated complexity: autonomous memory, nested agent hierarchies, persistent planning machinery, or broad automation frameworks. A feature belongs in Pix only when it solves a recurring coding need and its value can be measured against its prompt, latency, and maintenance cost.

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

Prompt counts use a GPT tokenizer on clean base prompts captured during Pix's design, excluding personal and project `AGENTS.md`, skills, and conversation context. Provider tokenizers and OMP's conditional configuration can produce different totals. [prompt comparison](system-prompts.html) contains the full public-safe naive-Pi → Pix comparison.

