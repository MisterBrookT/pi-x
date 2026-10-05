# Proactive

Most assistants wait for you to ask. Pix Proactive watches your channels, decides what matters, and comes back to you with one clear next step.

## The idea in one picture

```mermaid
flowchart LR
  S[New messages<br/>Feishu, mail, ...] --> J{Important<br/>to me?}
  J -- no --> X[Shown nowhere]
  J -- yes --> L[(One list)]
  L --> M[Mac]
  L --> P[iPhone]
  M -- Do it --> W[A normal Pi session<br/>prepares the next step]
  P -- Do it --> W
```

Three rules keep it calm:

1. **Decide once.** The judge decides whether something matters. Unimportant things never appear anywhere.
2. **One list, shown everywhere.** The Mac and the iPhone show the same list. Handle an item on one, it is gone on the other.
3. **Nothing is sent without you.** "Do it" starts a Pi session that prepares the work. Anything outbound is drafted for your approval first.

## What runs where

No terminal becomes a "proactive terminal". Everything runs in the background or in normal sessions.

```mermaid
flowchart TB
  subgraph BG["Background on the Mac (no window)"]
    D["Daemon<br/>receive → judge → write list"]
  end
  subgraph DATA["~/.pix/proactive/"]
    I[(inbox.jsonl<br/>the one list)]
    MEM[memory.md<br/>what matters to me]
    C[config.json<br/>sources]
  end
  subgraph VIEW["Views (read the list)"]
    PILL[Mac pill 🔔]
    PHONE["iPhone: For you"]
  end
  D --> I
  MEM --> D
  C --> D
  I --> PILL
  I --> PHONE
  PILL -- Do it / Not now --> I
  PHONE -- Do it / Not now --> I
  I -- Do it --> SES["New Pi session<br/>(listed under Sessions on Mac and iPhone)"]
```

| Piece | File | Job |
|---|---|---|
| Core | `src/proactive.ts` | Types, judge prompt, verdict, list format, rate limit |
| Sources | `src/proactive-sources.ts` | One adapter per channel |
| Daemon | `scripts/proactive-daemon.ts` | Poll sources, judge, write the list; `act` and `dismiss` verbs |
| Mac view | `scripts/proactive-pill.swift` | Floating 🔔 with the count; click to see items |
| iPhone view | Pix Remote, "For you" section | Same list, same buttons |

## One item

Every item answers three questions and offers two buttons:

| Field | Example |
|---|---|
| What happened | The data-source doc you asked for is ready |
| Why it matters | You were waiting on it; it unblocks step 1 |
| Where | Project chat |
| **Do it** | Start a Pi session that prepares the next step |
| **Not now** | Remove it everywhere |

## The judge

The judge is one small model call per batch of new messages. It reads:

- your `memory.md`: projects, what you are waiting on, promises you made
- recent messages for context, and the new ones
- items already in the list, so it does not repeat itself

It stays quiet by default and speaks up only when someone needs you, something you waited for arrives, a decision or blocker appears, or a promise is still open. A rate limit caps alerts per hour.

## Sources are plug-ins

```mermaid
flowchart LR
  F[feishu adapter] --> CORE[Daemon + judge<br/>unchanged]
  CMD[command adapter<br/>any script → JSON] --> CORE
  NEW[your adapter<br/>mail, WeChat, ...] -.-> CORE
```

An adapter has two functions: `fetch(source)` returns recent messages oldest first, and `howToRead(source, ids)` tells the acting session how to open the originals. Register it in `adapters` and add the source to `config.json`.

For a quick integration, use the `command` kind: any command that prints `[{"id","time","sender","text"}]`.

```json
{ "kind": "command", "id": "mail", "name": "Mail", "command": "my-mail-export --json" }
```

## Files

| File in `~/.pix/proactive/` | Content |
|---|---|
| `config.json` | Your name, sources, poll interval, judge model, alerts per hour |
| `memory.md` | What matters to you. The judge reads it every time; edit freely |
| `inbox.jsonl` | The list. Append-only; later status lines win |
| `state.json` | Last seen message per source |
| `daemon.log` | One line per judged batch |

Set `PIX_PROACTIVE_DIR` to use another folder.

## Run

```bash
node scripts/proactive-daemon.ts --once --dry-run   # judge once, change nothing
node scripts/proactive-daemon.ts                    # keep watching
swiftc -O scripts/proactive-pill.swift -o ~/.pix/proactive/pill
```

Keep the daemon and the pill running with launchd. The first poll of a new source only remembers where it is, so old history does not flood you.
