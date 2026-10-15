#!/usr/bin/env node
// Proactive daemon: receive (any source adapter) -> judge (one model call) -> the one list.
// Views (Mac pill, Pix Remote "For you") read the list; this process never shows UI itself.
// Usage: node scripts/proactive-daemon.ts [--once] [--dry-run]
//        node scripts/proactive-daemon.ts act <id>      mark "on it", start a Pi session on the next step
//        node scripts/proactive-daemon.ts later <id>    hide until near its due date (or tomorrow)
//        node scripts/proactive-daemon.ts note <id> "<progress>"  add a line to the loop's brief
//        node scripts/proactive-daemon.ts next <id> "<button>" "<next step>" ["<what is done>"]  step done; next one is brook's
//        node scripts/proactive-daemon.ts finished <id> "<what was done>"  whole loop done; brook checks and closes it
//        node scripts/proactive-daemon.ts done <id>     brook handled it himself
//        node scripts/proactive-daemon.ts now <id>      bring a parked loop back now
//        node scripts/proactive-daemon.ts open <id>     show the session that is on it
//        node scripts/proactive-daemon.ts dismiss <id>  drop for good
//        node scripts/proactive-daemon.ts list          print open loops (id, status, title) and exit
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteDefaultPort, remoteTokenPath } from "../src/remote-hub.ts";
import { applyMemory, defaultConfig, isOpen, judgePrompt, parseInbox, parsePile, pilePrompt, pruneLog, staleOnit, trackHealth, healthSummary, type Problem, planBatch, parseVerdict, paths, sourceKey, underLimit, updateLine, wakeTime, type Config, type Item, type WorkSession } from "../src/proactive.ts";
import { applyCardEdits, listCards, logCardChanges, memoryAll, memoryDir, memoryForPrompt, migrateMemory, tidyPrompt, writeCard } from "../src/proactive-memory.ts";
import { adapterFor, expandSources } from "../src/proactive-sources.ts";
import { actItem, finishedItem, suggestItem, readOpen, dismissItem, doneItem, laterItem, nextItem, noteItem, nowItem, openItem } from "../src/proactive-store.ts";

const P = paths();
const once = process.argv.includes("--once");
const dry = process.argv.includes("--dry-run");
const pixAnthropic = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "pix-anthropic", "index.ts");
const log = (s: string) => { const line = `[${new Date().toISOString()}] ${s}\n`; process.stdout.write(line); try { appendFileSync(P.log, line); } catch { /* */ } };
const readJson = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };

