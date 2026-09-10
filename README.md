<div align="center">

# Pix

**Pix gives Pi wings for everyday coding.**

Practical tools and thoughtful defaults, in one Pi package.

</div>

## Install

Requires [Pi](https://github.com/earendil-works/pi-mono) and Node.js 22+.

```bash
pi install npm:@brooktang/pi-x
```

Restart Pi. Your usual Pi workflow stays the same.

<details>
<summary>Install from GitHub or ask your agent</summary>

```bash
pi install git:github.com/MisterBrookT/pi-x
```

Or paste this into your coding agent:

```text
Help me install Pix from https://github.com/MisterBrookT/pi-x. Verify that Pi and Node.js 22+ are available, install Pix using the documented Pi command, and do not change unrelated Pi configuration.
```

</details>

## About

Pix is a focused package for people who like Pi's simplicity but don't want to assemble their everyday setup from scratch. It brings web research, bounded delegation, background work, and a more comfortable editor together—without replacing Pi or turning it into a broad automation framework.

Pix is under active development. macOS and Linux are supported; Windows is not yet verified. Language servers and computer use require separate setup.

## What you get

- **Practical tools.** Web search and source retrieval, parallel subagents, and optional language-server diagnostics and fixes.
- **Less babysitting.** Visible todos, structured questions, background jobs that wake the agent when finished, and opt-in goal mode for unfinished work.
- **A more comfortable editor.** Inline history suggestions, optional AI completion, list continuation, and compact pasted text and images.
- **Control over the setup.** One tool panel, context inspection, and a configurable footer. Computer use and MCP start off.

## Start here

Use Pi normally—Pix's enabled tools are available to the agent as needed. A few controls worth knowing:

| Command | Use it to |
| --- | --- |
| `/tool` | Choose which tools are enabled |
| `/goal Fix the failing tests` | Keep working toward an explicit goal, within a continuation limit |
| `/complete on` | Enable cloud-model inline completion; off by default |
| `/context` | See what is filling the context window |

See the [full guide](docs/guide.md) for all commands, configuration, and limits.

<details>
<summary>Using a Claude subscription</summary>

Use `/login pix-anthropic`, then select a model under `pix-anthropic`.

**This is an unofficial compatibility transport.** Anthropic may change or reject it, and using it may risk account restriction. Pi's native `anthropic` provider remains unchanged and uses Anthropic's third-party extra-usage billing. Use that provider if the subscription-transport risk is unacceptable.

[Provider details](docs/guide.md#what-it-adds)

</details>

## Documentation

- [User guide](docs/guide.md) — tools, editor, commands, and configuration
- [Goal mode](docs/goal-mode.md) — continuation behavior and safety limits
- [Design philosophy](docs/guide.md#philosophy) — what belongs in Pix, and what doesn't
- [Development](docs/guide.md#development) · [Roadmap](ROADMAP.md) · [Report an issue](https://github.com/MisterBrookT/pi-x/issues)

## Thanks

Built on [Pi](https://github.com/earendil-works/pi-mono) and its extension community, especially LazyPi, pi-web-access, pi-subagents, and pi-lsp.

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for credits and licenses.
