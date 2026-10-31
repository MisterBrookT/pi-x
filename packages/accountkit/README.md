# AccountKit

Claude account inventory and bounded request rotation, independent of Pi and its UI. Pix supplies credential and HTTP adapters; Kaji reads the same routing files.

Requires Node 24. Run independently from this directory:

```sh
node cli.ts add work --label "Work"
# Run the printed CLAUDE_CONFIG_DIR command yourself to log in.
node cli.ts list
node cli.ts disable work
node cli.ts enable work
node cli.ts remove work
node --test
```

`add` creates a separate Claude profile and prints its login command. `remove` prunes its routing metadata but keeps its profile and Keychain login; it prints the credential-deletion command for you to run yourself. No command runs Claude or deletes credentials. `list` prints account metadata, not credentials. Import `index.ts` to use `plan()` and `attemptAccounts()`. Each planned account is tried at most once per pass. Quota and 401 can advance to the next account. The exact `oauth_not_allowed_for_organization` 403 can also advance for OAuth requests, but is not classified as quota. Other permission errors stop. Disabled or unready profiles and accounts with an OAuth organization denial less than six hours old are excluded. A global pin stays pinned and fails closed if unavailable; it never silently selects another account. Stale session pins and active pointers to excluded accounts are removed when planning. Quota cooling and usage-band ordering are unchanged.

State remains in `~/.pix` for compatibility with Kaji: account inventory, route, usage and session routing. `PIX_HOME` overrides that directory. `accounts-health.json` keeps the last status, classification and request ID per account, never tokens or response bodies. `onSuccess` lets the caller remember the working account. Share an `unavailable` set across transport retries to avoid replaying a denied organization within the same request.

Pix resolves authentication and polls subscription usage from the first routable plan account, not an unrelated default login. Tokens with 120 seconds or less remaining are renewed through the existing bounded official Claude CLI flow. A per-account `claude-renew-<id>.lock` under `PIX_HOME` serializes renewal across processes, with a 60-second stale-lock threshold. Waiting callers reread credentials. CLI renewal can consume quota; this is not a new refresh-token implementation or a billing guarantee.

Pix's `plugins/pix-anthropic/accountkit.ts` is a compatibility export. This package has no Pix imports or dependencies. Codex account rotation is not implemented here yet.
