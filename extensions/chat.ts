/**
 * Talk to other Pi sessions on this Mac. Tool `chat`: list and send.
 * Incoming messages appear in the transcript and wake the session; a reply goes back with send + replyTo.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { Type } from "typebox";
import { find, join_, peers, send, type Note, type Peer } from "../src/chat.ts";

const MSG = "pix-chat";

export default function (pi: ExtensionAPI) {
  let me: Peer | undefined;
  let room: ReturnType<typeof join_> | undefined;
  const nameOf = (ctx: ExtensionContext) => pi.getSessionName() || basename(ctx.cwd) || "pi";

  const receive = (n: Note) => pi.sendMessage(
    { customType: MSG, display: true, details: n,
      content: `Message from session "${n.fromName}" (id ${n.from}, msg ${n.id}${n.replyTo ? `, reply to ${n.replyTo}` : ""}):\n\n${n.text}\n\n` +
        `Reply with chat send to="${n.from}" replyTo="${n.id}" if an answer is needed; otherwise just act on it.` },
    { triggerTurn: true, deliverAs: "followUp" });

  pi.on("session_start", (_e, ctx) => {
    room?.close();
    me = { id: `${ctx.sessionManager.getSessionId().slice(-6)}${process.pid.toString(36)}`, name: nameOf(ctx), cwd: ctx.cwd, pid: process.pid, at: Date.now(), status: "idle" };
    room = join_(me, receive);
  });
  pi.on("agent_start", () => room?.update({ status: "busy" }));
  pi.on("agent_end", (_e, ctx) => room?.update({ status: "idle", name: nameOf(ctx) }));
  pi.on("session_shutdown", () => { room?.close(); room = undefined; });

  pi.registerMessageRenderer(MSG, (message, _opts, theme) => {
    const n = message.details as Note;
    return new Text(`${theme.fg("accent", `✉ ${n.fromName}`)}${n.replyTo ? theme.fg("dim", ` (reply)`) : ""}  ${n.text}`, 0, 0);
  });

  const list = () => {
    const ps = peers().filter((p) => p.id !== me?.id);
    return ps.length ? ps.map((p) => `${p.name}  id=${p.id}  ${p.status ?? ""}  ${p.cwd}`).join("\n") : "No other live sessions.";
  };
  const deliver = (to: string, text: string, replyTo?: string) => {
    if (!me) return "chat is not ready";
    const p = find(to, undefined, me.id);
    if (typeof p === "string") return p;
    const n = send(me, p, text, replyTo);
    return `Sent to ${p.name} (msg ${n.id}). Its answer will arrive as a new message.`;
  };

  pi.registerTool({
    name: "chat",
    label: "Chat",
    description: "Message other Pi sessions running on this Mac. list shows live sessions; send delivers text to one (by name or id). " +
      "To ask a question, send it: the answer arrives later as a message. To answer, send with replyTo set to the incoming msg id.",
    parameters: Type.Object({
      action: StringEnum(["list", "send"]),
      to: Type.Optional(Type.String({ description: "Session name or id (a unique prefix works)" })),
      message: Type.Optional(Type.String()),
      replyTo: Type.Optional(Type.String({ description: "msg id being answered" })),
    }),
    async execute(_id, p) {
      const text = p.action === "list" ? list()
        : !p.to || !p.message ? "send needs to and message" : deliver(p.to, p.message, p.replyTo);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

}
