# ADR 0001 — Computer use in pix: a script surface over an accessibility backend

- Status: accepted, implementation in progress
- Date: 2026-09-06

## Context

pi has no built-in way to operate a GUI. We wanted the agent to be able to drive
websites and native desktop apps when no CLI or API exists, and we wanted to
understand what the current generation of products actually does before building
anything.

### What exists in the pi ecosystem

Three published packages, found by searching the npm registry for pi packages:

| Package | Scope | Downloads/mo |
| --- | --- | --- |
| `pi-agent-browser-native` | browser only, wraps the `agent-browser` CLI | ~14k |
| `@injaneity/pi-computer-use` | desktop **and** browser, OS accessibility APIs | ~2k |
| `pi-chrome-use` | browser only, raw JS over CDP | ~130 |

### How the products actually work

Read from the shipped sources rather than marketing pages. Every computer-use
system is the same loop — perceive, decide, act, observe — and the design
choices live in only two places: how the screen is described to the model, and
what format the model emits.

Perception has two forms. **Pixels**: send a screenshot, the model finds the
button visually and answers with coordinates; a 40px window move breaks it.
**Accessibility tree**: ask the OS what elements exist and get back text
(`@e9 button "Send"`), which survives layout changes. **Fused** sends both, using
the image for regions the tree cannot describe.

Emission also has two forms. **Structured tool calls** (`{action:"press",
ref:"@e9"}`) are inspectable before execution and fail one step at a time.
**Code execution** lets the model write a program that loops without a model
round trip per step.

Where each product sits:

| | Perception | Emission |
| --- | --- | --- |
| Claude `computer` tool | screenshot only | tool call with coordinates |
| Codex `cua_repl` | screenshot **+** accessibility tree | JavaScript against `sky.*` / `cua.*` |
| `pi-agent-browser-native` | accessibility snapshot | CLI args |
| `@injaneity/pi-computer-use` | fused, OCR on demand | tool call with `@e` refs |

Codex was inspected directly at
`~/.codex/plugins/cache/openai-bundled/unified-computer-use/` and
`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/`.
Findings worth recording:

- It exposes exactly **two** tools: `js` and `js_reset`. The scaffold is thin.
- Tool documentation is returned *by the first call*, not front-loaded into the
  prompt. The whole static prompt payload is 56 lines.
- Its macOS window API returns a screenshot *and* accessibility text, accepts
  either an `element_index` or raw `x`/`y`, and **diffs the accessibility tree
  between calls** to save context. It is a hybrid, not a pure semantic system.
- Its full-desktop (Linux/VM) API is pure pixels, with no accessibility at all.

So the current paradigm is: hybrid perception, and a genuine industry split on
emission. Nobody has won the second question. Claude is the outlier still on
pure pixels.

### Capability ceiling

OSWorld 2.0 (108 long-horizon real workflows, ~318 tool calls each): the best
configuration completes **20.6%** of tasks outright, 54.8% partial. GUI control
is fragile everywhere. This is the strongest argument for treating a CLI or API
as the primary path and GUI control as the fallback.

## Decision

**1. One backend: `@injaneity/pi-computer-use`.**

`pi-agent-browser-native` was installed, verified working, then removed along
with the global `agent-browser` CLI. It is the more polished browser stack
(recording, auth profiles, WebMCP passthrough), but it covers only the browser,
and paying for two overlapping tool surfaces was not worth it. The chosen
backend covers desktop and browser through one contract, uses fused perception,
and ships `evaluate_browser` as a code-execution escape hatch — architecturally
the closest thing in the pi ecosystem to Codex's design.

**2. Add a Codex-style script surface on top, in pix.**

The backend's eleven tools are correct but expensive to drive: one model round
trip per UI step. pix adds a `computer` tool where the model writes one
JavaScript program against a small `cua` API. Loops, extraction, and multi-step
flows collapse into a single call.

**3. Keep the safety properties that code execution normally destroys.**

This is the crux. Structured tool calls are gateable because a call can be read
before it runs; arbitrary code cannot be. Rather than choose, the runtime meters
the code:

- Every backend call is counted against a budget (default 40 mutating actions,
  200 calls) and recorded in an ordered trace returned with the result.
