// One-off: give open loops made before `who` a person (from the title or a known name). Appends to inbox.jsonl.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isOpen, parseInbox, paths } from "../plugins/foryou/proactive.ts";
import { guessWho } from "../plugins/foryou/who.ts";

const P = paths();
const people = [...new Set([...(existsSync(join(P.dir, "memory/people")) ? readdirSync(join(P.dir, "memory/people")).map(f => f.replace(/\.md$/, "")) : []),
	"Lowes", "Tony", "Olivia", "恩浩", "欧阳", "易健", "陈老师", "王翼", "沈琦"])].sort((a, b) => b.length - a.length);
const dry = process.argv.includes("--dry");
for (const it of parseInbox(readFileSync(P.inbox, "utf8")).filter(i => isOpen(i) && !i.who)) {
	const who = guessWho(it as any, people);
	console.log(`${it.id} ${who ? `${who.name} (${who.source}${who.id ? " " + who.id : ""})` : "— Pi"} · ${it.title}`);
	if (who && !dry) appendFileSync(P.inbox, JSON.stringify({ id: it.id, who }) + "\n");
}
