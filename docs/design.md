# Pix design rules

One page. Phone and Mac follow the same rules. Built on the live remote page's warm palette (`plugins/remote/remote-web.ts`, `data-palette="warm"`); the For you timeline mockup (`plugins/remote/foryou-timeline-mock.html`) is the reference.

## Feel
Calm paper, not a dashboard. Few words, no filler, no emoji faces, no red badges, no bells. Two navigation levels at most.

## Palette
| Token | Light | Dark | Use |
|---|---|---|---|
| paper | `#faf9f5` | `#1b1814` | page background |
| card | `#fffefb` | `#221e19` | posts, sheets |
| ink | `#29261f` | `#efe8db` | headlines, body |
| soft | `#7b7568` | `#b3a994` | context, secondary actions |
| faint | `#a8a194` | `#7d7466` | time, "via", hints |
| rule | `#e9e4d8` | `#332d25` | borders, dividers |
| you | `#c2410c` | `#f0a35e` | rare: overdue only |

Calm first: no status dots, no coloured chips. Being in the feed already means it needs brook. The main action is ink, semibold; due dates are soft text ("due tomorrow"). Colour is reserved for something truly late.

## Texture
Paper grain: a fractal-noise SVG at ~9% opacity (5% in dark) over the paper colour, plus a faint warm glow at the top. Cards have a 1px rule border and a soft warm shadow (`0 6px 18px -12px rgba(80,60,30,.25)`).

## Type
- Headlines: reading serif (`Iowan Old Style, Charter, Georgia, Songti SC`), 600. Page title 30px, post title 17.5px, follow-up title 15.5px.
- Body and UI: system sans. Context 14.5px soft, clamped to 2 lines. Meta 12.5px faint. Actions 13.5px.
- Masthead (editorial, like Apple News): date as a small-caps eyebrow (11.5px, tracked), serif title, then one plain serif-italic sentence ("Ten things for you, the next due tomorrow."), not counters.

## Spacing
Page padding 12–20px. Card radius 18px, padding 14px. 10px between cards. Touch targets ≥40px. Avatar 40px; text column starts at 51px.

## Avatars and sources
- **The avatar is the person who needs brook** (loop field `who`: name, source app, id). Real photo from `plugins/core/avatarkit.ts` (WeChat head image, Feishu profile photo; cached in `~/.pix/avatars`, never committed), else initials (first Latin letter, or the last Han character) on a soft colour hashed from the name: `#b5694a #8a7a3d #5f8a6a #4f7a8f #8a5f86 #a0605f #6b6fa3 #9a7b4f`.
- **Pi's own work** (no `who`) uses the π mark: ink circle, serif italic π.
- **The source app appears once**, as a 16px badge on the avatar corner, plus "via Feishu" in faint text. Never the main icon.

## Feed structure
- **One loop = one top-level post**, side by side like tweets. Loops in the same line are not a conversation: never nest them.
- A line is a filter chip and a faint tag in the meta row.
- Only a loop's own history nests under it (its comment thread).

## Icons
Line SVG, 1.8 stroke, round caps, `currentColor`, 16–20px. App icons only as source badges.

## Posts, comments, actions
- **Post**: meta row (person · via app · line · age · due chip), serif headline, 2 lines of context.
- **Comment**: only the latest one, as a reply line: 2px rule on the left, "Pi · 1h ago" (or "You") in faint 12px above, text in soft, clamped to 2 lines. No box, no badge.
- **Actions**: plain text, not boxed buttons, separated by faint "·". At most one main action in ink, semibold, one secondary (Done/Later) in soft, and "Ask Pi" with a speech-bubble icon at the right in faint. It opens an inline reply field.