- Action batches are summarized and matched against an irreversible-verb list
  (send, delete, pay, publish, …) resolved through the element's accessibility
  label. A match requires confirmation; an approved summary is remembered so a
  loop asks once rather than N times.
- With no confirmation gate wired, irreversible actions are **refused**, so a
  missing gate can never mean "allowed by default".
- Script failures return the trace, so a failure at step 17 of 30 is
  diagnosable without a second round trip — the main thing code execution
  normally costs you versus tool calls.

**4. Read/write split.**

`state.eval(...)` runs JavaScript in a browser page for extraction, where there
are no side effects and the output is the verification. `state.act(...)` handles
mutation, where per-step evidence and gating matter. This mirrors what the
backend already offers and is arguably a better factoring than Codex's uniform
`js` for the mutating half.

**5. `expect` is mandatory in practice.**

A delivered click is not a completed action. The backend supports attaching a
postcondition to an action transaction, returning `verified`, `preexisting`, or
`failed`. The skill requires it; without it "I clicked Send" means only that the
event was delivered.

## Consequences

- One tool surface, Codex-shaped, over a maintained backend we do not own.
- No per-step gating on mutations inside a script; gating happens per action
  batch through the confirmation callback instead. This is weaker than what pure
  tool calls allow and is accepted deliberately in exchange for speed.
- The script runner is a **capability boundary, not a security sandbox**. The
  script runs in-process and can still reach globals it names explicitly. The
  guarantee is that the intended surface is small and every backend call is
  metered and traced.
- No cheap loops over *desktop* apps. `eval` requires a JS runtime to inject
  into, which native apps do not have. Desktop batching is limited to what
  `act_ui` transactions support.
- Electron apps (Feishu, WeChat) publish thin accessibility trees, so the system
  degrades toward OCR and coordinates exactly where we most want it to work.
  Expected reliability: websites good, native macOS apps good, Electron poor.

## Open questions

- Whether the confirmation gate's verb list is the right mechanism, or whether
  it should key on the state diff after the fact instead of the label before.
- Whether desktop flows need a batching primitive beyond `act_ui` transactions.
- Whether Codex's accessibility-tree *diffing* between observations is worth
  reimplementing; it is a real context saving we currently do not have.
- WebMCP (pages declaring their own agent tools) is a live W3C proposal with
  near-zero adoption. Not actionable, worth re-checking.

## Status of verification

- Both packages installed and `agent-browser` verified end to end against
  example.com before removal.
- `@injaneity/pi-computer-use` helper installed at
  `~/Applications/pi-computer-use.app`; macOS Accessibility and Screen Recording
  permissions **not yet granted**, so no desktop flow has been executed.
- The script surface is implemented in `plugins/computer/computer-script.ts` and
  `plugins/computer/computer-runner.ts`; tests and the pix extension wiring are outstanding.

## Addendum — cross-checked against Codex's shipped implementation

After the initial implementation, the bundled Codex sources at
`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua/docs/`
were read directly. Four things were adopted:

1. **A written confirmation policy, not a verb list.** Codex ships a 78-line
   `tinysky-alt-confirmations.md` with a four-tier taxonomy: hand-off required,
   always confirm at action time, pre-approval works, and always allowed. It is
   scoped explicitly to GUI actions and excludes ordinary terminal commands.
   Several rules would not have been derived from first principles: typing
   sensitive data into a form counts as transmission; "go to xyz.com" implies
   consent to log into xyz.com; content read from a page is never permission;
   confirm at the point of impact rather than early, except for data
   transmission, where the confirmation must come before typing. This is now the
   `## Confirmation policy` section of the skill. The regex in
   `computer-script.ts` was broadened to match the policy's categories but is
   demoted to a backstop: a label cannot distinguish a draft "Send" from a real
   one, so judgement belongs in the policy and the regex only ensures a model
   ignoring the policy still cannot silently transmit or destroy.

2. **Persistent state across calls.** Codex states `cua_repl` state is
   persistent across calls. The backend likewise keeps saved states between tool
   calls, so `cua.state(stateId)` was added to rebind an id from an earlier call
   instead of paying for a fresh observation.

