// MacKit: how is this Mac doing, what can be cleaned up safely, and what a reboot would cost.
// Node builtins only. Every system read goes through `run`, so tests feed recorded ps/vm_stat/pmset output.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type Run = (cmd: string, args: string[]) => string;
export const realRun: Run = (cmd, args) => {
	try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "ignore"] }); } catch (e: any) { return typeof e?.stdout === "string" ? e.stdout : ""; }
};

export interface Proc { pid: number; ppid: number; ageSec: number; rssKb: number; name: string; command: string }
export interface Tunnel { pid: number; ageSec: number; command: string; ports: number[]; inUse: boolean; stale: boolean }
export interface Blocker { pid: number; owner: string; kind: string; detail: string }
export interface Candidate { pid: number; reason: string; command: string }
export type Verdict = "fine" | "reboot soon" | "reboot now";
export interface Status {
	at: number; uptimeSec: number;
	memory: { pressure: "normal" | "warn" | "critical" | "unknown"; usedGb: number; totalGb: number };
	swap: { usedMb: number; totalMb: number; pct: number };
	top: { pid: number; name: string; rssMb: number }[];
	windowServerMb: number; pi: { count: number; rssMb: number };
	sleepDisabled: boolean; blockers: Blocker[]; caffeinate: { pid: number; owner: string; pix: boolean; ageSec: number }[];
	tunnels: Tunnel[];
	verdict: Verdict; reasons: string[];
}

const DAY = 86400;
export const STALE_SEC = 3 * DAY;

/** ps etime: [[dd-]hh:]mm:ss */
export function etimeSec(s: string): number {
	const [d, rest] = s.includes("-") ? s.split("-") : ["0", s];
	const p = rest.split(":").map(Number);
	while (p.length < 3) p.unshift(0);
	return Number(d) * DAY + p[0] * 3600 + p[1] * 60 + p[2];
}

/** `ps -axo pid=,ppid=,etime=,rss=,command=` */
export function parsePs(out: string): Proc[] {
	const procs: Proc[] = [];
	for (const line of out.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/);
		if (!m) continue;
		const command = m[5], exe = command.startsWith("/") ? command.split(/ --?\w/)[0] : command.split(" ")[0];
		procs.push({ pid: +m[1], ppid: +m[2], ageSec: etimeSec(m[3]), rssKb: +m[4], name: basename(exe), command });
	}
	return procs;
}

export function parseSwap(out: string) {
	const n = (k: string) => Number(out.match(new RegExp(`${k} = ([\\d.]+)M`))?.[1] ?? 0);
	const totalMb = n("total"), usedMb = n("used");
	return { usedMb: Math.round(usedMb), totalMb: Math.round(totalMb), pct: totalMb ? Math.round((usedMb / totalMb) * 100) : 0 };
}

/** Used = active + wired + compressed (Activity Monitor's "Memory Used", roughly). */
export function parseVmStat(out: string, totalBytes: number) {
	const page = Number(out.match(/page size of (\d+)/)?.[1] ?? 16384);
	const n = (k: string) => Number(out.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] ?? 0);
	const used = (n("Pages active") + n("Pages wired down") + n("Pages occupied by compressor")) * page;
	const gb = (b: number) => Math.round((b / 2 ** 30) * 10) / 10;
	return { usedGb: gb(used), totalGb: gb(totalBytes) };
}

/** MEM column for `pid` from `top -l 1 -stats pid,mem`: 5441M, 5G+, 800K. */
export function topMemMb(out: string, pid: number): number {
	const m = out.match(new RegExp(`^\\s*${pid}\\s+([\\d.]+)([KMG])`, "m"));
	return m ? Math.round(Number(m[1]) * ({ K: 1 / 1024, M: 1, G: 1024 } as const)[m[2] as "M"]) : 0;
}

export const pressureName = (level: string) => ({ "1": "normal", "2": "warn", "4": "critical" } as const)[level.trim() as "1"] ?? "unknown";

