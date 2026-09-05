#!/usr/bin/env node
// Evaluate /complete predictions against what the user actually typed next in past sessions.
// usage: node scripts/eval-complete.mjs [--samples 12] [--model pix-anthropic/claude-haiku-4-5] [--judge pix-anthropic/claude-sonnet-5] [--seed 1]
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildPrompt, normalizeContinuation, normalizeSuggestion } from "../src/ai-completion.ts";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter(Boolean));
const SAMPLES = Number(args.samples ?? 12);
const MODEL = args.model ?? "pix-anthropic/claude-haiku-4-5";
const JUDGE = args.judge ?? "pix-anthropic/claude-sonnet-5";
let seed = Number(args.seed ?? 1);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const text = content => (typeof content === "string" ? content : Array.isArray(content) ? content.filter(p => p?.type === "text").map(p => p.text).join("\n") : "").trim();

async function loadPairs() {
  const root = join(homedir(), ".pi/agent/sessions");
  const pairs = [];
  for (const dir of await readdir(root)) {
    let files;
    try { files = (await readdir(join(root, dir))).filter(f => f.endsWith(".jsonl")); } catch { continue; }
    for (const file of files) {
      const turns = [];
      for (const line of (await readFile(join(root, dir, file), "utf8")).split("\n")) {
        let entry; try { entry = JSON.parse(line); } catch { continue; }
        const role = entry?.message?.role;
        if (entry?.type !== "message" || (role !== "user" && role !== "assistant")) continue;
        const t = text(entry.message.content);
        if (t) turns.push({ role, text: t });
      }
      for (let i = 2; i < turns.length; i++) {
        const target = turns[i];
        if (target.role !== "user" || turns[i - 1].role !== "assistant" || target.text.length < 8 || target.text.length > 400 || /^\/|\u001b|\u2588/.test(target.text)) continue;
        pairs.push({ context: turns.slice(Math.max(0, i - 4), i), target: target.text, source: `${dir.slice(-20)}/${file.slice(0, 10)}` });
      }
    }
  }
  return pairs;
}

function ask(model, system, user) {
  const r = spawnSync("pi", ["-p", "--no-session", "--model", model, "--system-prompt", system, user], { encoding: "utf8", timeout: 90_000 });
  return (r.stdout || "").trim();
}

const JUDGE_SYSTEM = "You grade an autocomplete prediction for a terminal chat with a coding agent. You see the recent conversation, the message the user actually sent (a style reference, not the answer key), and the prediction. Judge whether the prediction is a sensible, natural thing for this user to send at that point: right voice (terse, casual, same language), plausible content given the agent's last message, correct continuation of any structure the user started. Reply with one digit only: 2 = would happily accept it, 1 = plausible but a bit off in voice or length, 0 = unnatural, agent-voiced, or wrong.";

const pairs = (await loadPairs()).sort(() => rand() - 0.5).slice(0, SAMPLES);
if (!pairs.length) { console.error("no session pairs found"); process.exit(1); }

const rows = [];
for (const pair of pairs) {
  const cut = Math.max(3, Math.floor(pair.target.length * 0.4));
  const typed = pair.target.slice(0, cut);
  const s = buildPrompt({ kind: "suggest" }, pair.context);
  const c = buildPrompt({ kind: "continue", text: typed }, pair.context);
  const suggest = normalizeSuggestion(ask(MODEL, s.system, s.user)) ?? "";
  const cont = normalizeContinuation(ask(MODEL, c.system, c.user), typed) ?? "";
  const excerpt = pair.context.map(t => `${t.role === "user" ? "User" : "Agent"}: ${t.text.slice(-600)}`).join("\n\n");
  const grade = (pred, full) => (pred ? Number(ask(JUDGE, JUDGE_SYSTEM, `Conversation:\n${excerpt}\n\nActual message (style reference):\n${pair.target}\n\nPrediction:\n${full}`).match(/[012]/)?.[0] ?? 0) : 1);
  const row = { source: pair.source, actual: pair.target, suggest, sScore: grade(suggest, suggest), typed, cont, cScore: grade(cont, typed + cont) };
  rows.push(row);
  console.log(`\n[${rows.length}/${pairs.length}] ${row.source}\n  actual : ${row.actual.replace(/\n/g, " ⏎ ")}\n  empty  : ${row.suggest}   (${row.sScore})\n  typed  : ${row.typed.replace(/\n/g, " ⏎ ")}▏${row.cont}   (${row.cScore})`);
}
const avg = key => (rows.reduce((sum, r) => sum + r[key], 0) / rows.length).toFixed(2);
console.log(`\nmodel ${MODEL}, judge ${JUDGE}, n=${rows.length}\n  empty-buffer avg ${avg("sScore")} / 2\n  continuation avg ${avg("cScore")} / 2`);
