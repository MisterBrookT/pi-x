import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { etimeSec, formatStatus, parseAssertions, pruneCandidates, rebootPlan, status, verdict } from "./index.ts";

const NOW = 1793500000000, BOOT = Math.round(NOW / 1000) - 23 * 86400;
const PS = `
  1     0  23-00:00:00   9000 /sbin/launchd
  400   1  23-00:00:00 5500000 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon
  500   1  02-00:00:00 200000 /Applications/Otty.app/Contents/MacOS/Otty
  600 500  01-00:00:00 200000 pi
  601 500  01-00:00:00 210000 pi
  602 600     10:00     5000 bash -c npm run long
  700   1  08-00:00:00    560 ssh -fN -L 18790:127.0.0.1:8790 dgx
  701   1  08-00:00:00    560 ssh -fN -L 18080:127.0.0.1:8080 dgx
  702   1  01-00:00:00    560 ssh -fN -L 18999:127.0.0.1:8999 dgx
  703   1  09-00:00:00    560 /Applications/Tailscale.app/Contents/MacOS/Tailscale nc dgx 22
  800   1  02-12:00:00    300 caffeinate -i /tmp/xpull/loop.sh
  801 600     05:00      300 caffeinate -i -w 600
`;
const fake = (over = {}) => (cmd, args) => {
	const key = `${cmd} ${args.join(" ")}`;
	if (key in over) return over[key];
	if (cmd === "ps") return PS;
	if (key === "sysctl -n kern.boottime") return `{ sec = ${BOOT}, usec = 0 }`;
	if (key === "sysctl -n hw.memsize") return String(16 * 2 ** 30);
	if (key === "sysctl -n kern.memorystatus_vm_pressure_level") return "1\n";
	if (key === "sysctl vm.swapusage") return "vm.swapusage: total = 17408.00M  used = 16073.44M  free = 1334.56M  (encrypted)";
	if (cmd === "vm_stat") return "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active:   200000.\nPages wired down:   300000.\nPages occupied by compressor:  100000.\n";
	if (cmd === "top") return "PID  MEM\n400  5371M\n";
	if (key === "pmset -g") return " SleepDisabled\t\t1\n";
	if (key === "pmset -g assertions") return `Listed by owning process:
   pid 338(powerd): [0x1] 340:18:52 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"
   pid 800(caffeinate): [0x2] 60:00:00 PreventUserIdleSystemSleep named: "caffeinate command-line tool"`;
	if (key === "lsof -nP -iTCP -sTCP:LISTEN") return "ssh 700 u 6u IPv4 0x1 0t0 TCP 127.0.0.1:18790 (LISTEN)\nssh 701 u 6u IPv4 0x1 0t0 TCP 127.0.0.1:18080 (LISTEN)\nssh 702 u 6u IPv4 0x1 0t0 TCP 127.0.0.1:18999 (LISTEN)\n";
	if (key === "lsof -nP -iTCP -sTCP:ESTABLISHED") return "node 9 u 7u IPv4 0x1 0t0 TCP 127.0.0.1:55000->127.0.0.1:18080 (ESTABLISHED)\n";
	return "";
};

test("etime parses ps ages", () => {
	assert.equal(etimeSec("05:00"), 300);
	assert.equal(etimeSec("02:00:00"), 7200);
	assert.equal(etimeSec("08-00:00:01"), 8 * 86400 + 1);
});

test("status reads uptime, memory, swap, WindowServer, pi, blockers and stale tunnels; verdict says reboot now", () => {
	const s = status(fake(), NOW);
	assert.equal(Math.round(s.uptimeSec / 86400), 23);
	assert.equal(s.swap.pct, 92);
	assert.equal(s.memory.pressure, "normal");
	assert.equal(s.memory.usedGb, 9.2);
	assert.equal(s.windowServerMb, 5371);
	assert.deepEqual(s.pi, { count: 2, rssMb: 400 });
	assert.equal(s.top[0].name, "WindowServer");
	assert.ok(s.top.length <= 8);
	assert.equal(s.sleepDisabled, true);
	assert.deepEqual(s.blockers.map((b) => b.pid), [800], "powerd's display-on assertion is not a blocker");
	assert.deepEqual(s.caffeinate.map((c) => [c.pid, c.pix]), [[800, false], [801, true]]);
	const stale = s.tunnels.filter((t) => t.stale).map((t) => t.pid);
	assert.deepEqual(stale, [700, 703], "in-use (701) and young (702) tunnels stay");
	assert.equal(s.verdict, "reboot now");
	assert.match(formatStatus(s), /^reboot now: swap 92%, WindowServer 5\.2 GB/);
	assert.doesNotMatch(formatStatus(s), /·/);
	assert.ok(formatStatus(s).split("\n").length <= 8, "one short screen");
	JSON.parse(JSON.stringify(s));
});

test("verdict thresholds: fine, reboot soon, reboot now", () => {
	const base = { swap: { pct: 10 }, windowServerMb: 1000, memory: { pressure: "normal" }, uptimeSec: 86400 };
	assert.equal(verdict(base).verdict, "fine");
	assert.equal(verdict({ ...base, swap: { pct: 82 } }).verdict, "reboot soon");
	assert.equal(verdict({ ...base, windowServerMb: 3500 }).verdict, "reboot soon");
	assert.equal(verdict({ ...base, swap: { pct: 95 } }).verdict, "reboot now");
	assert.equal(verdict({ ...base, memory: { pressure: "critical" } }).verdict, "reboot now");
});

test("prune candidates: stale tunnels and foreign caffeinate only; never pi, Otty, apps or Pix keep-awake", () => {
	const pids = pruneCandidates(fake()).map((c) => c.pid).sort();
	assert.deepEqual(pids, [700, 703, 800], "a tailscale nc helper is a tunnel, not the app");
	for (const p of [500, 600, 601, 801, 701, 702]) assert.ok(!pids.includes(p));
});

test("assertions parser ignores non-sleep kinds", () => {
	assert.deepEqual(parseAssertions('   pid 9(x): [0x1] 00:01:00 BackgroundTask named: "y"'), []);
});

test("reboot plan: registered sessions come back, loops and unregistered do not, running jobs are listed", () => {
	const dir = mkdtempSync(join(tmpdir(), "mackit-"));
	writeFileSync(join(dir, "registered.json"), JSON.stringify({ at: 1, ids: ["news-docs", "pix-foryou", "loop-abc"] }));
	writeFileSync(join(dir, "600.json"), JSON.stringify({ pid: 600, sessionId: "news-docs" }));
	writeFileSync(join(dir, "601.json"), JSON.stringify({ pid: 601, sessionId: "scratch" }));
	const p = rebootPlan(fake(), dir);
	assert.deepEqual(p.comesBack, ["news-docs", "pix-foryou"]);
	assert.ok(p.wontComeBack.some((x) => x.startsWith("loop-abc")));
	assert.ok(p.wontComeBack.some((x) => x.startsWith("scratch")));
	assert.deepEqual(p.jobs.map((j) => [j.session, j.pid]), [["news-docs", 602]]);
});
