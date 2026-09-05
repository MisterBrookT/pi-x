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

In the input editor, Pix shows a subtle but readable inline suggestion: zsh-style prefix matching reuses the newest matching prompt from the current session, with lightweight macOS dictionary completion as a fallback for prose words. Tab accepts the suggestion. `/complete on` adds AI completion: a small cloud model (Haiku 4.5 through `pix-anthropic` by default; `/complete model` picks another) predicts what you will type next from the last few turns, in your own voice, and proposes a likely next message when the editor is empty. Longer predictions wrap onto up to three lines below the cursor. While it is on, the history and dictionary suggestions step aside so the ghost text always comes from the model. Requests are debounced and cancelled on every keystroke, send only the last few turns, and the feature stays off until you enable it. Pix commands still use menus to complete supported arguments such as `/subagent config`. `Shift+Enter` continues ordered and bullet lists. Pasted images and substantial text appear as compact rows such as `▣ image 1  294×490` and `▤ paste 1  42 lines`; Pix restores their full content before Pi processes the prompt. Image detection uses the actual pasted file, not terminal-specific paths or filenames.

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
| User-facing surface | Small | Seven Pix commands | Broad |

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
- `subagent` through `pi-subagents`
- `todo` plus the `/todo` terminal view
- inline local-history and macOS word completion, optional AI completion via `/complete`, plus a restrained smart editor that continues lists and compacts pasted images
- `question` for structured user choices, adapted from Pi's official example
- `lsp_diagnostics` and `lsp_fix` through configurable `pi-lsp`
- `/bench` for health, startup-speed, and prompt-overhead checks
- `/fast` for persistent priority-processing control on supported providers
- `/prompt` to export the exact active prompt
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
| `/todo [on\|off]` | Show todo state or toggle tracking for this session |
| `/prompt [path]` | Export the exact effective Pix system prompt |
| `/bench` | Check Pix health, startup speed, and prompt overhead |
| `/websearch [on\|off]` | Show or toggle web access for this session |
| `/subagent [on\|off\|config]` | Show, toggle, or configure subagent role models, thinking, and fallback |

Fast mode uses OpenAI's `service_tier: "priority"`, Anthropic's `speed: "fast"`, or Google's priority tier according to the active direct provider, including `pix-anthropic`. Availability and any extra charges are determined by the provider. The preference persists across sessions, the footer shows `fast` while active, and it does not affect subagents. Anthropic models without upstream fast-mode support automatically use normal speed and show a warning instead of failing.

Pix focuses on four built-in roles from `pi-subagents`: `worker` for implementation, `scout` for fast codebase discovery, `reviewer` for read-only review, and `researcher` for web research. Each can use a different model, thinking level, and cross-provider fallback model through `/subagent config`.

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
- Dependency administration commands are hidden; Pix keeps seven user-facing commands.

## Development

```bash
npm install
npm run check
npm run smoke:anthropic  # live OAuth check: Fable 5.1, Opus 5, Sonnet 5 at minimal
```

`docs/system-prompts.html` contains the complete public-safe naive-Pi and Pix prompts. `/bench` compares naive Pi with the active Pix prompt on the current machine. Future task-performance checks are scoped in `ROADMAP.md`.

## Acknowledgements

Pix is built on Pi and the work of its extension community. Special thanks to:

- **Pi**, for the coding harness, extension API, and official todo and question examples adapted by Pix.
- **LazyPi**, whose curated package catalog demonstrated a practical combination of web access, subagents, and todo tracking.
- **pi-web-access**, **pi-subagents**, and **pi-lsp**, which provide Pix's web, delegation, and language-server capabilities.

See `THIRD_PARTY_NOTICES.md` for repositories and licenses.

## License

MIT. See `THIRD_PARTY_NOTICES.md` for bundled and referenced upstream work.
