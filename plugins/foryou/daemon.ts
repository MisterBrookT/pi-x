#!/usr/bin/env node
// Proactive daemon: receive (any source adapter) -> judge (one model call) -> the one list.
// Views (Mac pill, Pix Remote "For you") read the list; this process never shows UI itself.
// Usage: node plugins/foryou/daemon.ts [--once] [--dry-run]
//        node plugins/foryou/daemon.ts act <id>      mark "on it", start a Pi session on the next step
//        node plugins/foryou/daemon.ts later <id>    hide until near its due date (or tomorrow)
//        node plugins/foryou/daemon.ts note <id> "<progress>"  add a line to the loop's brief
//        node plugins/foryou/daemon.ts next <id> "<button>" "<next step>" ["<what is done>"]  step done; next one is brook's
//        node plugins/foryou/daemon.ts finished <id> "<what was done>"  whole loop done; brook checks and closes it
//        node plugins/foryou/daemon.ts done <id>     brook handled it himself
//        node plugins/foryou/daemon.ts now <id>      bring a parked loop back now
//        node plugins/foryou/daemon.ts open <id>     show the session that is on it
//        node plugins/foryou/daemon.ts dismiss <id>  drop for good
//        node plugins/foryou/daemon.ts list          print open loops (id, status, title) and exit
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteDefaultPort, remoteTokenPath } from "../core/hub-paths.ts";
import { preparePrompt, applyMemory, defaultConfig, isOpen, judgePrompt, parseInbox, parsePile, pilePrompt, pruneLog, staleOnit, trackHealth, healthSummary, silentSources, sourceKind, type Problem, planBatch, parseVerdict, paths, sourceKey, underLimit, updateLine, wakeTime, type Config, type Item, type WorkSession } from "./proactive.ts";
import { applyCardEdits, listCards, logCardChanges, memoryAll, memoryDir, memoryForPrompt, migrateMemory, tidyPrompt, writeCard } from "./proactive-memory.ts";
import { applyLineEdits, linesForPrompt, readLines, writeLines } from "./proactive-lines.ts";
import { ensureUnlocked } from "./unlock.ts";
import { readStatus, statusBoard } from "./session-status.ts";
import { clearQueue, heldPrompt, holdBatch, readQueue, threadActive, brookActiveAt, urgentLine } from "../core/foryou-queue.ts";
import { filterPrompt, forwardPrompt, mustPass, parseFilter, reviewPrompt, type Forward } from "./forward.ts";
import { adapterFor, dingNewest, expandSources } from "./proactive-sources.ts";
import { probeApp } from "./access.ts";
import { checkGmailAuth, gmailProblem } from "./gmail-health.ts";
import { whoFor } from "./who.ts";
import { actItem, finishedItem, startForYou, suggestItem, readOpen, dismissItem, doneItem, laterItem, nextItem, noteItem, nowItem, openItem } from "./proactive-store.ts";

