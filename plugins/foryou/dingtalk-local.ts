/** Read-only DingTalk Mac v3 cache reader. No network, app injection, or stored keys.
 * Key derivation documented by b3nguang/dingtalkdb-decrypt; independently implemented here.
 * The original DB/WAL are read into memory; only a private temporary snapshot is opened by SQLite.
 */
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Msg } from "./proactive.ts";

export const dingRoot = join(homedir(), "Library/Containers/5ZSL2CJU2T.com.dingtalk.mac/Data/Library/Application Support/DingTalkMac");
export function dingKey(uid: string, salt: string): Buffer {
	return Buffer.from(createHash("md5").update(pbkdf2Sync(uid + salt, "666DingT", 1000, 32, "sha1")).digest("hex").slice(0, 16));
}
export function dingDecrypt(data: Buffer, key: Buffer): Buffer {
	if (data.length % 16) throw new Error("DingTalk encrypted data is incomplete");
	const c = createDecipheriv("aes-128-ecb", key, null); c.setAutoPadding(false);
	return Buffer.concat([c.update(data), c.final()]);
}
function checksum(data: Buffer, big: boolean, seed = [0, 0]): number[] {
	let [a, b] = seed;
	for (let i = 0; i < data.length; i += 8) {
		a = (a + (big ? data.readUInt32BE(i) : data.readUInt32LE(i)) + b) >>> 0;
		b = (b + (big ? data.readUInt32BE(i + 4) : data.readUInt32LE(i + 4)) + a) >>> 0;
	}
	return [a, b];
}
/** Validate encrypted WAL checksums, apply only the last committed transaction, ignore stale/uncommitted tail. */
export function dingSnapshot(encrypted: Buffer, wal: Buffer | undefined, key: Buffer): Buffer {
	const db = dingDecrypt(encrypted, key);
	if (db.subarray(0, 16).toString() !== "SQLite format 3\0") throw new Error("DingTalk database key did not validate");
	const pageSize = db.readUInt16BE(16) === 1 ? 65536 : db.readUInt16BE(16);
	if (pageSize < 512 || pageSize > 65536 || pageSize & (pageSize - 1) || db.length % pageSize) throw new Error("Invalid DingTalk page size");
	if (!wal?.length) return db;
	if (wal.length < 32) throw new Error("Incomplete DingTalk WAL header; retry after sync");
	const magic = wal.readUInt32BE(0);
	if (![0x377f0682, 0x377f0683].includes(magic) || wal.readUInt32BE(4) !== 3007000 || wal.readUInt32BE(8) !== pageSize) throw new Error("Unsupported DingTalk WAL format");
	const big = magic === 0x377f0683;
	let sum = checksum(wal.subarray(0, 24), big);
	const matches = (s: number[], p: number) => s[0] === wal.readUInt32BE(p) && s[1] === wal.readUInt32BE(p + 4);
	if (!matches(sum, 24)) throw new Error("Invalid DingTalk WAL header checksum");
	const frames: { page: number; offset: number }[] = [];
	let committed = 0, pages = 0;
	for (let p = 32; p + 24 + pageSize <= wal.length; p += 24 + pageSize) {
		if (!wal.subarray(p + 8, p + 16).equals(wal.subarray(16, 24))) break; // old WAL generation
		sum = checksum(wal.subarray(p, p + 8), big, sum);
		sum = checksum(wal.subarray(p + 24, p + 24 + pageSize), big, sum);
		if (!matches(sum, p + 16)) throw new Error("DingTalk WAL changed or is corrupt; retry after sync");
		const page = wal.readUInt32BE(p), size = wal.readUInt32BE(p + 4);
		if (!page || page > 262144 || size > 262144) throw new Error("Invalid DingTalk WAL page number");
		frames.push({ page, offset: p + 24 });
		if (size) { committed = frames.length; pages = size; }
	}
	if (!committed) return db;
	const out = Buffer.alloc(pages * pageSize); db.copy(out);
	for (const f of frames.slice(0, committed)) if (f.page <= pages) dingDecrypt(wal.subarray(f.offset, f.offset + pageSize), key).copy(out, (f.page - 1) * pageSize);
	return out;
}

