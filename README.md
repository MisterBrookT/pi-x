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
- Claude subscription access;
- prompt and startup-overhead inspection.

In the input editor, `Shift+Enter` continues ordered and bullet lists. Pasted images and substantial text appear as compact rows such as `▣ image 1  294×490` and `▤ paste 1  42 lines`; Pix restores their full content before Pi processes the prompt. Image detection uses the actual pasted file, not terminal-specific paths or filenames.

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
| Claude subscription models | No | Yes | Yes |
| User-facing surface | Small | Five Pix commands | Broad |

Prompt counts use a GPT tokenizer on clean base prompts captured during Pix's design, excluding personal and project `AGENTS.md`, skills, and conversation context. Provider tokenizers and OMP's conditional configuration can produce different totals. `docs/system-prompts.html` contains the full public-safe naive-Pi → Pix comparison.

## Install

### Prerequisites

- [Pi coding agent](https://github.com/earendil-works/pi-mono) installed and available as `pi`
- Node.js 22 or newer
- Optional: the authenticated [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) for Claude subscription models

Install Pix:

```bash
pi install git:github.com/MisterBrookT/pix
```

Or ask an agent:

```text
Help me install Pix from https://github.com/MisterBrookT/pix. Verify that Pi and Node.js 22+ are available, install Pix using the repository's documented Pi command, and do not change unrelated Pi configuration.
```

Restart Pi.

## What it adds

- `web_search` and content fetching through `pi-web-access`
- `subagent` through `pi-subagents`
- `todo` plus the `/todo` terminal view
- a restrained smart editor that continues lists and compacts pasted images
- `question` for structured user choices, adapted from Pi's official example
- `lsp_diagnostics` and `lsp_fix` through configurable `pi-lsp`
- `/bench` for health, startup-speed, and prompt-overhead checks
- `/prompt` to export the exact active prompt
- a configurable footer with cache efficiency and latest-response token speed

For Claude subscription models, authenticate Pi's native `anthropic` provider and select the model there. Pix deliberately does not proxy model calls through the `claude` CLI: Pi's native provider preserves structured conversation history and prompt caching across tool turns.

## Commands

| Command | Purpose |
| --- | --- |
| `/footer` | Choose footer metrics; choices persist across sessions |
| `/todo [on\|off]` | Show todo state or toggle tracking for this session |
| `/prompt [path]` | Export the exact effective Pix system prompt |
| `/bench` | Check Pix health, startup speed, and prompt overhead |
| `/websearch [on\|off]` | Show or toggle web access for this session |
| `/subagent [on\|off\|config]` | Show, toggle, or configure subagent role models |

Pix keeps three primary roles: `worker` for implementation, `scout` for fast codebase discovery, and `critic` for read-only review. Each can use a different model and thinking level through `/subagent config`.

## LSP

Pix does not download language servers. Install only what your projects need. For TypeScript, either Biome or `typescript-language-server` can provide diagnostics; repository typecheck and tests remain authoritative.

## Design boundaries

- Delegate only genuinely independent or context-heavy work.
- Default limits: 4 concurrent children, 8 per run, 24 per session, and one level of delegation.
- Use todo for meaningful multi-step work, not every response.
- No autonomous memory, MCP umbrella, agent hub, or plan framework.
- Pix compresses verbose upstream prompt guidance into three short rules for todo, subagents, and LSP.
- Dependency administration commands are hidden; Pix keeps five user-facing commands.

## Development

```bash
npm install
npm run check
```

`docs/system-prompts.html` contains the complete public-safe naive-Pi and Pix prompts. `/bench` compares naive Pi with the active Pix prompt on the current machine. Future task-performance checks are scoped in `ROADMAP.md`.

## Acknowledgements

Pix is built on Pi and the work of its extension community. Special thanks to:

- **Pi**, for the coding harness, extension API, and official todo and question examples adapted by Pix.
- **LazyPi**, whose curated package catalog demonstrated a practical combination of web access, subagents, todo tracking, and Claude CLI integration.
- **pi-web-access**, **pi-subagents**, and **pi-lsp**, which provide Pix's web, delegation, and language-server capabilities.

See `THIRD_PARTY_NOTICES.md` for repositories and licenses.

## License

MIT. See `THIRD_PARTY_NOTICES.md` for bundled and referenced upstream work.
