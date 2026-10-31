#!/usr/bin/env node
// Metadata only. AccountKit never prints or stores bearer tokens, and never runs security or claude: it prints the commands for brook.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import crypto from "node:crypto";
import { inventory, choice, outcomes, ready, sessionAccount, usage, type Account } from "./index.ts";

const USAGE = "Usage: accountkit list [session-id] | add <id> [--label <label>] | remove <id> | disable <id> | enable <id>\n";
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const pix = () => process.env.PIX_HOME ?? join(homedir(), ".pix");
// Mutations read strictly: a missing file is the default, a malformed one stops everything before any write (filename only, never contents).
const read = <T>(f: string, d: T): T => {
  const p = join(pix(), f);
  if (!existsSync(p)) return d;
  try { const v = JSON.parse(readFileSync(p, "utf8")); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* below */ }
  return fail(`${f} is not valid JSON; fix or move it, nothing was changed`);
};
const put = (f: string, content: string) => {
  mkdirSync(pix(), { recursive: true });
  const p = join(pix(), f), tmp = `${p}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(tmp, content, { mode: 0o600, flag: "wx" }); renameSync(tmp, p); }
  finally { try { unlinkSync(tmp); } catch { /* renamed */ } }
};
const write = (f: string, v: unknown) => put(f, JSON.stringify(v, null, 2));
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const fail = (msg: string): never => { process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n"); process.exit(2); };

// Rewrite accounts.json keeping its other fields; an absent file starts from the built-in defaults.
type Entry = Account & Record<string, unknown>;
function loadAccounts(): { file: Record<string, unknown>; list: Entry[] } {
  const file = read<Record<string, unknown> & { accounts?: unknown }>("accounts.json", {});
  if (file.accounts !== undefined && (!Array.isArray(file.accounts) || file.accounts.some(a => !a || typeof (a as Account).id !== "string"))) fail("accounts.json has a malformed accounts list; nothing was changed");
  return { file, list: (file.accounts ?? inventory()) as Entry[] };
}
const saveAccounts = (file: Record<string, unknown>, list: Entry[]) => write("accounts.json", { ...file, accounts: list });

const [command = "list", ...rest] = process.argv.slice(2);
const needId = (): string => { const id = rest[0]; if (!id || !ID.test(id)) fail(`Invalid account id ${JSON.stringify(id ?? "")}\n${USAGE}`); return id!; };
const known = (list: Entry[], id: string) => list.find(a => a.id === id) ?? fail(`No account ${id}`);

if (command === "list") {
  if (rest.length > 1) fail(USAGE);
  const session = rest[0], readings = usage();
  console.log(JSON.stringify({ route: choice(), ...(session ? { session: sessionAccount(session) } : {}), accounts: inventory().map(a => ({ id: a.id, label: a.label, provider: a.provider ?? "claude", ready: ready(a), ...((a as { disabled?: boolean }).disabled ? { disabled: true } : {}), credentialSource: a.configDir ? "profile" : "default", usage: readings[a.id] ?? {}, lastResponse: outcomes()[a.id] })) }, null, 2));
} else if (command === "add") {
  const id = needId();
  let label = id;
  for (let i = 1; i < rest.length; i++) {
    if (rest[i] === "--label" && rest[i + 1] !== undefined && rest[i + 1] !== "") label = rest[++i];
    else fail(`Bad option ${JSON.stringify(rest[i])}\n${USAGE}`);
  }
  const { file, list } = loadAccounts();
  if (list.some(a => a.id === id)) fail(`Account ${id} exists`);
  const configDir = join(homedir(), `.claude-${id}`);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  saveAccounts(file, [...list, { id, label, configDir }]);
  console.log(`Added ${id}. Log in with:\n  CLAUDE_CONFIG_DIR=${quote(configDir)} claude`);
} else if (command === "remove") {
  if (rest.length !== 1) fail(USAGE);
  const id = needId();
  // Read and validate everything first so a bad file leaves all state untouched.
  const { file, list } = loadAccounts(), account = known(list, id);
  const u = read<Record<string, unknown> & { _active?: { id?: string } }>("accounts-usage.json", {});
  const h = read<Record<string, unknown>>("accounts-health.json", {});
  const sessions = read<Record<string, { pin?: string; active?: string }>>("session-accounts.json", {});
  const route = (() => { try { return readFileSync(join(pix(), "claude-route"), "utf8").trim(); } catch { return ""; } })();
  saveAccounts(file, list.filter(a => a.id !== id));
  delete u[id]; if (u._active?.id === id) delete u._active;
  write("accounts-usage.json", u);
  delete h[id]; write("accounts-health.json", h);
  for (const [s, v] of Object.entries(sessions)) {
    if (!v || typeof v !== "object") continue;
    if (v.pin !== id && v.active !== id) continue;
    if (v.pin === id) delete v.pin;
    if (v.active === id) delete v.active;
    // Drop records that only routed to this account; keep any other metadata.
    if (Object.keys(v).every(k => k === "at")) delete sessions[s];
  }
  write("session-accounts.json", sessions);
  if (route === id) put("claude-route", "auto\n");
  console.log(`Removed ${id}. Its profile was kept.`);
  if ((account.provider ?? "claude") === "claude") {
    // Claude Code's keychain item: plain for the default profile, suffixed by a hash of the resolved config dir otherwise.
    const dir = account.configDir ? resolve(account.configDir) : undefined;
    const service = dir ? `Claude Code-credentials-${crypto.createHash("sha256").update(dir).digest("hex").slice(0, 8)}` : "Claude Code-credentials";
    console.log(`To also forget its keychain login, run:\n  security delete-generic-password -s ${quote(service)}${dir ? `\nThen delete the profile yourself if you want: ${quote(dir)}` : ""}`);
  }
} else if (command === "disable" || command === "enable") {
  if (rest.length !== 1) fail(USAGE);
  const id = needId(), { file, list } = loadAccounts(); known(list, id);
  saveAccounts(file, list.map(a => { if (a.id !== id) return a; const { disabled: _, ...keep } = a; return command === "disable" ? { ...keep, disabled: true } : keep; }));
  console.log(`${command === "disable" ? "Disabled" : "Enabled"} ${id}.`);
} else fail(USAGE);
