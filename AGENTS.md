# AGENTS.md

## Testing

- Every behavior-changing feature must include automated tests for its user-visible contract.
- Every bug fix must include a regression test that fails before the fix and passes afterward.
- Choose the smallest reliable test level: unit tests for rules and edge cases, integration tests for component boundaries, and end-to-end tests for critical user journeys or runtime compatibility risks.
- When extending Pi APIs or TUI behavior, test against the real public interface shape rather than permissive mocks that hide compatibility failures.
- Run the relevant focused tests while developing and the repository's full check before delivery. If a test is impractical, state what is untested and why.
- Keep tests deterministic, readable, and focused on behavior rather than implementation details.

## Delivery

- Every user-visible change must reach the iPhone too. When a feature changes what brook sees or can do on the Mac (cards, buttons, lists, states), make the phone page show and do the same, allow the route through the relay (`relayAllowed`), and test it in the phone browser test. A change is not delivered until it works on the phone through https://rc.brooktang.fun.

- Every phone-page change must work in all three layouts brook uses: iPhone (narrow, about 402px), iPad (about 1180px, touch, maybe a hardware keyboard), and iPad with an external monitor (1920px and wider). Watch CSS inside `@media(min-width:761px)`: it never reaches the iPhone. Check each layout yourself (a screenshot of each), and give tests that depend on layout one case per layout.

- The phone page is served by the relay Worker (`relay/`), not the Mac, so the Mac's autoreload never updates it. A post-commit hook (`scripts/git-hooks/post-commit`, enabled by `npm install` via `core.hooksPath`) deploys the relay whenever a commit touches `relay/` or `src/remote-{web,relay-web,sw}.ts`. Deploy by hand with `npm run deploy:relay`; skip once with `PIX_SKIP_RELAY_DEPLOY=1`.

## Reload

- Don't ask brook before reloading. Commit the fix and let `remote-autoreload` pick it up: each session reloads by itself once plugin files have been stable for 2 min and it is idle with no jobs or questions. Then confirm the pickup, and run `npm run deploy:relay` for phone changes.

## Design

- Follow `docs/design.md` (palette, type, avatars, actions) for every UI change on phone and Mac.

## Phone UI dev loop

- `npm run sim` (or `scripts/sim`) opens the phone page in the iPhone 17 Pro Simulator against the live Mac hub; edits under `plugins/remote/` reload it on their own. `scripts/sim stop` ends the dev server.
- Verify phone UI changes yourself before showing brook: `scripts/sim shot [file]` saves a Simulator screenshot (default `.shots/sim.png`); read it.
