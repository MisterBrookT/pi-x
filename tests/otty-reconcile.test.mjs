import test from "node:test";
import assert from "node:assert/strict";
import { parseOttyPanes, reconcile, parsePs, findOrphans, hubIdOf } from "../plugins/remote/otty-reconcile.ts";

const otty = JSON.stringify({ command: "pane list", ok: true, data: [
  { id: "p_a", agent: "Pi", agent_session_id: "2026-10-26T03-28-31-284Z_01a17640-photo", agent_state: "idle", process: "photo-brighten", cwd: "/u" },
  { id: "p_b", agent: "Pi", agent_session_id: "2026-10-10T11-34-34-634Z_pix-foryou", agent_state: "processing", process: "for-you", cwd: "/u" },
  { id: "p_c", agent: "Pi", agent_session_id: "2026-10-27T15-48-30-004Z_loop-546a09e3", agent_state: "awaiting", process: "news-docs", cwd: "/m" },
  { id: "p_d", agent: "Claude Code", agent_session_id: "0b5ab8b1", agent_state: "error", process: "pix-app", cwd: "/p" },
  { id: "p_e", agent: "", agent_session_id: "", agent_state: "", process: "fish", cwd: "/" },
] });

test("Otty JSONL basenames map to hub ids; every agent pane parses (only Pi panes are listed as unregistered)", () => {
  assert.equal(hubIdOf("2026-10-15T09-45-53-909Z_01a13ef4-33f4"), "01a13ef4-33f4");
  const panes = parseOttyPanes(otty);
  assert.deepEqual(panes.map(p => [p.sessionId, p.state]), [["01a17640-photo", "idle"], ["pix-foryou", "processing"], ["loop-546a09e3", "awaiting"], ["0b5ab8b1", "idle"]]);
  assert.deepEqual(parseOttyPanes("not json"), []);
});

test("unregistered Pi pane is shown, gone entry is dead then dropped after grace", () => {
  const panes = parseOttyPanes(otty);
  const r1 = reconcile(["pix-foryou", "loop-546a09e3", "gone-1"], panes, 1000, {}, 60_000);
  assert.deepEqual(r1.unregistered.map(p => p.name), ["photo-brighten"]);
  assert.deepEqual(r1.states, { "pix-foryou": "processing", "loop-546a09e3": "awaiting", "gone-1": "dead" });
  assert.deepEqual(r1.drop, []);
  const r2 = reconcile(["pix-foryou", "loop-546a09e3", "gone-1"], panes, 61_000, r1.missingSince, 60_000);
  assert.deepEqual(r2.drop, ["gone-1"]);
});

test("a session that comes back is no longer dead; Otty failure changes nothing", () => {
  const panes = parseOttyPanes(otty);
  const r1 = reconcile(["01a17640-photo-x"], [], 0, {});
  assert.equal(r1.states["01a17640-photo-x"], "dead");
  const back = reconcile(["01a17640-photo"], panes, 10, r1.missingSince);
  assert.equal(back.states["01a17640-photo"], "idle");
  assert.deepEqual(back.missingSince, {});
  const down = reconcile(["a", "b"], null, 999_999, { a: 0 });
  assert.deepEqual(down.drop, []); assert.deepEqual(down.states, {});
});

test("sessions Otty never hosts (phone chats) are not judged", () => {
  const r = reconcile(["phone-1"], [], 10 ** 9, { "phone-1": 0 }, 1, id => id.startsWith("phone"));
  assert.deepEqual(r.drop, []); assert.equal(r.states["phone-1"], undefined);
});

const ps = `  57134 38350    08-03:15:32 pi
  54585 57134          00:11 pi
  32373 32337    06-21:30:53 pi
  69455 69425    03-22:01:15 pi
  48608 48567    03-16:07:22 pi
  11111 22222    02-00:00:00 node server.js
  77777 1        01:00:00 pi`;

test("ps etime parses days, hours, minutes", () => {
  const p = parsePs(ps);
  assert.equal(p[0].ageSec, 8 * 86400 + 3 * 3600 + 15 * 60 + 32);
  assert.equal(p[1].ageSec, 11);
});

test("orphan = known session, no pane, no hub connection, idle >24h; never child, hub, unknown or young", () => {
  const day = 86400;
  const res = findOrphans({
    processes: parsePs(ps),
    pidSessions: new Map([[57134, "old-orphan"], [54585, "child"], [32373, "photo"], [69455, "hub"], [48608, "connected"], [77777, "young"]]),
    paneSessions: new Set(["photo"]),
    connected: new Set([48608]),
    protect: new Set([69455]),
    idleSec: sid => sid === "young" ? 10 : 3 * day,
  });
  assert.deepEqual(res.map(p => p.pid), [57134]);
});