3. **Batch, then observe.** Codex's guidance is to batch deterministic actions
   and the resulting state read into one call. `act` already accepts an array;
   the tool description now says so explicitly, with the condition under which a
   step must be sent alone.

4. **Completion is visible, not attempted.** Codex closes with "attempting an
   action is not completion: verify that the returned UI state visibly shows the
   requested result." Added to both the tool description and the skill.

One Codex feature was noted and **not** adopted: accessibility-tree diffing
between observations, where the tree is returned as a delta by default with
`{ disableDiffing: true }` to force a full read. The chosen backend already
returns a successor diff after actions, so the remaining gap is narrower than it
first appeared. Left as an open question.

### Runtime findings from wiring

Two real compatibility failures surfaced only when testing against pi's actual
loader rather than the test harness:

- `import("@injaneity/pi-computer-use/src/bridge.ts")` fails from a pix working
  copy outside the tree holding the backend, and plain Node additionally refuses
  to type-strip `.ts` files under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Absolute-path imports do work
  inside pi's loader, which strips types. `loadBackend()` therefore falls back to
  explicit roots, and the tool is only usable inside pi.
- `validateToolArguments(schema, args)` is the wrong signature; it takes
  `(tool, toolCall)` and returns parsed arguments, throwing on invalid input.
  The test was corrected rather than the code.

## Addendum — first live run

Both TCC permissions granted; the tool was exercised against real applications.
Two bugs surfaced that no fake backend would have caught, which is the argument
for testing against the real interface rather than a permissive mock:

1. **State ids live in two places.** Desktop observations return the successor
   id as `details.capture.stateId`; browser observations use a top-level
   `details.stateId`. The original code read only the latter, so every desktop
   observation failed with "Backend returned no stateId". `stateIdOf` now checks
   both shapes and returns undefined rather than silently falling back to the
   previous id, which would have acted against a stale state.

2. **Evaluating in a page advances its epoch.** A second `eval` against the same
   binding failed with `State is stale ... expected epoch 0, current epoch 1`.
   A `CuaState` now tracks the advancing id internally for `eval` and
   `navigate`, so a script can evaluate repeatedly against one binding.

Verified working end to end:

- desktop observation of Notes: 150 refs, a real AX outline with roles and
  exposed actions (`AXWindow`, `AXOutline`, `AXCell`, `{AXShowMenu}`)
- `search_ui` against the cached state
- browser launch, `waitFor` a load condition, then repeated `eval` extraction:
  `{ title: "Example Domain", links: ["Learn more"], h: "Example Domain" }`
- the confirmation gate firing on a genuine irreversible control in Notes:
  the prompt appeared, declining aborted before the backend was called

Known rough edges, all reported clearly by the backend rather than failing
silently: role-only wait conditions require `ref` or `scopeRef`; a browser page
and a desktop root are separate resources, so `cua.observe({root})` cannot be
used to re-target an open browser page; and a browser `press` needs an
actionable ref owned by that page's state.

Timing: a three-call desktop script completes in about 1 second, a five-call
browser script in about 2 seconds.

## Addendum: iteration 2 ("general and simple")

**Step 1 shipped** (hub `ea5a731`). The WeChat send helper now opens only the exact-name Contacts / Group Chats / Most used result, strips `\r`, and re-reads the open chat's title by OCR right before Enter. Any mismatch refuses and clears the draft. It also refuses on a locked screen. Tested live: the exact match found 浙大 李老师 报销 (not the VAG group), a missing name was refused, and one test was sent to brookkk. Trigger: on 2026-10-19 search + Enter opened a 73-person group instead of a private chat (caught at preview).

**Lesson that shapes 2-4:** before an irreversible step, the agent must check *who or what it is acting on*, not only that a button exists. And for apps without an AX tree, "look" has to mean pixels + OCR.