/** `pmset -g assertions`, "Listed by owning process" section. */
export function parseAssertions(out: string): Blocker[] {
	const list: Blocker[] = [];
	for (const m of out.matchAll(/pid (\d+)\(([^)]+)\): \[[^\]]+\] \S+ (\w+) named: "([^"]*)"/g)) {
		if (!/Prevent.*Sleep|UserIsActive/.test(m[3]) || m[2] === "powerd" && /lidopen|display is on|delayDisplayOff/.test(m[4]) || /iohideventsystem/.test(m[4])) continue;
		list.push({ pid: +m[1], owner: m[2], kind: m[3], detail: m[4].slice(0, 48) });
	}
	return list;
}

/** Listening TCP ports per pid from `lsof -nP -iTCP -sTCP:LISTEN`. */
export function parseListen(out: string): Map<number, number[]> {
	const map = new Map<number, number[]>();
	for (const line of out.split("\n")) {
		const m = line.match(/^\S+\s+(\d+)\s.*:(\d+) \(LISTEN\)/);
		if (m) map.set(+m[1], [...new Set([...(map.get(+m[1]) ?? []), +m[2]])]);
	}
	return map;
}

const isTunnel = (p: Proc) => p.name === "ssh" && /\s-\w*[NLRD]/.test(p.command) || /tailscale\S*\s+nc\s/i.test(p.command);
const isPi = (p: Proc) => p.name === "pi" || /pi-coding-agent\/dist\/cli/.test(p.command);
/** Never touched by prune, whatever else is true. */
export const protectedProc = (p: Proc) => isPi(p) || /Otty/i.test(p.command) || (p.command.startsWith("/Applications/") || p.command.startsWith("/System/")) && !isTunnel(p);

export function tunnels(procs: Proc[], listen: Map<number, number[]>, established: string): Tunnel[] {
	const byPid = new Map(procs.map((p) => [p.pid, p]));
	const result = procs.filter(isTunnel).map((p) => {
		const ports = listen.get(p.pid) ?? [];
		// A forwarded port is in use while some local connection goes to it.
		const inUse = ports.some((port) => established.includes(`->127.0.0.1:${port} `) || established.includes(`->[::1]:${port} `));
		return { pid: p.pid, ageSec: p.ageSec, command: p.command, ports, inUse, stale: false, ppid: p.ppid };
	});
	for (const t of result) {
		const parent = byPid.get(t.ppid);
		// tailscale nc is an ssh ProxyCommand: it lives as long as its ssh; orphaned or under a stale ssh, it is stale.
		const parentTunnel = result.find((r) => r.pid === t.ppid);
		t.stale = t.ageSec > STALE_SEC && !t.inUse && (!/tailscale/i.test(t.command) || !parent || parent.pid === 1 || !!parentTunnel && parentTunnel.ageSec > STALE_SEC && !parentTunnel.inUse);
	}
	return result.map(({ ppid, ...t }) => t);
}

/** caffeinate and who owns it. Pix keep-awake is `caffeinate -i -w <hub pid>` whose target is a Pi. */
export function caffeinates(procs: Proc[]) {
	const byPid = new Map(procs.map((p) => [p.pid, p]));
	return procs.filter((p) => p.name === "caffeinate").map((p) => {
		const target = byPid.get(Number(p.command.match(/-w\s+(\d+)/)?.[1]));
		const parent = byPid.get(p.ppid);
		const owner = (target ?? parent)?.command.slice(0, 80) ?? "orphan";
		const pix = !!(target && isPi(target)) || !!(parent && (isPi(parent) || /Otty/i.test(parent.command)));
		return { pid: p.pid, owner, pix, ageSec: p.ageSec };
	});
}

export function verdict(s: Pick<Status, "swap" | "windowServerMb" | "memory" | "uptimeSec">): { verdict: Verdict; reasons: string[] } {
	const now: string[] = [], soon: string[] = [];
	if (s.swap.pct >= 90) now.push(`swap ${s.swap.pct}%`); else if (s.swap.pct >= 80) soon.push(`swap ${s.swap.pct}%`);
	if (s.windowServerMb >= 5120) now.push(`WindowServer ${gb(s.windowServerMb)}`); else if (s.windowServerMb >= 3072) soon.push(`WindowServer ${gb(s.windowServerMb)}`);
	if (s.memory.pressure === "critical") now.push("memory pressure critical"); else if (s.memory.pressure === "warn") soon.push("memory pressure warn");
	if (s.uptimeSec >= 21 * DAY) soon.push(`up ${Math.floor(s.uptimeSec / DAY)} days`);
	return now.length ? { verdict: "reboot now", reasons: [...now, ...soon] } : soon.length ? { verdict: "reboot soon", reasons: soon } : { verdict: "fine", reasons: [] };
}
export const VERDICT_RANK: Record<Verdict, number> = { fine: 0, "reboot soon": 1, "reboot now": 2 };

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
const mb = (kb: number) => Math.round(kb / 1024);