test("unmapped pi (no pidfile) is never an orphan", () => {
  const res = findOrphans({ processes: parsePs("1 1 09-00:00:00 pi"), pidSessions: new Map(), paneSessions: new Set(), connected: new Set(), protect: new Set(), idleSec: () => 10 ** 7 });
  assert.deepEqual(res, []);
});

test("recently active session is not an orphan even with an old process", () => {
  const res = findOrphans({ processes: parsePs("1 1 09-00:00:00 pi"), pidSessions: new Map([[1, "s"]]), paneSessions: new Set(), connected: new Set(), protect: new Set(), idleSec: () => 60 });
  assert.deepEqual(res, []);
});

test("sync tick kills only the sure orphan, logs it, and does nothing when Otty is down", async () => {
  const { ottySyncTick } = await import("../plugins/remote/otty-sync.ts");
  const killed = [], logs = [];
  const deps = {
    otty: async () => otty,
    ps: async () => "100 1 03-00:00:00 pi\n200 1 03-00:00:00 pi\n300 100 00:05 pi\n400 1 03-00:00:00 pi\n",
    connections: async () => "p400\nf12\n",
    pidSessions: () => new Map([[100, "gone"], [200, "01a17640-photo"], [300, "child"], [400, "conn"]]),
    idleSec: () => 2 * 86400,
    kill: pid => killed.push(pid),
    log: l => logs.push(l),
    now: () => 0,
  };
  const r = await ottySyncTick(deps, ["pix-foryou"], {}, () => false, new Set([999]));
  assert.deepEqual(killed, [100]);
  assert.match(logs[0], /killed pid=100 session=gone/);
  assert.deepEqual(r.unregistered.map(p => p.name), ["photo-brighten", "news-docs"]);
  killed.length = 0;
  await ottySyncTick({ ...deps, otty: async () => null }, ["x"], {}, () => false, new Set());
  assert.deepEqual(killed, [], "Otty down: no kills");
});

test("hub shows unregistered Pi panes and dead labels in the session list", async t => {
  const { startRemoteHub } = await import("../plugins/remote/remote-hub.ts");
  const { mkdtemp, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pix-otty-")); t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const token = "hub-token-1234567890abcdef";
  const hub = await startRemoteHub({ token, port: 0, home: dir, memoryRoot: join(dir, "hub"), ottySync: () => ({ otty: async () => otty, ps: async () => "", connections: async () => "", pidSessions: () => new Map(), idleSec: () => undefined, kill: () => { throw new Error("no kill"); }, log: () => {}, now: () => 0 }) });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`, auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${base}/agent/pix-foryou`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "for-you", cwd: dir, busy: true, messages: [] }) });
  await fetch(`${base}/agent/gone`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "gone", cwd: dir, busy: false, messages: [] }) });
  t.mock.timers.tick(30_000); await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 50));
  const list = await (await fetch(`${base}/api/sessions`, { headers: auth })).json();
  const by = Object.fromEntries(list.map(s => [s.id, s]));
  assert.equal(by["pix-foryou"].pane, "processing");
  assert.equal(by.gone.pane, undefined, "just heartbeated: never dead while connected");
  assert.equal(by["01a17640-photo"].unregistered, true);
  assert.equal(by["01a17640-photo"].name, "photo-brighten");
});

test("10-31: any agent pane counts (Claude Code too); a duplicate shell pane with the same name changes nothing; a live hub connection is never dead", () => {
  const otty = JSON.stringify({ data: [
    { id: "p_old", agent: null, process: "for-you", cwd: "/x" },
    { id: "p_live", agent: "Pi", agent_session_id: "2026-10-10T11-34-34-634Z_pix-foryou", process: "for-you", agent_state: "processing", cwd: "/x" },
    { id: "p_cc", agent: "Claude Code", agent_session_id: "0b5ab8b1-uuid", process: "pix-app", agent_state: "error", cwd: "/p" },
  ] });
  const panes = parseOttyPanes(otty);
  assert.equal(panes.length, 2);
  const live = new Set(["pix-foryou", "01a-pixapp", "01a-quiet"]);
  const names = { "pix-foryou": "for-you", "01a-pixapp": "pix-app", "01a-quiet": "quiet" };
  const r = reconcile(["pix-foryou", "01a-pixapp", "01a-quiet"], panes, 10 ** 9, { "01a-quiet": 0 }, 60_000, () => false, id => live.has(id), id => names[id]);
  assert.equal(r.states["pix-foryou"], "processing");
  assert.equal(r.states["01a-pixapp"], "idle", "matched by pane name while connected; an error state reads as idle");
  assert.equal(r.states["01a-quiet"], undefined, "connected, no pane: no label, never dead");
  assert.deepEqual(r.drop, []);
  assert.deepEqual(r.unregistered, [], "the Claude Code pane is claimed by pix-app, not listed twice");
});