/** Decode supported text without exposing binary attachments or inventing image contents. */
export function dingText(raw: unknown): string {
	if (typeof raw !== "string" || !raw.trim()) return "[Unsupported message]";
	let value: any; try { value = JSON.parse(raw); } catch { return raw.slice(0, 1500); }
	const text = typeof value?.text === "string" ? value.text : typeof value?.text?.content === "string" ? value.text.content : "";
	if (text) return text.slice(0, 1500);
	return `[Unsupported DingTalk message type ${String(value?.contentType ?? "unknown")}; view it in DingTalk]`;
}
export interface DingChat { id: string; name: string; me: string; messages: Msg[] }
export function dingReadTables(db: DatabaseSync, uid: string, limit = 100): DingChat[] {
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name)).filter(n => /^tbmsg_\d+$/.test(n));
	if (!tables.length) throw new Error("DingTalk message schema not found");
	const users = new Map(db.prepare("SELECT CAST(uid AS TEXT) uid, nick FROM tbuser_profile_v2").all().map(r => [String(r.uid), String(r.nick || r.uid)]));
	const me = users.get(uid) ?? uid;
	const chats = new Map(db.prepare("SELECT cid, title FROM tbconversation").all().map(r => [String(r.cid), String(r.title || r.cid)]));
	const messages = new Map<string, Msg[]>();
	// CAST avoids precision loss for DingTalk's 64-bit message IDs.
	for (const table of tables) {
		const rows = db.prepare(`SELECT cid, CAST(mid AS TEXT) id, CAST(senderId AS TEXT) sender, createdAt, content FROM "${table}" WHERE COALESCE(recallStatus,0)=0 AND mid>0 ORDER BY createdAt DESC LIMIT ?`).all(limit * Math.max(chats.size, 1));
		for (const r of rows) {
			const time = Number(r.createdAt); if (!Number.isFinite(time) || time <= 0) continue;
			const cid = String(r.cid), list = messages.get(cid) ?? [];
			list.push({ id: String(r.id), sender: users.get(String(r.sender)) ?? String(r.sender), time: new Date(time).toISOString(), text: dingText(r.content) }); messages.set(cid, list);
		}
	}
	return [...messages].map(([id, msgs]) => ({ id, name: chats.get(id) ?? id, me, messages: [...new Map(msgs.map(m => [m.id, m])).values()].sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id)).slice(-limit) }));
}
function fingerprint(path: string): string { try { const s = statSync(path, { bigint: true }); return `${s.ino}:${s.size}:${s.mtimeNs}`; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw e; } }
/** Account must be explicit if multiple profiles exist. Never silently mix accounts. */
export function readDingTalk(root = dingRoot, account?: string, tmpParent?: string): DingChat[] {
	const profiles = readdirSync(root).filter(n => n.endsWith("_v3"));
	if (!account && profiles.length !== 1) throw new Error("Choose one DingTalk local account");
	const selected = account ?? profiles[0];
	if (!profiles.includes(selected)) throw new Error("DingTalk account not found");
	const folder = join(root, selected), path = join(folder, "DBFiles/dingtalk.db"), walPath = path + "-wal";
	const config = JSON.parse(Buffer.from(readFileSync(join(folder, "user_config"), "utf8"), "base64").toString());
	if (typeof config.salt !== "string" || !config.salt) throw new Error("DingTalk v3 salt not found");
	const uids = new Set<string>();
	for (const log of readdirSync(join(root, "log")).filter(n => n.startsWith("gaea.log"))) {
		for (const m of readFileSync(join(root, "log", log), "utf8").matchAll(/real_uid=(\d+)/g)) uids.add(m[1]);
	}
	for (let attempt = 0; attempt < 3; attempt++) {
		const before = fingerprint(path) + fingerprint(walPath);
		const data = readFileSync(path), wal = existsSync(walPath) ? readFileSync(walPath) : undefined;
		if (before !== fingerprint(path) + fingerprint(walPath)) continue;
		for (const uid of uids) {
			const key = dingKey(uid, config.salt);
			try {
				if (dingDecrypt(data.subarray(0, 16), key).toString() !== "SQLite format 3\0") continue;
				const snapshot = dingSnapshot(data, wal, key);
				// Standalone copy: no WAL recovery or writes needed in SQLite.
				snapshot[18] = snapshot[19] = 1;
				const dir = mkdtempSync(join(tmpParent ?? tmpdir(), "pix-dingtalk-"));
				try {
					const file = join(dir, "snapshot.db"); writeFileSync(file, snapshot, { mode: 0o600 });
					const db = new DatabaseSync(file, { readOnly: true });
					try { return dingReadTables(db, uid); } finally { db.close(); }
				} finally { rmSync(dir, { recursive: true, force: true }); }
			} finally { key.fill(0); }
		}
		throw new Error("No DingTalk local key validated; sign in to the Mac app first");
	}
	throw new Error("DingTalk database is syncing; retry later");
}
