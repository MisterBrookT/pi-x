#!/usr/bin/env node
// Metadata only. AccountKit never prints or stores bearer tokens.
import { inventory, choice, outcomes, ready, sessionAccount, setDisabled, usage } from "./index.ts";
const [command = "list", argument, reason = "manual"] = process.argv.slice(2);
try {
  if (command === "disable" || command === "enable") {
    if (!argument) throw new Error("account id required");
    setDisabled(argument, command === "enable" ? false : reason);
    console.log(JSON.stringify({ id: argument, disabled: command === "disable" }));
  } else if (command === "list") {
    const readings = usage(), health = outcomes();
    console.log(JSON.stringify({ route: choice(), ...(argument ? { session: sessionAccount(argument) } : {}), accounts: inventory().map(a => ({ id: a.id, label: a.label, provider: a.provider ?? "claude", ready: ready(a), disabled: !!a.disabled, ...(a.disabledReason ? { disabledReason: a.disabledReason } : {}), credentialSource: a.configDir || a.dir ? "profile" : "default", usage: readings[a.id] ?? {}, lastResponse: health[a.id] })) }, null, 2));
  } else throw new Error("unknown command");
} catch (error) {
  process.stderr.write(`${(error as Error).message}\nUsage: accountkit list [session-id] | disable <id> [reason] | enable <id>\n`);
  process.exitCode = 2;
}
