# Plugins

One folder per feature. `index.ts` is the Pi extension; the other files are its logic.
A plugin imports only from itself and `core/` (plus a few shared helpers noted below).

| Plugin | What it does for brook |
|---|---|
| core | Plumbing: tool panel, which tools load when, capability actions, state reminders |
| remote | Phone page, hub and relay (rc.brooktang.fun) |
| desktop | See and control the Mac screen from the phone |
| foryou | Watches mail/chats, finds what needs brook, prepares it, the bell page |
| computer | Operate Mac apps and browser pages |
| subagents | Hand work to scout / worker helpers |
| web | Web search and page fetching |
| chat | Pi sessions on this Mac talk to each other |
| goal / todo / background | Long goals, task plans, background commands |
| editor | Smarter input box: completions, @For you mentions |
| footer, fast-mode, mermaid, question, export, context, terminal-support | Small UI pieces |
| pix-anthropic | Claude provider |
