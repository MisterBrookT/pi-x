/**
 * Sessions coordinate with each other directly, so brook only hears about real decisions.
 *
 * Tool `chat`: board (who is doing what, who claims what), set (my doing / claims), send (note | ask | handoff | reply).
 * - note: arrives on the receiver's next turn, never wakes it. ask / handoff / reply: wake it (until the hop limit).
 * - Claims are enforced: edit / write on a file another live session claims is blocked with "ask <owner> first".
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { basename, resolve } from "node:path";
import { Type } from "typebox";
import { board, chatRoot, claimName, nameBase, slug, find, KINDS, MAX_HOPS, owner, send, wakes, join_, type Kind, type Note, type Peer } from "./chat.ts";
import { CHAT_WAITING, CHAT_WAITS_QUERY, type ChatWaitsState } from "../core/chat-waiting.ts";
import { checkFor, closeWaits, loadWaiting, noticeText, receivedNote, sameWaiting, saveWaiting, sentNote, tick, waitingLines, waitingPath, waitingText, type Waiting } from "./waiting.ts";

const WAIT_STATUS = "pix-chat";
const WAITS_STATUS = "pix-chat-waits";  // the footer shows this on its own line
const TICK_MS = 30_000;

const MSG = "pix-chat";
const MSG_CHECK = "pix-chat-check";
/** Sessions that never join chat. (For you joins: it hands work out and gets replies back here.) */
const OFF = new Set<string>();

const HOW = {
  note: "FYI only; no answer expected.",
  ask: `Answer with chat send kind="reply" to="{from}" thread="{thread}" (add grant=[path] to let them edit a file you claim). Settle it yourselves; involve brook only for things that leave this machine, deletions, or a conflict you cannot resolve.`,
  handoff: `This task is now yours. When done (or if you cannot do it), send kind="reply" to="{from}" thread="{thread}" with the result.`,
  reply: "This answers your earlier message; continue your work with it. Reply again only if something is still open.{grant}",
};

export function format(n: Note): string {
  const how = HOW[n.kind].replaceAll("{from}", n.from).replaceAll("{thread}", n.thread)
    .replace("{grant}", n.grant?.length ? ` You may now edit: ${n.grant.join(", ")}.` : "");
  const stop = n.hop >= MAX_HOPS ? `\n\nThis thread hit the ${MAX_HOPS}-reply limit, so it did not wake you. Do not reply automatically; tell brook what is open.` : "";
  return `[chat ${n.kind} from session "${n.from}", thread ${n.thread}]\n\n${n.text}\n\n${how}${stop}`;
}

