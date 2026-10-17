import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusPrompt, parseStatus, summarizeTurn, readStatus, statusBoard, statusFile } from "../plugins/foryou/session-status.ts";
import { reviewPrompt } from "../plugins/foryou/forward.ts";
import forYou from "../plugins/foryou/index.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "fy-status-"));

test("status: the prompt asks for one very short line and flags when brook is needed", () => {
  const p = statusPrompt("minara", "send the chart", "Chart sent to Lowes. Waiting on his list.");
  assert.match(p, /ONE very short line \(max 12 words\)/);
  assert.match(p, /start the line with "needs you:"/);
  assert.match(p, /Session: minara/);
});

test("status: parse keeps one clean line and reads the needs-you flag", () => {
  assert.deepEqual(parseStatus('- "Chart sent; waiting on Lowes"\nextra'), { line: "Chart sent; waiting on Lowes", needs: false });
  assert.deepEqual(parseStatus("needs you: pick model name"), { line: "pick model name", needs: true });
  assert.deepEqual(parseStatus("Needs you：选模型"), { line: "选模型", needs: true });
  assert.equal(parseStatus("  \n"), undefined);
});

test("status: one line per session, overwritten each turn; the board lists newest first", async () => {
  const dir = tmp();
  const ask = async () => "Backtest running, next: chart";
  await summarizeTurn({ session: "a", name: "minara", ask: "go", reply: "started", model: "m", dir, now: new Date("2026-10-17T10:00:00Z") }, ask);
  await summarizeTurn({ session: "b", name: "pix", ask: "x", reply: "y", model: "m", dir, now: new Date("2026-10-17T10:05:00Z") }, async () => "needs you: approve deploy");
  await summarizeTurn({ session: "a", name: "minara", ask: "go", reply: "done", model: "m", dir, now: new Date("2026-10-17T10:06:00Z") }, async () => "Chart sent to Lowes");
  const all = readStatus(dir);
  assert.equal(all.length, 2);
  assert.equal(statusBoard(all, Date.parse("2026-10-17T10:10:00Z")),
    "minara           · Chart sent to Lowes · 4m ago\npix              · needs you: approve deploy · 5m ago");
});

test("status: a failing or empty model call writes nothing and never throws", async () => {
  const dir = tmp();
  assert.equal(await summarizeTurn({ session: "a", ask: "", reply: "r", model: "m", dir }, async () => { throw new Error("down"); }), undefined);
  assert.equal(await summarizeTurn({ session: "a", ask: "", reply: "", model: "m", dir }, async () => "x"), undefined);
  assert.deepEqual(readStatus(dir), []);
});

test("status: the hourly review shows where each session stands", () => {
  const p = reviewPrompt({ open: [], board: "minara · Chart sent · 4m ago" });
  assert.match(p, /Where each session stands now:\nminara · Chart sent · 4m ago/);
});

test("status: a session's turn end starts the summary beside it with the filter model, not awaited", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ model: "cheap/model" }));
  const handlers = {}, calls = [];
  const pi = new Proxy({}, { get: (_, k) => k === "on" ? (ev, fn) => { (handlers[ev] ??= []).push(fn); } : () => {} });
  forYou(pi, { dir, sessions: async () => [], summarize: async t => { calls.push(t); } });
  const ctx = { cwd: "/w/minara", sessionManager: { getSessionId: () => "s1", getSessionName: () => "minara" }, ui: { notify() {}, setStatus() {}, setWidget() {} } };
  const event = { messages: [{ role: "user", content: "send the chart" }, { role: "assistant", content: [{ type: "text", text: "Chart sent." }] }] };
  for (const h of handlers.agent_end) h(event, ctx);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0], dir: undefined }, { session: "s1", name: "minara", cwd: "/w/minara", ask: "send the chart", reply: "Chart sent.", model: "cheap/model", dir: undefined });
  // For you's own turns are not summarized.
  const fy = { ...ctx, sessionManager: { getSessionId: () => "pix-foryou", getSessionName: () => "For you" } };
  for (const h of handlers.agent_end) h(event, fy);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls.length, 1);
});
