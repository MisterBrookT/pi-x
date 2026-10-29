# AccountKit

Claude account inventory and bounded request rotation, independent of Pi and its UI. Pix supplies credential and HTTP adapters; Kaji reads the same routing files.

Requires Node 24. Run independently from this directory:

```sh
node cli.ts list
node --test
```

`list` prints account metadata, not credentials. Import `index.ts` to use `plan()` and `attemptAccounts()`. Each planned account is tried at most once per pass. Quota and 401 can advance to the next account. The exact `oauth_not_allowed_for_organization` 403 can also advance for OAuth requests, but is not classified as quota. Other permission errors stop. An explicit global pin stays pinned.

State remains in `~/.pix` for compatibility with Kaji: account inventory, route, usage and session routing. `PIX_HOME` overrides that directory. `accounts-health.json` keeps the last status, classification and request ID per account, never tokens or response bodies. `onSuccess` lets the caller remember the working account. Share an `unavailable` set across transport retries to avoid replaying a denied organization within the same request.

Pix's `plugins/pix-anthropic/accountkit.ts` is a compatibility export. This package has no Pix imports or dependencies. Codex account rotation is not implemented here yet.