export function status(run: Run = realRun, now = Date.now()): Status {
	const procs = parsePs(run("ps", ["-axo", "pid=,ppid=,etime=,rss=,command="]));
	const boot = Number(run("sysctl", ["-n", "kern.boottime"]).match(/sec = (\d+)/)?.[1] ?? 0);
	const total = Number(run("sysctl", ["-n", "hw.memsize"]).trim()) || 0;
	// ps RSS misses WindowServer's GPU-backed memory; top's MEM (footprint) is what Activity Monitor shows.
	const wsPid = procs.find((p) => p.name === "WindowServer")?.pid;
	const wsTop = wsPid ? topMemMb(run("top", ["-l", "1", "-stats", "pid,mem", "-pid", String(wsPid)]), wsPid) : 0;
	const ws = wsTop ? wsTop * 1024 : procs.filter((p) => p.name === "WindowServer").reduce((a, p) => a + p.rssKb, 0);
	const pis = procs.filter(isPi);
	const s = {
		at: now, uptimeSec: boot ? Math.max(0, Math.round(now / 1000 - boot)) : 0,
		memory: { pressure: pressureName(run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])), ...parseVmStat(run("vm_stat", []), total) },
		swap: parseSwap(run("sysctl", ["vm.swapusage"])),
		top: [...procs].sort((a, b) => b.rssKb - a.rssKb).slice(0, 8).map((p) => ({ pid: p.pid, name: p.name, rssMb: mb(p.rssKb) })),
		windowServerMb: mb(ws), pi: { count: pis.length, rssMb: mb(pis.reduce((a, p) => a + p.rssKb, 0)) },
		sleepDisabled: /SleepDisabled\s+1/.test(run("pmset", ["-g"])),
		blockers: parseAssertions(run("pmset", ["-g", "assertions"])),
		caffeinate: caffeinates(procs),
		tunnels: tunnels(procs, parseListen(run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"])), run("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED"])),
	};
	return { ...s, ...verdict(s) };
}

/** What prune would stop: stale tunnels and caffeinate not owned by Pix keep-awake. Never Pi, Otty or apps. */
export function pruneCandidates(run: Run = realRun, s = status(run)): Candidate[] {
	const procs = new Map(parsePs(run("ps", ["-axo", "pid=,ppid=,etime=,rss=,command="])).map((p) => [p.pid, p]));
	const out: Candidate[] = [];
	for (const t of s.tunnels) if (t.stale) out.push({ pid: t.pid, reason: `tunnel ${Math.floor(t.ageSec / DAY)}d old, ${t.ports.length ? "port unused" : "no forwarded port in use"}`, command: t.command });
	for (const c of s.caffeinate) if (!c.pix) out.push({ pid: c.pid, reason: `caffeinate ${Math.floor(c.ageSec / 3600)}h, owner ${c.owner}`, command: procs.get(c.pid)?.command ?? "caffeinate" });
	return out.filter((c) => { const p = procs.get(c.pid); return p && !protectedProc(p); });
}

export interface RebootPlan { comesBack: string[]; wontComeBack: string[]; jobs: { pid: number; session: string; command: string; ageSec: number }[]; lost: string[] }

