#!/usr/bin/env node
// Proactive daemon: receive (any source adapter) -> judge (one model call) -> the one list.
// Views (Mac pill, Pix Remote "For you") read the list; this process never shows UI itself.
// Usage: node scripts/proactive-daemon.ts [--once] [--dry-run]
//        node scripts/proactive-daemon.ts act <id>      mark done, start a Pi session on the next step
//        node scripts/proactive-daemon.ts dismiss <id>  mark dismissed
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteDefaultPort, remoteTokenPath } from "../src/remote-hub.ts";
import { applyMemory, defaultConfig, judgePrompt, newSince, parseInbox, parseVerdict, paths, sourceKey, underLimit, type Config, type Item } from "../src/proactive.ts";
import { adapterFor, expandSources } from "../src/proactive-sources.ts";
import { actItem, dismissItem } from "../src/proactive-store.ts";

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

/** One tool-less, sessionless model call through Pi, so any provider Pi is logged into works. */
async function ask(prompt: string, model: string): Promise<string> {
	const ext = model.startsWith("pix-anthropic/") ? ["-e", pixAnthropic] : [];
	const child = execFile("pi", ["-p", "--no-session", "-nt", "-ne", ...ext, "--model", model, "--thinking", "low"], { maxBuffer: 1 << 22, timeout: 120_000 });
	child.stdin?.end(prompt);
	let out = ""; child.stdout?.on("data", d => (out += d));
	await new Promise<void>((ok, bad) => child.on("close", c => (c === 0 ? ok() : bad(new Error(`pi exited ${c}`)))));
	return out;
}


async function tick(cfg: Config) {
	const state = readJson<Record<string, string>>(P.state, {});
	let sources = cfg.sources;
	try { sources = await expandSources(cfg.sources); } catch (e) { log(`expand sources: ${(e as Error).message}`); sources = cfg.sources.filter(s => !adapterFor(s).expand); }
	for (const src of sources) {
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
			const raw = await ask(judgePrompt({ me: cfg.me, memory, source: src, context: ctx, fresh, pending, feedback, now: new Date().toString() }), cfg.model);
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
			if (!v) { log(`${src.name}: ${fresh.length} new -> bad verdict: ${raw.slice(0, 120)}`); continue; }
			const open = new Set(pending.map(p => p.id));
			const close = v.close.filter(id => open.has(id));
			log(`${src.name}: ${fresh.length} new -> ${v.alerts.length ? v.alerts.map(a => `ALERT ${a.title}`).join("; ") : "nothing"}${close.length ? `, resolved ${close.join(",")}` : ""}`);
			if (dry) continue;
			const stamp = new Date().toISOString();
			for (const id of close) appendFileSync(P.inbox, JSON.stringify({ id, status: "resolved", at_status: stamp }) + "\n");
			const listed = [...items];
			for (const a of v.alerts) {
				// Over the hourly limit an alert still enters the list, just without a push (quiet).
				const it: Item = { ...a, id: randomUUID().slice(0, 8), at: stamp, source: src.name, sourceKey: key, project: src.project, howToRead: adapter.howToRead(src, a.refs), status: "pending", ...(underLimit(listed, cfg.maxPerHour) ? {} : { quiet: true }) };
				listed.push(it);
				appendFileSync(P.inbox, JSON.stringify(it) + "\n");
			}
		} catch (e) { log(`${src.name}: error ${(e as Error).message}`); }
	}
	if (!dry) writeFileSync(P.state, JSON.stringify(state, null, 2));
	log(`checked ${sources.length} sources`);
}

async function hubAct(id: string, focus: boolean): Promise<boolean | undefined> {
	try {
		const token = readFileSync(remoteTokenPath, "utf8").trim();
		const res = await fetch(`http://127.0.0.1:${remoteDefaultPort}/api/foryou/${encodeURIComponent(id)}/act`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ focus }), signal: AbortSignal.timeout(5000) });
		return res.status === 404 ? false : res.ok ? true : undefined;
	} catch { return undefined; }
}

const [verb, itemId] = process.argv.slice(2);
if (verb === "act" || verb === "dismiss") {
	const focus = process.argv.includes("--focus");
	// Prefer the hub: it can hand the task to a live For you session. Without a hub, act directly.
	const viaHub = verb === "act" ? await hubAct(itemId, focus) : undefined;
	const ok = viaHub ?? (verb === "act" ? !!(await actItem(itemId, { focus })) : dismissItem(itemId));
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
