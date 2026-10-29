#!/usr/bin/env node
// Metadata only. AccountKit never prints or stores bearer tokens.
import { inventory, choice, outcomes, ready, sessionAccount, usage } from "./index.ts";
const [command = "list", session] = process.argv.slice(2);
if (command !== "list") {
  process.stderr.write("Usage: accountkit list [session-id]\n");
  process.exitCode = 2;
} else {
  const readings = usage();
  console.log(JSON.stringify({ route: choice(), ...(session ? { session: sessionAccount(session) } : {}), accounts: inventory().map(a => ({ id: a.id, label: a.label, provider: a.provider ?? "claude", ready: ready(a), credentialSource: a.configDir ? "profile" : "default", usage: readings[a.id] ?? {}, lastResponse: outcomes()[a.id] })) }, null, 2));
}
