// Minimal read-only Gmail IMAP reader (no deps). Opens the mailbox with EXAMINE, so it can
// never mark mail read or change anything. Supports an HTTP CONNECT proxy.
import { connect as netConnect } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Msg } from "./proactive.ts";

/** Decode RFC 2047 encoded words (=?UTF-8?B?...?= / Q). */
export function decodeWords(s: string): string {
	return s.replace(/\?=\s+=\?/g, "?==?").replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, txt: string) => {
		const buf = enc.toUpperCase() === "B" ? Buffer.from(txt, "base64") : Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
		try { return new TextDecoder(cs.toLowerCase()).decode(buf); } catch { return buf.toString("utf8"); }
	});
}

const header = (raw: string, name: string) => decodeWords((raw.match(new RegExp(`^${name}:([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, "im"))?.[1] ?? "").replace(/\r?\n[ \t]/g, " ").trim());

/** Pull a readable text preview out of a raw message (first text/plain part, decoded). */
export function textPreview(raw: string, max = 600): string {
	const split = raw.search(/\r?\n\r?\n/);
	const head = split < 0 ? raw : raw.slice(0, split), body = split < 0 ? "" : raw.slice(split).replace(/^\s+/, "");
	const ctype = header(head, "Content-Type");
	const boundary = ctype.match(/boundary="?([^";]+)"?/i)?.[1];
	if (boundary) {
		const parts = body.split(`--${boundary}`).slice(1).filter(p => !p.startsWith("--"));
		const pick = parts.find(p => /content-type:\s*text\/plain/i.test(p)) ?? parts.find(p => /content-type:\s*(multipart|text\/html)/i.test(p));
		return pick ? textPreview(pick.replace(/^\r?\n/, ""), max) : "";
	}
	const cte = header(head, "Content-Transfer-Encoding").toLowerCase();
	const charset = ctype.match(/charset="?([^";\s]+)/i)?.[1] ?? "utf-8";
	let buf: Buffer;
	if (cte === "base64") buf = Buffer.from(body.replace(/\s+/g, ""), "base64");
	else if (cte === "quoted-printable") buf = Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
	else buf = Buffer.from(body, "latin1");
	let text: string;
	try { text = new TextDecoder(charset.toLowerCase()).decode(buf); } catch { text = buf.toString("utf8"); }
	if (/text\/html/i.test(ctype) || /^\s*<(!doctype|html)/i.test(text)) text = text.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
	return text.replace(/\[image:[^\]]*\]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** One parsed message from header + body-start bytes. */
export function toMsg(uid: string, raw: string, internalDate: string): Msg {
	const from = header(raw, "From");
	const sender = from.replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "").trim() || from;
	const t = Date.parse(internalDate.replace(/^(\d+)-(\w+)-(\d+) /, "$2 $1 $3 "));
	return { id: uid, time: Number.isNaN(t) ? internalDate : new Date(t).toISOString(), sender, text: `Subject: ${header(raw, "Subject")}\n${textPreview(raw)}`.slice(0, 1500) };
}

/** Parse FETCH responses with literals into [uid, internaldate, raw] records. */
export function parseFetch(buf: Buffer): { uid: string; date: string; raw: string }[] {
	const out: { uid: string; date: string; raw: string }[] = [];
	let i = 0;
	const s = buf.toString("latin1");
	while (true) {
		const start = s.indexOf("* ", i);
		if (start < 0) break;
		const lineEnd = s.indexOf("\r\n", start);
		if (lineEnd < 0) break;
		const line = s.slice(start, lineEnd);
		const lit = line.match(/\{(\d+)\}$/);
		if (!/FETCH/.test(line) || !lit) { i = lineEnd + 2; continue; }
		const len = Number(lit[1]);
		const raw = buf.subarray(lineEnd + 2, lineEnd + 2 + len).toString("utf8");
		const tailEnd = s.indexOf("\r\n", lineEnd + 2 + len);
		const meta = line + s.slice(lineEnd + 2 + len, tailEnd);
		out.push({ uid: meta.match(/UID (\d+)/)?.[1] ?? "", date: meta.match(/INTERNALDATE "([^"]+)"/)?.[1] ?? "", raw });
		i = tailEnd + 2;
	}
	return out;
}

async function open(host: string, port: number, proxy?: string): Promise<TLSSocket> {
	if (!proxy) return tlsConnect({ host, port, servername: host });
	const u = new URL(proxy);
	const raw = netConnect(Number(u.port || 80), u.hostname);
	await new Promise<void>((res, rej) => {
		raw.once("error", rej);
		raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
		let acc = "";
		const on = (d: Buffer) => { acc += d.toString("latin1"); if (acc.includes("\r\n\r\n")) { raw.off("data", on); / 200 /.test(acc.split("\r\n")[0]) ? res() : rej(new Error(`proxy: ${acc.split("\r\n")[0]}`)); } };
		raw.on("data", on);
	});
	return tlsConnect({ socket: raw, servername: host });
}

/** IMAP string: quoted when ASCII, else a non-synchronizing UTF-8 literal (LITERAL-), so Chinese queries work. */
export function imapString(s: string): string {
	return /^[\x20-\x7e]*$/.test(s) ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : `{${Buffer.byteLength(s)}+}\r\n${s}`;
}

export interface ImapOpts { user: string; pass: string; query: string; max?: number; proxy?: string; mailbox?: string; host?: string; timeoutMs?: number }

/** Recent messages matching a Gmail search query, oldest first. Read-only. */
export async function fetchGmailImap(o: ImapOpts): Promise<Msg[]> {
	const sock = await open(o.host ?? "imap.gmail.com", 993, o.proxy);
	let buf = Buffer.alloc(0), n = 0;
	const timer = setTimeout(() => sock.destroy(new Error("imap timeout")), o.timeoutMs ?? 45_000);
	sock.on("data", d => { buf = Buffer.concat([buf, d]); });
	const wait = (re: RegExp) => new Promise<Buffer>((res, rej) => {
		const check = () => { const s = buf.toString("latin1"); const m = s.match(re); if (m) { const end = m.index! + m[0].length; const got = buf.subarray(0, end); buf = buf.subarray(end); cleanup(); res(got); } };
		const onErr = (e: Error) => { cleanup(); rej(e); };
		const cleanup = () => { sock.off("data", check); sock.off("error", onErr); sock.off("close", onErr as any); };
		sock.on("data", check); sock.once("error", onErr); sock.once("close", () => onErr(new Error("imap closed")));
		check();
	});
	const cmd = async (c: string) => {
		const tag = `A${++n}`;
		sock.write(Buffer.from(`${tag} ${c}\r\n`, "utf8"));
		const r = await wait(new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`));
		const status = r.toString("latin1").match(new RegExp(`${tag} (OK|NO|BAD)([^\\r\\n]*)`))!;
		if (status[1] !== "OK") throw new Error(`imap ${c.split(" ")[0]}: ${status[2].trim()}`);
		return r;
	};
	try {
		await wait(/^\* OK[^\r\n]*\r\n/);
		const q = imapString;
		await cmd(`LOGIN ${q(o.user)} ${q(o.pass)}`);
		await cmd(`EXAMINE ${q(o.mailbox ?? "INBOX")}`);
		const search = (await cmd(`UID SEARCH CHARSET UTF-8 X-GM-RAW ${q(o.query)}`)).toString("latin1").match(/\* SEARCH([^\r\n]*)/)?.[1].trim();
		const uids = (search ? search.split(/\s+/) : []).slice(-(o.max ?? 20));
		if (!uids.length) return [];
		const res = await cmd(`UID FETCH ${uids.join(",")} (UID INTERNALDATE BODY.PEEK[]<0.20000>)`);
		await cmd("LOGOUT").catch(() => {});
		return parseFetch(res).map(r => toMsg(r.uid, r.raw, r.date)).sort((a, b) => Number(a.id) - Number(b.id));
	} finally { clearTimeout(timer); sock.destroy(); }
}
