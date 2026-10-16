# Plugins

One folder per feature. `index.ts` is the Pi extension; the other files are its logic.
A plugin imports only from itself and `core/` (a test enforces this; the one exception is remote using desktop, its phone-only part).

**Turn one off:** `pi config`, then untick it under the pix package. Every plugin loads on its own (tested).

**Phone page:** a feature adds its own hub routes, phone events, and relay allow-list with `registerHubPlugin` from `core/hub-plugin.ts` (see `foryou/hub.ts`). The hub names no feature.

| Plugin | What it does for brook |
|---|---|
| core | Plumbing: tool panel, which tools load when, capability actions, state reminders |
| remote | Phone page, hub and relay (rc.brooktang.fun) |
| desktop | See and control the Mac screen from the phone |
| foryou | Watches mail/chats, finds what needs brook, prepares it, the bell page |
| computer | Operate Mac apps and browser pages |
| subagents | Hand work to scout / worker helpers |
| web | Web search and page fetching (its own extension now) |
| chat | Pi sessions on this Mac talk to each other |
| goal / todo / background | Long goals, task plans, background commands |
| editor | Smarter input box: completions, @For you mentions |
| footer, fast-mode, mermaid, question, export, context, terminal-support | Small UI pieces |
| pix-anthropic | Claude provider |