export default function (pi: ExtensionAPI) {
  let me: Peer | undefined;
  let room: ReturnType<typeof join_> | undefined;
  let sent: (Note & { to: string }) | undefined;  // last message sent, rendered as a bubble in this pane
  const granted = new Set<string>();  // files other sessions explicitly let me edit
  const hops = new Map<string, number>();  // thread -> hop of the last message seen, so my reply goes one higher

  // Who I wait on (asks/handoffs without a reply), shown quietly in the footer and kept across /reload.
  let ui: { setStatus?: (key: string, text?: string) => void } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined, shown: string | undefined;
  const waitFile = () => me && waitingPath(chatRoot(), me.name);
  const setWaiting = (next: (w: Waiting) => Waiting) => {
    const f = waitFile(); if (!f) return;
    const old = loadWaiting(f), w = next(old);
    if (!sameWaiting(old, w)) saveWaiting(f, w);
    const text = waitingText(w);
    ui?.setStatus?.(WAIT_STATUS, noticeText(w));
    ui?.setStatus?.(WAITS_STATUS, waitingLines(w));
    if (text !== shown) { shown = text; pi.events?.emit?.(CHAT_WAITING, { text }); }
  };
  // The goal asks how many replies this session still waits for, so "waiting" can be told from "idle".
  pi.events?.on?.(CHAT_WAITS_QUERY, (data: unknown) => {
    const f = waitFile(); if (!f || !data || typeof data !== "object") return;
    const w = loadWaiting(f).waits, q = data as ChatWaitsState;
    q.waits += w.length;
    for (const x of w) if (x.check && (q.nextCheck === undefined || x.check.next < q.nextCheck)) q.nextCheck = x.check.next;
  });
  const check = () => {
    if (ui && me) (ui as { setTitle?: (t: string) => void }).setTitle?.(me.name);
    let wakes: string[] = [];
    setWaiting(w => { const r = tick(w, new Map(board().map(x => [x.name, x.status ?? ""]))); wakes = r.wakes; return { waits: r.waits, notices: r.notices }; });
    for (const text of wakes) pi.sendMessage({ customType: MSG_CHECK, display: true, details: { text }, content: text }, { triggerTurn: true, deliverAs: "followUp" });
  };

  const receive = (n: Note) => {
    hops.set(n.thread, n.hop);
    setWaiting(w => receivedNote(w, n));
    for (const f of n.grant ?? []) granted.add(f);
    pi.sendMessage({ customType: MSG, display: true, details: n, content: format(n) },
      wakes(n) ? { triggerTurn: true, deliverAs: "followUp" } : { deliverAs: "nextTurn" });
  };

  pi.on("session_start", (_e, ctx) => {
    room?.close(); room = undefined; me = undefined;
    // Names are the folder name only (kaji, minara-2), never a task title or a "π - " prefix.
    const base = nameBase(ctx.cwd, ctx.sessionManager?.getSessionId?.());
    if (OFF.has(slug(base)) || process.env.PIX_CHAT_OFF) return;  // brook's personal session stays out of project chat
    const name = claimName(base, process.pid, undefined, ctx.sessionManager?.getSessionId?.());
    // Keep Pi's own session name (Remote list, /resume) in step; the id and routing stay the same.
    const named = pi.getSessionName();
    if (named && named !== name) (pi as { setSessionName?: (n: string) => void }).setSessionName?.(name);
    me = { name, cwd: ctx.cwd, pid: process.pid, session: ctx.sessionManager?.getSessionId?.(), at: Date.now(), status: "idle", doing: "", claims: [] };
    room = join_(me, receive);
    ui = ctx.hasUI ? ctx.ui : undefined;
    title(ctx);
    check();
    clearInterval(timer); timer = setInterval(check, TICK_MS); timer.unref?.();
  });
  // The terminal tab/pane title is the board name ("minara-2"), so Otty tabs match the board.
  // Pi rewrites the title on session_info_changed and some redraws; re-apply ours after it.
  const title = (ctx: ExtensionContext) => { if (me && ctx.hasUI) (ctx.ui as { setTitle?: (t: string) => void }).setTitle?.(me.name); };
  pi.on("session_info_changed" as any, (_e: unknown, ctx: ExtensionContext) => { setTimeout(() => title(ctx), 0); });
  pi.on("agent_start", (_e, ctx) => { room?.update({ status: "busy" }); title(ctx); });
  pi.on("agent_end", () => room?.update({ status: "idle" }));
  pi.on("session_shutdown", () => { clearInterval(timer); timer = undefined; room?.close(); room = undefined; });

  // Enforce claims on file edits.
  pi.on("tool_call", (event, ctx) => {
    if (!me || (event.toolName !== "edit" && event.toolName !== "write")) return;
    const path = (event.input as { path?: string }).path;
    if (!path) return;
    const abs = resolve(ctx.cwd, path);
    const o = owner(abs, me.name) ?? owner(path, me.name);
    if (o && !granted.has(abs)) return { block: true, reason: `${abs} is claimed by session "${o.name}" (doing: ${o.doing || "?"}). ` +
      `Ask it: chat send kind="ask" to="${o.name}" naming the file. Do not work around this with bash. ` +
      `When the owner allows it, it sends chat with grant=["${abs}"] (or drops the claim), and the edit will pass.` };
  });

  pi.registerMessageRenderer(MSG, (message, { expanded }, theme) => {
    const n = message.details as Note;
    // One quiet line; the text shows when expanded (the model always gets all of it).
    const head = `${theme.fg("dim", `↳ ${n.kind} from ${n.from}`)}`;
    return new Text(expanded ? `${head}${theme.fg("dim", ` · thread ${n.thread}`)}\n${n.text}` : `${head}${theme.fg("dim", ` · ${n.text.replace(/\s+/g, " ").slice(0, 60)}${n.text.length > 60 ? "…" : ""}`)}`, 0, 0);
  });

  pi.registerMessageRenderer(MSG_CHECK, (message, _o, theme) => new Text(theme.fg("dim", `⏳ ${(message.details as { text: string }).text.split(":")[0]}`), 0, 0));

  const show = (ps: Peer[]) => ps.map((p) =>
    `${p.name === me?.name ? "* " : "  "}${p.name} [${p.status}] ${p.cwd}\n    doing: ${p.doing || "-"}\n    claims: ${(p.claims ?? []).join(", ") || "-"}`).join("\n");

  pi.registerTool({
    name: "chat",
    label: "Chat",
    description: "Coordinate with other Pi sessions on this Mac, instead of asking brook to relay. " +
      "board: who is doing what and who claims which files / machines / services. " +
      "set: publish what I am doing and what I claim (absolute file paths, or names like a800c, nd-fresh); other sessions cannot edit my claimed files. " +
      "close: stop waiting on a handoff/ask that will not get a formal reply (thread, or to=session). " +
      "send: kind note (FYI, does not wake them), ask (they answer), handoff (they own the task and report back), reply (answer an ask/handoff; pass its thread). " +
      "To let another session edit a file you claim, reply with grant=[path]. " +
      "Before editing files or using machines another session might own, check the board; if claimed, ask the owner.",
    parameters: Type.Object({
      action: StringEnum(["board", "set", "send", "close"]),
      to: Type.Optional(Type.String({ description: "Session name (unique prefix works)" })),
      kind: Type.Optional(StringEnum([...KINDS])),
      message: Type.Optional(Type.String()),
      label: Type.Optional(Type.String({ maxLength: 60, description: "ask/handoff: a short task summary (≤40 chars) shown in your footer while you wait, e.g. 'restyle leaderboard'" })),
      thread: Type.Optional(Type.String({ description: "Thread id when replying; close: the wait to stop (or to= a session to close all waits on it, or thread=\"all\")" })),
      doing: Type.Optional(Type.String({ description: "set: one line on what this session is doing" })),
      claims: Type.Optional(Type.Array(Type.String(), { description: "set: full list of claims (replaces the old list)" })),
      grant: Type.Optional(Type.Array(Type.String(), { description: "send: claimed files the receiver may now edit" })),
      check: Type.Optional(StringEnum(["off", "fixed", "exponential"], { description: "ask/handoff: when to wake you to check on it if no reply came (like a background job). Default: exponential for handoff, off for ask. You are also woken at once if the receiver exits or stops working without replying." })),
      checkMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440, description: "First check after this many minutes (default 15); fixed repeats it, exponential doubles it up to 1 h" })),
    }),
    renderCall(args, theme) {
      if (args.action !== "send") return new Text(theme.fg("muted", `chat ${args.action}`), 0, 0);
      return new Text(theme.fg("muted", `chat → ${args.to ?? "?"}`), 0, 0);
    },
    renderResult(r, _o, theme, context) {
      const n = (r.details as { sent?: Note & { to: string } } | undefined)?.sent;
      const t = r.content[0]?.type === "text" ? r.content[0].text : "";
      if (!n) return new Text(theme.fg(context.isError ? "error" : "muted", t), 0, 0);
      return new Text(`${theme.fg("accent", `✉ ${n.kind} to ${n.to}`)}${theme.fg("dim", ` · thread ${n.thread}`)}\n${n.text}`, 0, 0);
    },
    async execute(_id, p, _signal, _update, ctx: ExtensionContext) {
      const text = ((): string => {
        if (!me || !room) return "chat is not ready";
        if (p.action === "board") return `You are "${me.name}".\n${show(board())}`;
        if (p.action === "close") {
          const which = p.thread ?? p.to; if (!which) return "close needs thread (or to, or thread=\"all\")";
          let closed: { what?: string; to: string }[] = [];
          setWaiting(w => { const r = closeWaits(w, which); closed = r.closed; return r.w; });
          return closed.length ? `Stopped waiting on: ${closed.map(x => `${x.to}${x.what ? ` (${x.what})` : ""}`).join("; ")}.` : "No open wait matches.";
        }
        if (p.action === "set") {
          const claims = p.claims?.map((c) => (c.includes("/") ? resolve(ctx.cwd, c) : c));
          const clash = (claims ?? []).map((c) => [c, owner(c, me!.name)] as const).filter(([, o]) => o);
          if (clash.length) return `Not set: ${clash.map(([c, o]) => `${c} is claimed by ${o!.name}`).join("; ")}. Ask them first.`;
          room.update({ ...(p.doing !== undefined && { doing: p.doing }), ...(claims && { claims }) });
          return `Board updated.\n${show(board().filter((x) => x.name === me!.name))}`;
        }
        if (!p.to || !p.message) return "send needs to and message";
        const to = find(p.to, undefined, me.name);
        if (typeof to !== "string") return to.error;
        const kind = (p.kind ?? "note") as Kind;
        const hop = p.thread ? (hops.get(p.thread) ?? 0) + 1 : 0;
        const grant = p.grant?.map((g) => resolve(ctx.cwd, g));
        const n = send(me.name, to, kind, p.message, { thread: p.thread, hop, grant });
        hops.set(n.thread, hop);
        sent = { ...n, to };
        const live = board().some((x) => x.name === to);
        const chk = checkFor(kind, (p as any).check, (p as any).checkMinutes, n.at);
        setWaiting(w => sentNote(w, { thread: n.thread, to, kind, at: n.at, message: p.message, label: (p as any).label, check: chk }, live));
        return `Sent ${kind} to ${to} (thread ${n.thread}${hop ? `, reply ${hop}/${MAX_HOPS}` : ""}).` +
          (!live ? " It is not running now; the message waits until it comes back." : kind === "note" ? " It will see it on its next turn." : " Its answer will arrive as a message.") +
          (chk ? ` First check in ${Math.round(chk.every / 60_000)} min (${chk.mode}).` : "");
      })();
      const details = p.action === "send" && sent ? { sent } : {};
      sent = undefined;
      return { content: [{ type: "text", text }], details };
    },
  });
}