/** Sessions the hub registered come back (launch-guard allows them after boot); loops and history never auto-start. */
export function rebootPlan(run: Run = realRun, runDir = join(homedir(), ".pix", "run")): RebootPlan {
	const read = (f: string) => { try { return JSON.parse(readFileSync(join(runDir, f), "utf8")); } catch { return undefined; } };
	// registered.json is what becomes registered-at-shutdown.json on the next boot.
	const ids: string[] = (read("registered.json") ?? read("registered-at-shutdown.json"))?.ids ?? [];
	const sessionOf = new Map<number, string>();
	try { for (const f of readdirSync(runDir)) if (/^\d+\.json$/.test(f)) { const r = read(f); if (r?.pid && r.sessionId) sessionOf.set(r.pid, r.sessionId); } } catch {}
	const procs = parsePs(run("ps", ["-axo", "pid=,ppid=,etime=,rss=,command="]));
	const pis = new Map(procs.filter(isPi).map((p) => [p.pid, p]));
	// A running background job is a direct non-Pi child of a Pi (bash -c ...). It dies with the reboot.
	const jobs = procs.filter((p) => pis.has(p.ppid) && !isPi(p) && !/^(caffeinate|node .*mcp|.*\bmcp\b)/.test(p.command) && p.name !== "pi" && !/pix-cover/.test(p.command))
		.map((p) => ({ pid: p.pid, session: sessionOf.get(p.ppid) ?? `pi ${p.ppid}`, command: p.command.slice(0, 120), ageSec: p.ageSec }));
	const s = status(run);
	const unregistered = [...pis.keys()].map((pid) => sessionOf.get(pid)).filter((id): id is string => !!id && !ids.includes(id));
	return {
		comesBack: ids.filter((id) => !id.startsWith("loop-")),
		wontComeBack: [...ids.filter((id) => id.startsWith("loop-")).map((id) => `${id} (loop, starts only when tapped)`), ...unregistered.map((id) => `${id} (not registered on the hub)`)],
		jobs,
		lost: [...s.tunnels.filter((t) => !t.stale).map((t) => `tunnel: ${t.command.slice(0, 80)}`), ...s.caffeinate.filter((c) => c.pix).map(() => "Pix keep-awake (restarts with the hub if on)")],
	};
}

const age = (sec: number) => sec >= DAY ? `${Math.floor(sec / DAY)}d` : sec >= 3600 ? `${Math.floor(sec / 3600)}h` : `${Math.floor(sec / 60)}m`;

export function formatStatus(s: Status): string {
	const L = [
		`${s.verdict}${s.reasons.length ? `: ${s.reasons.join(", ")}` : ""}`,
		`up ${age(s.uptimeSec)}, memory ${s.memory.usedGb}/${s.memory.totalGb} GB, pressure ${s.memory.pressure}, swap ${gb(s.swap.usedMb)} of ${gb(s.swap.totalMb)} (${s.swap.pct}%)`,
		`WindowServer ${gb(s.windowServerMb)}, ${s.pi.count} pi using ${gb(s.pi.rssMb)}`,
		`top: ${s.top.map((p) => `${p.name} ${p.rssMb >= 1024 ? gb(p.rssMb) : `${p.rssMb} MB`}`).join(", ")}`,
	];
	const block = [s.sleepDisabled ? "pmset SleepDisabled=1" : "", ...s.blockers.map((b) => `${b.owner} (${b.detail})`), ...s.caffeinate.filter((c) => !c.pix).map((c) => `caffeinate ${c.pid} ${age(c.ageSec)}, from ${c.owner}`)].filter(Boolean);
	L.push(`sleep blockers: ${block.length ? block.join("; ") : "none"}`);
	const stale = s.tunnels.filter((t) => t.stale);
	L.push(`tunnels: ${s.tunnels.length}, stale ${stale.length}${stale.length ? `: ${stale.map((t) => `${t.pid} ${age(t.ageSec)}`).join(", ")}` : ""}`);
	return L.join("\n");
}

export function formatPlan(p: RebootPlan): string {
	return [
		`comes back (${p.comesBack.length}): ${p.comesBack.join(", ") || "none"}`,
		`won't come back (${p.wontComeBack.length}):${p.wontComeBack.map((x) => `\n  ${x}`).join("") || " none"}`,
		`running jobs to restart (${p.jobs.length}):${p.jobs.map((j) => `\n  ${j.session}: ${j.command} (${age(j.ageSec)})`).join("") || " none"}`,
		`also gone: ${p.lost.join("; ") || "nothing else"}`,
	].join("\n");
}
