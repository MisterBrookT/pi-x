# Pix

Pix is a focused [Pi](https://pi.dev) package: **web access + bounded subagents + visible todo tracking + optional LSP + Claude Code models**. It keeps Pi's small core and adds only the capabilities needed for daily engineering.

## Install

```bash
pi install git:github.com/MisterBrookT/pix
```

Restart Pi. Optional local setup applies Pix's conservative subagent limits:

```bash
cd ~/.pi/agent/git/github.com/MisterBrookT/pix
npm run setup
```

## What it adds

- `web_search` and content fetching through `pi-web-access`
- `subagent` through `pi-subagents`
- `todo` plus the `/todo` terminal view
- `lsp_diagnostics` and `lsp_fix` through configurable `pi-lsp`
- Claude Code subscription models through the local authenticated `claude` CLI
- `/bench speed` and `/bench doctor`
- `/pix-prompt` to export the exact active prompt

Claude Code models are intentionally limited to Fable 5.1, Fable 5, Sonnet 5, and Opus 5. Install and authenticate the official Claude CLI before selecting the `pi-claude-cli` provider.

## Commands

| Command | Purpose |
| --- | --- |
| `/todo` | Show todo state for the current session branch |
| `/bench speed` | Compare three naive-Pi and Pix startup samples |
| `/bench doctor` | Check expected tools and open a highlighted naive-Pi → Pix prompt diff |
| `/pix-prompt [path]` | Export the exact effective Pix system prompt |

## LSP

Pix does not download language servers. Install only what your projects need. For TypeScript, either Biome or `typescript-language-server` can provide diagnostics; repository typecheck and tests remain authoritative.

## Design boundaries

- Delegate only genuinely independent or context-heavy work.
- Default limits: 4 concurrent children, 8 per run, 24 per session, and 2 active async runs.
- Use todo for meaningful multi-step work, not every response.
- No autonomous memory, MCP umbrella, agent hub, or plan framework.
- Pix compresses verbose upstream prompt guidance into three short rules for todo, subagents, and LSP.

## Development

```bash
npm install
npm run setup
npm run check
```

`docs/system-prompts.html` contains the complete base Pi and OMP prompt comparison. `/bench doctor` compares naive Pi with the active Pix prompt on the current machine.

## License

MIT. See `THIRD_PARTY_NOTICES.md` for bundled and referenced upstream work.
