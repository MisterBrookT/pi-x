# AccountKit

Claude account inventory and bounded request rotation, independent of Pi and its UI. Pix supplies credential and HTTP adapters; Kaji reads the same routing files.

Requires Node 24. Run independently from this directory:

```sh
node cli.ts list
node --test
```

`list` prints account metadata, not credentials. Import `index.ts` to use `plan()` and `attemptAccounts()`. Each planned account is tried at most once per pass. Quota and 401 can advance to the next account. The exact `oauth_not_allowed_for_organization` 403 can also advance for OAuth requests, but is not classified as quota. Other permission errors stop. An explicit global pin stays pinned.

State remains in `~/.pix` for compatibility with Kaji: account inventory, route, usage and session routing. `PIX_HOME` overrides that directory. `accounts-health.json` keeps the last status, classification and request ID per account, never tokens or response bodies. `onSuccess` lets the caller remember the working account. Share an `unavailable` set across transport retries to avoid replaying a denied organization within the same request.

Pix's `plugins/pix-anthropic/accountkit.ts` is a compatibility export. This package has no Pix imports or dependencies. `inventory()` includes every configured provider; `accounts()` deliberately remains Claude-only compatibility. Codex request rotation is not implemented here.

## Reversible account availability

```sh
node cli.ts disable minarabench oauth_org_denied
node cli.ts disable own oauth_org_denied
node cli.ts list
# Only after organization access is restored:
node cli.ts enable minarabench
node cli.ts enable own
```

Disabling adds `disabled: true`, `disabledReason` (a short machine-readable code), and `disabledAt` (epoch milliseconds) to the matching account in `~/.pix/accounts.json`. With no inventory file, the existing default Claude accounts are materialized first. No schema version or credential migration is needed. `enable` removes only those three fields. Malformed JSON, invalid inventory shapes, ambiguous IDs and unknown IDs are rejected without changing the file.

AccountKit excludes disabled Claude accounts from auto selection, preserved global/session pins, active-account labels and even stale supplied request orders. Inventory still lists them. Global and session pins, band settings, model order, credentials, usage history and last-response health remain unchanged. A disabled global pin stays persisted but cannot route; clear it explicitly with the existing Auto control if another account should be used instead. Re-enabling restores its eligibility without signing in again. A currently in-flight HTTP request is not aborted.

Pix shows `Unavailable, organization denied` instead of a stale usage percentage or `Signed out`; unavailable accounts cannot be selected. The relay's existing accounts GET and session account POST routes remain allowlisted, with the same server-side ready check. Kaji reads the same inventory, overrides stale quota snapshots, hides Use, and skips quota API calls for disabled accounts. Disabled Claude status appears in the Mac footer only for the Claude provider, not GPT. Generic metadata visibility does not add Codex transport routing or disable native Pi Codex authentication.

### Migration and rollback

1. Back up the existing inventory privately, or note that it was absent. Keep credentials where they are.
2. Run `disable` for the denied account IDs. No Pi session, job, history or draft migration is involved.
3. Roll out the AccountKit/Pix/Kaji consumers together through their normal safe deployment path. **Writing metadata alone does not upgrade already-loaded code or the deployed phone Worker.** Do not claim that a held UI rollout is live.
4. Roll back availability with `enable <id>`. This retains newly added accounts and unrelated settings. If the inventory was initially absent, leaving the explicit default entries is semantically equivalent; do not delete credentials or blindly overwrite newer configuration with a backup.

## Official DeepSeek metadata audit

`scripts/deepseek-official-models.mjs` is a pure migration planner, not a key importer. It replaces the previously configured `deepseek-chat` / `deepseek-reasoner` entries with the currently documented `deepseek-flash` / `deepseek-v4-pro`, while preserving the key command, other providers, GPT defaults and other enabled-model order.

Verified against [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) and [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) on 2026-10-29:

| Official ID | Version | Thinking | Images | Peak input / cached input / output per 1M tokens |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | V4.1 Flash 1017 | yes | yes | $0.30 / $0.006 / $1.20 |
| `deepseek-v4-pro` | V4 Pro 0813 | yes | no | $1.32 / $0.044 / $3.96 |

Both document a 1M context window and maximum output of 384K (393216). The configuration uses a conservative 1,000,000-token context because the pricing page does not state the exact context integer. Thinking accepts `none`, `low`, `high`, `max`; compatibility aliases map `minimal` to `low`, and `medium` / `xhigh` to `high`. Both also support non-thinking mode. Static Pi costs use peak estimates; off-peak rates are half, so these are not exact receipts. No separate cache-write surcharge is documented. The existing official account returned HTTP 402; native catalog validation is not proof of funded inference or a successful official tool round trip.