### Step 2: screen-only apps inside the same tool (design)
- `cua.observe({ app: "WeChat" })` already returns a state. When the AX tree is empty or near-empty (WeChat 4.x: a window, 2 groups, 3 buttons), the state switches to **screen mode**: a window screenshot + OCR lines become pseudo-refs (`@t12 text "浙大 李老师 报销" at x,y`), and `act({ref:"@t12", action:"click"})` posts a real mouse event at the line's center.
- Irreversible gate in screen mode: a `send`-like keypress/click needs a `target` assertion, e.g. `act([...], { expect:..., target:{ title:"浙大 李老师 报销" } })`. The runtime re-OCRs the title region right before the act and refuses on mismatch. The same assertion also works for browsers (URL / heading) and AX apps (window title).
- `send.sh` becomes a thin recipe over this (prepare = observe + find exact + act; send = target-checked Enter). Its rules stay in the WeChat skill; the mechanism lives in the tool.
- Size: OCR + click helpers are about 60 lines of Swift (already written for step 1), plus about 150 lines of TS in `plugins/computer`.

### Step 3: about 3 calls (design)
- `look(target, { query?, depth? })` → state: AX outline (or OCR in screen mode) + screenshot handle. `query` replaces `search_ui`; `depth`/`ref` replace `expand_ui`/`inspect_ui`.
- `act(state, actions, { expect, target })` → next state. Covers press/click/type/key/scroll/drag by ref or x/y.
- `eval(state, js)` for browser pages only.
- Plus `launchBrowser`/`navigate` kept as helpers on `look`. `roots`, `waitFor` and `read` fold in as `look` options. The backend's 11 tools stay underneath; only the model-facing `cua` surface shrinks. This is mostly docs + a compat layer: old names keep working for a while.

### Step 4: AX diffs between looks (design)
- Cache the last outline per state lineage. On the next `look`/`act` result, send `+ added`, `- removed` and `~ changed` lines (keyed by role + label + path), plus a full outline only when more than 40% of it changed or on request (`look({ full:true })`).
- Screen mode diffs OCR lines the same way (same text + similar position = unchanged).
- Expected win: a 150-ref Notes outline after one click becomes 3-10 lines. Risk: refs must stay stable across diffs; keep ids for unchanged elements and re-key only what changed.

**Order and risk:** 2 → 3 → 4. Step 2 is the most valuable (it removes the separate WeChat script path) and is medium-risk. Step 3 is low-risk (surface only). Step 4 is medium-risk (ref stability) and gets its own tests against Notes and a browser page.

### Iteration 2: built (2026-10-19)

| Step | Commit | What shipped |
|---|---|---|
| 1 | hub `ea5a731` | WeChat helper: exact-name result, `\r` stripped, OCR title check before Enter |
| 2 | pix `b192615`, hub `166540f` | `computer-screen.ts`: screen mode (`cua.observe({ app, mode: "screen" })`, OCR `@t` refs, real HID click / paste / keys, locked-screen refusal). **Target guard in every mode**: an irreversible act needs `{ target: { title } }` (exact AX window/heading or OCR header) or `{ target: { url } }` (same origin + path prefix), re-checked right before it runs, then the confirm prompt. `plugins/computer/wechat.ts` is the WeChat recipe; `send.sh` is a one-line wrapper. |
| 3 | pix `2bd3ea3` | `cua.look(target)`, `state.look(options)`, `act(…, expect, { target })`, `eval`. All old names are kept as aliases. |
| 4 | pix `b86c7b1` | After the first look, act results carry `+` / `-` / `~` lines only; the full outline is used past 40% change; `look()` returns it. Guards and the irreversible check always read the full tree. |

Verified: 1059 tests, including the VAG-group incident as a regression. WeChat screen mode was run live (find, refuse on a missing name, prepare → send to brookkk only).

**Live on Finder (2026-10-19), steps 3–4 verified.** The earlier "Root is not owned by a running app" was not TCC (found by For you): `look({ app })` took the first root, which for Finder is the untitled desktop backdrop. It now prefers the titled `main` window; a titled background window captured cropped, so its refs fell outside the image. Run: look → 160 lines, `look({ query: "Name", role: "AXButton" })` → `@e350 [exact]`, press → act result 12 lines (the backend's own `Changes (N, a → b)` delta), `look()` after → 160 lines again. The backend already returns deltas for acts, so pix shows those as-is and keeps a merged outline for `look()` and the guards.
