# Goal mode

Goal mode is an opt-in continuation loop for a concrete objective. **Every new
session starts with goal off.** Enabling a goal in session A neither enables goal
mode nor shares its objective with session B, even if both sessions use the same
project. It prevents a plan or progress report from silently ending the task. It is not a scheduler,
permission bypass, or guarantee that an arbitrary goal can be achieved.

## Use

After reloading a local Pix installation, start with an objective and acceptance
criteria:

```text
/goal Fix the parser's empty-input bug, add a regression test, and pass npm run check.
```

| Command | Effect |
| --- | --- |
| `/goal <objective>` | Start or replace a goal while Pi is idle |
| `/goal` | Open the configuration menu in the TUI: state, objective, reason, and available start/pause/resume/replace/clear actions; opening or cancelling changes nothing |
| `/goal status` | Show objective, state, continuation count, and completion evidence or pause/blocker reason (also the no-argument behavior outside the TUI) |
| `/goal pause` or `/goal stop` | Stop future goal continuations; current work is not cancelled |
| `/goal resume` | Resume a paused or blocked goal and reset the continuation allowance |
| `/goal clear` | Remove the goal; current work is not cancelled |

The footer shows **goal on** only while active, including the continuation count
and **waiting** when background work is outstanding. Off, paused, completed,
blocked, and cleared goals add nothing to the footer. Use `/goal status` to inspect
an inactive goal. This uses Pi's existing status API, with no extra polling or
status process.

Press `Esc` to interrupt current agent work. Use `background stop` to terminate a
background command; pausing or clearing a goal does not kill its jobs. Their
results are retained, but a goal-owned command finishing while its goal is
inactive does not wake the agent. Subagents retain their existing stop and native
notification behavior; pausing a goal does not cancel children or disable their
notifications.

Goal mode requires a persistent TUI or RPC session. It refuses to start or resume
while another turn is running or messages are queued. If the `goal` tool has
been disabled, enable it with `/tool goal on` first. Starting a goal never changes
tool permissions or enables disabled tools.

## Continuation and stopping

At Pi's fully settled boundary, Pix checks the active goal:

1. If a background command or subagent is still running, wait for its native
   completion notification. There is no timer-driven polling or repeated model
   call while waiting. Subagent status is queried once at the idle boundary
   through the installed package's public event-bus API; an unavailable status
   pauses the goal rather than guessing. Pix does not expose `bg_wait`; ordinary
   command and subagent notifications do not require it. Explicit blocking waits
   and subscriptions to external jobs are outside Pix's tool surface.
2. If work remains, send one visible follow-up to the agent.
3. After **10 automatic goal continuations**, pause for review. Explicit
   `/goal resume` resets the used count. This bounds additional goal prompts,
   not tool calls, tokens, cost, or time within each agent run. Native background
   completion wakes do not consume the allowance.

The agent ends goal mode by calling the small `goal` tool with the active goal's
exact ID, a `completed` or `blocked` status, and evidence:

- **Completed:** state the checks performed and their results. Outstanding
  background work prevents completion.
- **Blocked:** identify missing information, authorization, or a prerequisite.
  Merely waiting for an active job is not a blocker.

An ordinary final answer does not mark a goal completed. Evidence is required,
but remains **the agent's report**, not an independent audit: there is no second
judge model or automatic verifier. Give measurable acceptance criteria and
review consequential changes yourself. Existing confirmation requirements still
apply.

Ordinary user messages and steering input keep an active goal enabled. Use
`/goal pause` or `Esc` when you want to stop the loop. Pi's native model retries
and context-overflow recovery are allowed to finish before Goal judges the
outcome; a transient error followed by success does not pause it. An unrecovered
model error or agent abort still pauses the loop. A message such as “go on” does
not reactivate an already paused goal: open `/goal` and choose Resume goal, or
use `/goal resume`. Successful completion and blockers stop future goal prompts.
Completing a goal still permits the agent's normal final summary.

## Persistence and prompt footprint

- Goal state is stored in a session custom entry, separate from model context.
- Goal changes append a hidden, durable message with the current status,
  objective, and continuation/completion rules. Unchanged state adds nothing.
  Compaction restores a reminder only if the current one is no longer retained.
  Background-result wakes see the same saved context; `AGENTS.md` and the system
  prompt are not modified.
- Earlier reminders stay in history. Pausing, completing, blocking, or clearing
  a goal appends an explicit update superseding the old instructions rather
  than removing them. This keeps the conversation prefix stable for cached
  continuation. Cache-hit percentages still depend on the provider.
- Sessions that have never enabled goal mode add no goal-state messages. The
  small `goal` tool schema is present when enabled, like other Pix tools.
- `/reload` preserves the current session's goal status, objective, and used
  continuation count. It does not create a new goal or launch an extra turn;
  subsequent turns still receive active goal context.
- Reopening a closed session, forking, or navigating the session tree restores
  active goals paused from the selected branch, never silently restarted.
- Goals are session-local. There is no cross-session scheduler or goal queue.

## Implementation and tests

`extensions/goal.ts` owns the command, reporting tool, state reminders,
persistence, and `agent_settled` continuation hook. `src/goal-state.ts` validates
saved state; `src/goal-work.ts` checks pending work. `src/state-reminder.ts`
handles append-only, deduplicated messages shared with Todo. Background commands and
goals coordinate via Pi's session-scoped event bus in `src/background-state.ts`.
No new dependency or secondary model is used.

`tests/goal.test.mjs` covers state, limits, races, and public subagent status
shapes. `tests/goal-runtime.test.mjs` uses real Pi sessions with scripted provider
responses and real shell processes to exercise continuation, background waits,
pause/clear, interruption, failures, and compaction checkpoint restoration.
`tests/state-reminder-runtime.test.mjs` checks stable request prefixes through
state changes, tool-result ordering, reload deduplication, and manual/automatic
compaction recovery. These deterministic checks do not depend on a provider's
cache-hit percentage.
