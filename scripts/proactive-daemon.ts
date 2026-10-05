#!/usr/bin/env node
// Proactive daemon: receive (any source adapter) -> judge (pi -p) -> notify (macOS) -> inbox for /proactive.
// Usage: node scripts/proactive-daemon.ts [--once] [--dry-run]
//        node scripts/proactive-daemon.ts act <id>      mark done, start a Pi session on the next step
//        node scripts/proactive-daemon.ts dismiss <id>  mark dismissed
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { applyMemory, defaultConfig, judgePrompt, newSince, parseInbox, parseVerdict, paths, sourceKey, underLimit, type Config, type Item } from "../src/proactive.ts";
import { adapterFor } from "../src/proactive-sources.ts";
import { actItem, dismissItem } from "../src/proactive-store.ts";

const run = promisify(execFile);
const P = paths();
const once = process.argv.includes("--once");
const dry = process.argv.includes("--dry-run");
const pixAnthropic = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "pix-anthropic", "index.ts");
const log = (s: string) => { const line = `[${new Date().toISOString()}] ${s}\n`; process.stdout.write(line); try { appendFileSync(P.log, line); } catch { /* */ } };
const readJson = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };

function setup(): Config {
	mkdirSync(P.dir, { recursive: true });
	if (!existsSync(P.config)) writeFileSync(P.config, JSON.stringify(defaultConfig, null, 2));
	if (!existsSync(P.memory)) writeFileSync(P.memory, "# Proactive memory\n\nWhat I care about, open promises, project state. Edit freely.\n");
	return { ...defaultConfig, ...readJson(P.config, {}) };
}

async function judge(prompt: string, model: string): Promise<string> {
	const child = execFile("pi", ["-p", "--no-session", "-nt", "-ne", "-e", pixAnthropic, "--model", model, "--thinking", "off"], { maxBuffer: 1 << 22, timeout: 120_000 });
	child.stdin?.end(prompt);
	let out = ""; child.stdout?.on("data", d => (out += d));
	await new Promise<void>((ok, bad) => child.on("close", c => (c === 0 ? ok() : bad(new Error(`pi exited ${c}`)))));
	return out;
}

async function notify(it: Item) {
	const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	await run("osascript", ["-e", `display notification "${esc(it.why)}" with title "pix: ${esc(it.title)}" subtitle "${esc(it.source)} · /proactive in pi" sound name "Glass"`]);
}

async function tick(cfg: Config) {
	const state = readJson<Record<string, string>>(P.state, {});
	for (const src of cfg.sources) {
		try {
			const adapter = adapterFor(src);
			const msgs = await adapter.fetch(src);
			const key = sourceKey(src);
			const fresh = newSince(msgs, state[key]).filter(m => m.sender.trim() !== cfg.me);
			const last = msgs.at(-1)?.id;
			if (!state[key]) { // first run: set cursor, don't flood
				if (last) state[key] = last;
				log(`${src.name}: cursor set (${msgs.length} msgs)`); continue;
			}
			if (last) state[key] = last;
			if (!fresh.length) continue;
			const items = parseInbox(existsSync(P.inbox) ? readFileSync(P.inbox, "utf8") : "");
			const pending = items.filter(i => i.status === "pending").slice(-10);
			const feedback = items.filter(i => i.status !== "pending").slice(-10);
			const memory = existsSync(P.memory) ? readFileSync(P.memory, "utf8") : "";
			const ctx = msgs.slice(0, msgs.length - fresh.length).slice(-15);
			const raw = await judge(judgePrompt({ me: cfg.me, memory, source: src, context: ctx, fresh, pending, feedback, now: new Date().toString() }), cfg.model);
			const v = parseVerdict(raw);
			if (v && (v.memory.add.length || v.memory.remove.length) && !dry) {
				const r = applyMemory(memory, v.memory);
				if (r.added.length || r.removed.length) {
					writeFileSync(P.memory, r.text);
					const stamp = new Date().toISOString();
					appendFileSync(P.memoryLog, [...r.added.map(l => `${stamp} + ${l}`), ...r.removed.map(l => `${stamp} - ${l}`)].join("\n") + "\n");
					log(`memory: +${r.added.length} -${r.removed.length}`);
				}
			}
			log(`${src.name}: ${fresh.length} new -> ${v ? (v.notify ? `NOTIFY ${v.title}` : "quiet") : `bad verdict: ${raw.slice(0, 120)}`}`);
			if (!v?.notify) continue;
			if (!underLimit(items, cfg.maxPerHour)) { log("rate limited"); continue; }
			const it: Item = { ...v, id: randomUUID().slice(0, 8), at: new Date().toISOString(), source: src.name, sourceKey: key, project: src.project, howToRead: adapter.howToRead(src, v.refs), status: "pending" };
			if (!dry) { appendFileSync(P.inbox, JSON.stringify(it) + "\n"); await notify(it); }
		} catch (e) { log(`${src.name}: error ${(e as Error).message}`); }
	}
	if (!dry) writeFileSync(P.state, JSON.stringify(state, null, 2));
}

const [verb, itemId] = process.argv.slice(2);
if (verb === "act" || verb === "dismiss") {
	const ok = verb === "act" ? !!(await actItem(itemId)) : dismissItem(itemId);
	if (!ok) { console.error(`no pending alert ${itemId}`); process.exit(1); }
	process.exit(0);
}

const cfg = setup();
if (!cfg.sources.length) { log(`no sources; edit ${P.config}`); process.exit(once ? 0 : 1); }
do {
	await tick(cfg);
	if (once) break;
	await new Promise(r => setTimeout(r, cfg.intervalSec * 1000));
} while (true);