const P = paths();
const once = process.argv.includes("--once");
const dry = process.argv.includes("--dry-run");
const pixAnthropic = join(dirname(fileURLToPath(import.meta.url)), "..", "pix-anthropic", "index.ts");
/** A repeating error is logged when it starts and when it changes, not every round. */
const lastErr = new Map<string, string>();
/** Apps whose data was blocked last round (lost Full Disk Access); rechecked every 30 s until readable. */
// Gmail login: refreshed at most hourly (also keeps the token warm); a failure is one stable health entry.
let gmail = { at: 0, state: "ok" as Awaited<ReturnType<typeof checkGmailAuth>>, since: "" };
const blockedApps = new Set<"wechat" | "dingtalk">();
const accessBack = async () => { for (const a of blockedApps) if (await probeApp(a) !== "ok") return false; return true; };
const logOnce = (s: string) => { const k = s.split(":")[0]; if (lastErr.get(k) === s) return false; lastErr.set(k, s); return true; };
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
	// Forward mode: For you itself reviews its cards every hour, with its full context (activity, board, sessions).
	if (cfg.mode === "forward") {
		if (now - Date.parse(state["@review"] ?? "0") > 3_600_000 && !(await forYouThreadActive())) {
			const open = parseInbox(existsSync(P.inbox) ? readFileSync(P.inbox, "utf8") : "").filter(isOpen);
			if (open.length) {
				const text = reviewPrompt({ open, since: state["@review"], board: statusBoard(readStatus()) });
				const ok = await hubPrepare(text) || await startForYou(text).then(() => true, () => false);
				log(`review: ${open.length} open -> ${ok ? "For you" : "For you not open; next hour"}`);
			}
			state["@review"] = new Date(now).toISOString();
		}
		return;
	}
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
	const forwards: Forward[] = [];
	const pendingMarks: (() => void)[] = [];
	try {
		if (!dry && cfg.sources.some(x => /wechat|dingtalk/i.test(x.kind))) { const u = await ensureUnlocked(); if (u !== "open") log(`mac: ${u}`); }
		sources = await expandSources(cfg.sources, {
			onSuccess: src => fine.push(src.name),
			onError: (src, e) => { failed.push({ source: src.name, error: e.message }); if (logOnce(`${src.name}: ${e.message}`)) log(`${src.name}: expand error ${e.message}`); judged({ kind: "error", source: src.name, sourceKey: sourceKey(src), error: e.message.slice(0, 2000) }); },
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
			// New flow: the cheap model only filters; what passes goes to For you, which decides.
			if (cfg.mode === "forward") {
				const memory = existsSync(memoryDir(P.dir)) ? memoryForPrompt(P.dir, { msgs: [...ctx, ...fresh], source: src }) : existsSync(P.memory) ? readFileSync(P.memory, "utf8") : "";
				const prompt = filterPrompt({ me: String(src.me ?? cfg.me), source: src, context: ctx, fresh, memory, lines: linesForPrompt(readLines(P.dir)) });
				let raw = "";
				// Meeting notes brook attended always go to For you: the summary and 待办 are his to sort, not the cheap filter's.
				const forced = fresh.filter(m => mustPass(m, (cfg as { passList?: string[] }).passList));
				if (forced.length) raw = JSON.stringify({ pass: true, why: `pass list: ${forced.map(m => m.sender).slice(0, 3).join(", ")}`, ids: forced.map(m => m.id) });
				else if (src.kind === "feishu-meeting") raw = JSON.stringify({ pass: true, why: "meeting notes: summary and 待办", ids: fresh.map(m => m.id) });
				else try { raw = await ask(prompt, cfg.model); } catch (e) { failed.push({ source: "model", error: (e as Error).message }); judged({ kind: "filter", source: src.name, sourceKey: key, error: (e as Error).message.slice(0, 2000) }); continue; }
				fine.push("model");
				const v = parseFilter(raw);
				judged({ kind: "filter", source: src.name, sourceKey: key, fresh: fresh.map(m => ({ id: m.id, sender: m.sender })), raw, verdict: v });
				if (!v) { log(`${src.name}: ${fresh.length} new -> bad filter reply: ${raw.slice(0, 120)}`); continue; }
				log(`${src.name}: ${fresh.length} new -> ${v.pass ? "PASS" : "drop"}: ${v.why}`);
				if (v.pass) forwards.push({ source: src, sourceKey: key, fresh, context: ctx, why: v.why, ids: v.ids, urgent: v.urgent, howToRead: adapter.howToRead(src, v.ids.length ? v.ids : fresh.map(m => m.id)) });
				else mark();
				if (v.pass) pendingMarks.push(mark);
				continue;
			}
			// All open loops from every source, so a reply here can move a loop and duplicates merge.
			const pending = items.filter(isOpen).slice(-20);
			const feedback = items.filter(i => !isOpen(i)).slice(-10);
			const cards = existsSync(memoryDir(P.dir));
			const memory = cards ? memoryForPrompt(P.dir, { msgs: [...ctx, ...fresh], source: src, extra: pending.map(p => p.title).join("\n") }) : existsSync(P.memory) ? readFileSync(P.memory, "utf8") : "";
			const prompt = judgePrompt({ lines: linesForPrompt(readLines(P.dir), pending), me: String(src.me ?? cfg.me), memory, source: src, context: ctx, fresh, pending, feedback, now: new Date().toString(), work, cards });
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
			if (v.lines.length) {
				const r = applyLineEdits(readLines(P.dir), v.lines);
				if (r.changed.length) { writeLines(r.lines, P.dir); log(`lines: ${r.changed.join(", ")}`); }
			}
			for (const id of close) appendFileSync(P.inbox, JSON.stringify({ id, status: "resolved", at_status: stamp }) + "\n");
			for (const u of update) appendFileSync(P.inbox, JSON.stringify(updateLine(pending.find(p => p.id === u.id)!, u, now)) + "\n");
			const listed = [...items];
			for (const { state, to, ...a } of v.alerts) {
				// Over the hourly limit an alert still enters the list, just without a push (quiet).
				// A new loop that is already parked (e.g. waiting on someone) is quiet and comes back later.
				const parked = state === "waiting" || state === "later";
				const it: Item = { ...a, ...(a.who ? { who: whoFor(a.who.name, String(src.name), key) } : {}), id: randomUUID().slice(0, 8), at: stamp, source: src.name, sourceKey: key, project: src.project ?? a.project, howToRead: adapter.howToRead(src, a.refs), status: parked ? state : "pending", ...(parked ? { wakeAt: wakeTime(a.due, now, state === "waiting" ? 3 : 7), quiet: true } : underLimit(listed, cfg.maxPerHour) ? {} : { quiet: true }) };
				listed.push(it);
				appendFileSync(P.inbox, JSON.stringify(it) + "\n");
				// The judge thinks a live session is already on this: offer a job card there (brook decides).
				const target = to ? work.find(w => w.id === to) : undefined;
				if (target && !parked) { suggestItem(it.id, { id: target.id, name: target.name }); log(`card: ${it.id} -> ${target.name}`); }
				// Proactive: For you prepares the next step now, so the card brings a draft, not only a notice.
				if (!parked) log(`prepare: ${it.id} ${(await hubPrepare(preparePrompt(it))) ? "queued in For you" : "For you not open; skipped"}`);
			}
		} catch (e) { failed.push({ source: src.name, error: (e as Error).message }); log(`${src.name}: error ${(e as Error).message}`); judged({ kind: "error", source: src.name, sourceKey: sourceKey(src), error: (e as Error).message.slice(0, 2000) }); }
	}
	// Everything that passed goes to For you as one message; cursors move only once it is delivered.
	// While brook is mid-thread with For you, batches wait in a queue (urgent ones still get one line);
	// once the thread goes quiet, everything held goes over as one message.
	const active = !dry && await forYouThreadActive();
	if (forwards.length && !dry) {
		const text = forwardPrompt(forwards);
		if (active) {
			holdBatch(text, P.dir);
			for (const m of pendingMarks) m();
			for (const f of forwards.filter(f => f.urgent)) await hubPrepare(urgentLine(f.source.name, f.why));
			log(`forward: ${forwards.map(f => f.source.name).join(", ")} -> held (brook is in a thread with For you)${forwards.some(f => f.urgent) ? "; urgent line sent" : ""}`);
		} else {
			const sent = await hubPrepare(text) || await startForYou(text).then(() => true, () => false);
			log(`forward: ${forwards.map(f => f.source.name).join(", ")} -> ${sent ? "For you" : "not delivered; retry next round"}`);
			if (sent) for (const m of pendingMarks) m();
		}
	}
	if (!dry && !active) {
		const held = readQueue(P.dir);
		if (held.length && await hubPrepare(heldPrompt(held))) { clearQueue(P.dir); log(`held: ${held.length} batches delivered`); }
	}
	// Sources that keep failing show at the top of For you (phone and Mac) until they work again.
	if (!dry) {
		const old = readJson<{ state?: Record<string, Problem> }>(P.health, {}).state ?? {};
		const next = trackHealth(old, failed.filter((f, i, a) => a.findIndex(x => x.source === f.source) === i), fine, new Date().toISOString());
		// Last good read per source kind; a kind silent for 6+ h is a problem even when failures look sporadic.
		const prev = readJson<{ seen?: Record<string, string> }>(P.health, {}).seen ?? {}, at = new Date().toISOString();
		const seen = { ...prev }; for (const n of fine) { const k = sourceKind(n); if (k) seen[k] = at; }
		const kinds = [...new Set(cfg.sources.map(s => sourceKind(s.name)).filter(Boolean))];
		for (const k of kinds) seen[k] ??= at;  // start the clock for a kind never seen
		// A read that works on a stale local DB is not "seen": DingTalk counts only up to its newest message.
		// Quiet nights are normal, so this uses 24 h, not the silence window.
		const dingStale = dingNewest.at && Date.now() - Date.parse(dingNewest.at) > 24 * 3_600_000 ? [{ text: `DingTalk: newest message is ${Math.round((Date.now() - Date.parse(dingNewest.at)) / 3_600_000)} h old (app closed or not syncing?)`, since: dingNewest.at }] : [];
		if (dingNewest.launched) { log("DingTalk was not running: started it (open -ga DingTalk)"); dingNewest.launched = false; }
		if (Date.now() - gmail.at > 3_600_000) { const st = await checkGmailAuth(); gmail = { at: Date.now(), state: st === "unknown" ? gmail.state : st, since: st === "ok" ? "" : gmail.since || at }; }
		const problems = [...healthSummary(next), ...silentSources(seen, kinds, Date.now(), Number(process.env.PIX_SILENT_HOURS ?? 6)), ...dingStale, ...gmailProblem(gmail.state, gmail.since)];
		blockedApps.clear();
		for (const f of failed) if (/lost Full Disk Access/.test(f.error)) blockedApps.add(f.source.startsWith("WeChat") ? "wechat" : "dingtalk");
		if (JSON.stringify(problems) !== JSON.stringify(readJson<{ problems?: unknown }>(P.health, {}).problems ?? [])) log(`health: ${problems.map(p => p.text).join("; ") || "all fine"}`);
		writeFileSync(P.health, JSON.stringify({ state: next, problems, seen }, null, 2));
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

/** brook is talking with For you (last 10 min), or For you is still busy / waiting on a handoff for him. */
async function forYouThreadActive(): Promise<boolean> {
	const userAt = brookActiveAt(P.dir);
	if (!userAt) return false;
	let busy = false, openWaits = 0;
	try {
		const token = readFileSync(remoteTokenPath, "utf8").trim();
		const res = await fetch(`http://127.0.0.1:${remoteDefaultPort}/api/sessions`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
		busy = !!((res.ok ? await res.json() as any[] : []).find(s => s.id === "pix-foryou")?.busy);
	} catch { /* */ }
	try { openWaits = (JSON.parse(readFileSync(join(homedir(), ".pi/agent/chat/for-you/waiting.json"), "utf8")).waits ?? []).filter((w: any) => w.live !== false).length; } catch { /* */ }
	return threadActive({ userAt, busy, openWaits });
}

async function hubPrepare(prompt: string): Promise<boolean> {
	try {
		const token = readFileSync(remoteTokenPath, "utf8").trim();
		const res = await fetch(`http://127.0.0.1:${remoteDefaultPort}/api/sessions/pix-foryou/prompt`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: prompt, mode: "followUp" }), signal: AbortSignal.timeout(5000) });
		return res.ok;
	} catch { return false; }
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
	// While WeChat/DingTalk is blocked, look again every 30 s (one cheap folder listing), so a fix in
	// System Settings takes effect within a minute, with no restart.
	const until = Date.now() + cfg.intervalSec * 1000;
	while (Date.now() < until) {
		await new Promise(r => setTimeout(r, Math.min(30_000, Math.max(0, until - Date.now()))));
		if (blockedApps.size && await accessBack()) { log(`access back: ${[...blockedApps].join(", ")}; checking now`); blockedApps.clear(); break; }
	}
} while (true);