function setup(): Config {
	mkdirSync(P.dir, { recursive: true });
	if (!existsSync(P.config)) writeFileSync(P.config, JSON.stringify(defaultConfig, null, 2));
	if (!existsSync(P.memory) && !existsSync(memoryDir(P.dir))) writeFileSync(P.memory, "# Proactive memory\n\nWhat I care about, open promises, project state. Edit freely.\n");
	if (migrateMemory(P.dir)) log("memory: moved memory.md into memory/ cards");
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

/** One line per judgment in judgments.jsonl: what the judge saw, what it said, what changed. For tuning. */
const judged = (entry: Record<string, unknown>) => { try { appendFileSync(P.judgments, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n"); } catch { /* */ } };

/** What brook is working on: open Pi sessions from the Remote hub (name, folder, current todo, last line). */
async function workSessions(): Promise<WorkSession[]> {
	try {
		const token = readFileSync(remoteTokenPath, "utf8").trim();
		const res = await fetch(`http://127.0.0.1:${remoteDefaultPort}/api/sessions`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
		const list = res.ok ? await res.json() as any[] : [];
		return list.filter(s => s.id !== "pix-foryou").slice(0, 12).map(s => ({ id: String(s.id), name: String(s.name ?? ""), cwd: String(s.cwd ?? ""), busy: !!s.busy, todo: s.todo ? String(s.todo).slice(0, 160) : undefined, preview: s.preview ? String(s.preview).slice(0, 160) : undefined }));
	} catch { return []; }
}

const DAY = 86_400_000;
/**
 * Once an hour: ask the judge which open loops are finished, stale, or duplicates, and close them.
 * Once a week: tidy long memory cards (merge duplicates, drop outdated lines). Both are logged.
 */
async function housekeeping(cfg: Config, state: Record<string, string>, work: WorkSession[]) {
	const now = Date.now();
	// Hourly: close finished loops and offer job cards for loops that match a session open now.
	if (now - Date.parse(state["@pile"] ?? "0") > 3_600_000) {
		const items = parseInbox(existsSync(P.inbox) ? readFileSync(P.inbox, "utf8") : "");
		const open = items.filter(isOpen);
		if (open.length) {
			try {
				const prompt = pilePrompt({ me: cfg.me, memory: existsSync(memoryDir(P.dir)) ? memoryAll(P.dir) : "", open, now: new Date().toString(), work });
				const raw = await ask(prompt, cfg.model);
				// A loop due today or later is never closed as stale (it closed "DataBento 测试" on its due day).
				const today = new Date().toLocaleDateString("sv");
				const v = parsePile(raw, new Set(open.map(i => i.id)), new Set(work.map(w => w.id)), new Set(open.filter(i => i.due && i.due >= today).map(i => i.id)));
				const stamp = new Date().toISOString();
				if (!dry) {
					for (const c of v.close) appendFileSync(P.inbox, JSON.stringify({ id: c.id, status: "resolved", at_status: stamp, closedWhy: c.why }) + "\n");
					for (const r of v.route) { const it = open.find(i => i.id === r.id)!; if (it.status === "pending" && !it.suggest) suggestItem(r.id, { id: r.to, name: work.find(w => w.id === r.to)?.name }); }
					for (const c of v.choices) appendFileSync(P.inbox, JSON.stringify({ id: c.id, choices: c.choices, at_status: stamp }) + "\n");
					for (const m of v.merge) appendFileSync(P.inbox, JSON.stringify({ id: m.drop, status: "resolved", at_status: stamp, closedWhy: `merged into ${m.keep}: ${m.why}` }) + "\n");
				}
				judged({ kind: "pile", open: open.map(i => ({ id: i.id, title: i.title, at: i.at, status: i.status })), work: work.map(w => w.id), raw, close: v.close, merge: v.merge, route: v.route, choices: v.choices });
				log(`pile: ${open.length} open -> closed ${v.close.length}, merged ${v.merge.length}, cards ${v.route.length}, buttons ${v.choices.length}`);
			} catch (e) { log(`pile: error ${(e as Error).message}`); judged({ kind: "error", source: "pile", error: (e as Error).message }); }
		}
		state["@pile"] = new Date(now).toISOString();
	}
	if (existsSync(memoryDir(P.dir)) && now - Date.parse(state["@tidy"] ?? "0") > 7 * DAY) {
		for (const c of listCards(P.dir).filter(c => c.text.split("\n").length > 15)) {
			try {
				const out = (await ask(tidyPrompt(c.name, c.text, new Date().toDateString()), cfg.model)).trim().replace(/^```\w*\n|\n```$/g, "");
				if (!out.startsWith("#") || out.length < 20) continue;
				if (!dry) { writeCard(P.dir, c.name, out); appendFileSync(P.memoryLog, `${new Date().toISOString()} ${c.name} tidied (${c.text.split("\n").length} -> ${out.split("\n").length} lines)\n`); }
				judged({ kind: "tidy", card: c.name, before: c.text, after: out });
			} catch (e) { log(`tidy ${c.name}: error ${(e as Error).message}`); judged({ kind: "error", source: `tidy ${c.name}`, error: (e as Error).message }); }
		}
		state["@tidy"] = new Date(now).toISOString();
	}
	// Weekly: the judgment log keeps the last 30 days.
	if (now - Date.parse(state["@prune"] ?? "0") > 7 * DAY) {
		if (existsSync(P.judgments) && !dry) { const before = readFileSync(P.judgments, "utf8"), after = pruneLog(before, now); if (after.length !== before.length) { writeFileSync(P.judgments, after); log(`judgments: pruned to last 30 days (${before.split("\n").length - 1} -> ${after.split("\n").length - 1} lines)`); } }
		state["@prune"] = new Date(now).toISOString();
	}
}

async function tick(cfg: Config) {
	const state = readJson<Record<string, string>>(P.state, {});
	const work = await workSessions();
	const failed: { source: string; error: string }[] = [], fine: string[] = [];
	let sources = cfg.sources;
	try {
		sources = await expandSources(cfg.sources, {
			onSuccess: src => fine.push(src.name),
			onError: (src, e) => { failed.push({ source: src.name, error: e.message }); log(`${src.name}: expand error ${e.message}`); judged({ kind: "error", source: src.name, sourceKey: sourceKey(src), error: e.message.slice(0, 2000) }); },
		});
	} catch (e) { log(`expand sources: ${(e as Error).message}`); judged({ kind: "error", source: "expand sources", error: (e as Error).message.slice(0, 2000) }); sources = cfg.sources.filter(s => !adapterFor(s).expand); }
	for (const src of sources) {
		try {
			const adapter = adapterFor(src);
			const msgs = await adapter.fetch(src);
			fine.push(src.name);
			const key = sourceKey(src);
			const last = msgs.at(-1)?.id;
			const mark = () => { if (last) { state[key] = last; state[`${key}@t`] = msgs.at(-1)!.time; } };
			if (!state[key]) { // first run: set cursor, don't flood
				mark();
				log(`${src.name}: cursor set (${msgs.length} msgs)`); continue;
			}
			const items = parseInbox(existsSync(P.inbox) ? readFileSync(P.inbox, "utf8") : "");
			const { fresh, context: ctx, judge } = planBatch(msgs, state[key], String(src.me ?? cfg.me), items.filter(i => isOpen(i) && i.sourceKey === key).length, state[`${key}@t`], src.chat === "private");
			// Advance the cursor only once the batch is judged; a failed model call retries next tick.
			if (!judge) { if (fresh.length) judged({ kind: "skip", source: src.name, sourceKey: key, me: String(src.me ?? cfg.me), fresh: fresh.map(m => ({ id: m.id, sender: m.sender })), why: "only his own messages and no open loop here" }); mark(); continue; }
			// All open loops from every source, so a reply here can move a loop and duplicates merge.
			const pending = items.filter(isOpen).slice(-20);
			const feedback = items.filter(i => !isOpen(i)).slice(-10);
			const cards = existsSync(memoryDir(P.dir));
			const memory = cards ? memoryForPrompt(P.dir, { msgs: [...ctx, ...fresh], source: src, extra: pending.map(p => p.title).join("\n") }) : existsSync(P.memory) ? readFileSync(P.memory, "utf8") : "";
			const prompt = judgePrompt({ me: String(src.me ?? cfg.me), memory, source: src, context: ctx, fresh, pending, feedback, now: new Date().toString(), work, cards });
			let raw = "";
			try { raw = await ask(prompt, cfg.model); } catch (e) { failed.push({ source: "model", error: (e as Error).message }); judged({ kind: "judge", source: src.name, sourceKey: key, me: String(src.me ?? cfg.me), fresh, context: ctx, prompt, error: (e as Error).message }); throw e; }
			fine.push("model");
			const v = parseVerdict(raw);
			const changes = v && cards && !dry ? applyCardEdits(P.dir, v.cards, { source: src.name }) : [];
			if (changes.length) { logCardChanges(P.memoryLog, changes); log(`memory: ${changes.map(c => `${c.card} +${c.added.length} -${c.removed.length}`).join(", ")}`); }
			if (v && !cards && (v.memory.add.length || v.memory.remove.length) && !dry) {
				const r = applyMemory(memory, v.memory);
				if (r.added.length || r.removed.length) {
					writeFileSync(P.memory, r.text);
					const stamp = new Date().toISOString();
					appendFileSync(P.memoryLog, [...r.added.map(l => `${stamp} + ${l}`), ...r.removed.map(l => `${stamp} - ${l}`)].join("\n") + "\n");
					log(`memory: +${r.added.length} -${r.removed.length}`);
				}
			}
			mark();
			judged({ kind: "judge", source: src.name, sourceKey: key, me: String(src.me ?? cfg.me), fresh, context: ctx, pending: pending.map(p => p.id), work: work.map(w => w.id), memoryChars: memory.length, prompt, raw, verdict: v, cardChanges: changes, dry });
			if (!v) { log(`${src.name}: ${fresh.length} new -> bad verdict: ${raw.slice(0, 120)}`); continue; }
			const open = new Set(pending.map(p => p.id));
			const close = v.close.filter(id => open.has(id));
			const update = v.update.filter(u => open.has(u.id) && !close.includes(u.id));
			log(`${src.name}: ${fresh.length} new -> ${v.alerts.length ? v.alerts.map(a => `ALERT ${a.title}`).join("; ") : "nothing"}${update.length ? `, updated ${update.map(u => `${u.id}${u.state ? `→${u.state}` : ""}`).join(",")}` : ""}${close.length ? `, resolved ${close.join(",")}` : ""}`);
			if (dry) continue;
			const now = Date.now(), stamp = new Date(now).toISOString();
			for (const id of close) appendFileSync(P.inbox, JSON.stringify({ id, status: "resolved", at_status: stamp }) + "\n");
			for (const u of update) appendFileSync(P.inbox, JSON.stringify(updateLine(pending.find(p => p.id === u.id)!, u, now)) + "\n");
			const listed = [...items];
			for (const { state, to, ...a } of v.alerts) {
				// Over the hourly limit an alert still enters the list, just without a push (quiet).
				// A new loop that is already parked (e.g. waiting on someone) is quiet and comes back later.
				const parked = state === "waiting" || state === "later";
				const it: Item = { ...a, id: randomUUID().slice(0, 8), at: stamp, source: src.name, sourceKey: key, project: src.project ?? a.project, howToRead: adapter.howToRead(src, a.refs), status: parked ? state : "pending", ...(parked ? { wakeAt: wakeTime(a.due, now, state === "waiting" ? 3 : 7), quiet: true } : underLimit(listed, cfg.maxPerHour) ? {} : { quiet: true }) };
				listed.push(it);
				appendFileSync(P.inbox, JSON.stringify(it) + "\n");
				// The judge thinks a live session is already on this: offer a job card there (brook decides).
				const target = to ? work.find(w => w.id === to) : undefined;
				if (target && !parked) { suggestItem(it.id, { id: target.id, name: target.name }); log(`card: ${it.id} -> ${target.name}`); }
			}
		} catch (e) { failed.push({ source: src.name, error: (e as Error).message }); log(`${src.name}: error ${(e as Error).message}`); judged({ kind: "error", source: src.name, sourceKey: sourceKey(src), error: (e as Error).message.slice(0, 2000) }); }
	}
	// Sources that keep failing show at the top of For you (phone and Mac) until they work again.
	if (!dry) {
		const old = readJson<{ state?: Record<string, Problem> }>(P.health, {}).state ?? {};
		const next = trackHealth(old, failed.filter((f, i, a) => a.findIndex(x => x.source === f.source) === i), fine, new Date().toISOString());
		const problems = healthSummary(next);
		if (JSON.stringify(problems) !== JSON.stringify(readJson<{ problems?: unknown }>(P.health, {}).problems ?? [])) log(`health: ${problems.map(p => p.text).join("; ") || "all fine"}`);
		writeFileSync(P.health, JSON.stringify({ state: next, problems }, null, 2));
	}
	// "On it" loops untouched for 6 h come back to brook: no loop sits silently in "Pi is on it".
	if (!dry) for (const it of staleOnit(parseInbox(existsSync(P.inbox) ? readFileSync(P.inbox, "utf8") : ""), Date.now())) {
		// Silent: it goes back to the list (not a pushed card). The pile check closes it if the work is done.
		appendFileSync(P.inbox, JSON.stringify({ id: it.id, status: "later", wakeAt: null, quiet: true, note: `${it.note ? `${it.note}\n` : ""}- ${new Date().toISOString().slice(0, 10)}: no progress for 6 h; parked` , at_status: new Date().toISOString() }) + "\n");
		judged({ kind: "stale", id: it.id, title: it.title, session: it.session });
		log(`stale: ${it.id} back to brook`);
	}
	await housekeeping(cfg, state, work);
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
if (verb === "note") {
	const ok = noteItem(itemId, process.argv.slice(4).join(" "));
	if (!ok) { console.error(`no loop ${itemId} (or empty note)`); process.exit(1); }
	process.exit(0);
}
if (verb === "next") {
	const [button = "", action = "", note] = process.argv.slice(4);
	if (!nextItem(itemId, { button, action, note })) { console.error(`no open loop ${itemId} (or empty button/step)`); process.exit(1); }
	process.exit(0);
}
if (verb === "finished") {
	if (!finishedItem(itemId, process.argv.slice(4).join(" "))) { console.error(`no open loop ${itemId} (or empty summary)`); process.exit(1); }
	process.exit(0);
}
if (verb === "done" || verb === "now") {
	if (!(verb === "done" ? doneItem : nowItem)(itemId)) { console.error(`no open loop ${itemId}`); process.exit(1); }
	process.exit(0);
}
if (verb === "open") {
	if (!(await openItem(itemId))) { console.error(`no session for loop ${itemId}`); process.exit(1); }
	process.exit(0);
}
if (verb === "act" || verb === "dismiss" || verb === "later") {
	const focus = process.argv.includes("--focus");
	// Prefer the hub: it can hand the task to a live For you session. Without a hub, act directly.
	const viaHub = verb === "act" ? await hubAct(itemId, focus) : undefined;
	const ok = viaHub ?? (verb === "act" ? !!(await actItem(itemId, { focus })) : verb === "later" ? laterItem(itemId) : dismissItem(itemId));
	if (!ok) { console.error(`no open loop ${itemId}`); process.exit(1); }
	process.exit(0);
}

if (verb === "list") {
	for (const i of readOpen()) console.log(`${i.id}\t${i.status}\t${i.source}\t${i.title}`);
	process.exit(0);
}
// Only a bare run (or flags) starts the daemon loop; a mistyped verb must not hang the caller forever.
if (verb && !verb.startsWith("--")) { console.error(`unknown command: ${verb} (see usage at the top of proactive-daemon.ts)`); process.exit(2); }

const cfg = setup();
if (!cfg.sources.length) { log(`no sources; edit ${P.config}`); process.exit(once ? 0 : 1); }
do {
	await tick(cfg);
	if (once) break;
	await new Promise(r => setTimeout(r, cfg.intervalSec * 1000));
} while (true);
