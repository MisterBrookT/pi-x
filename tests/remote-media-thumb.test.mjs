// Chat images load as a small JPEG; the full image only when opened. Real sips, real hub.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startRemoteHub } from "../plugins/remote/remote-hub.ts";

test("?thumb=1 returns a much smaller JPEG of a big chat image; without it, the original", async t => {
	const dir = mkdtempSync(join(tmpdir(), "pix-mt-"));
	// A 2400x1600 noisy PNG (~MBs), like a screenshot.
	const png = join(dir, "big.png");
	execFileSync("python3", ["-c", `
import zlib,struct,random
w,h=600,400
raw=b''.join(b'\\0'+bytes(random.getrandbits(8) for _ in range(w*3)) for _ in range(h))
def ch(t,d):return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d))
open('${png}','wb').write(b'\\x89PNG\\r\\n\\x1a\\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw,1))+ch(b'IEND',b''))`]);
	const data = readFileSync(png).toString("base64");
	const id = createHash("sha256").update("image/png").update(data).digest("hex");
	const tk = "m".repeat(32), hub = await startRemoteHub({ token: tk, port: 0 });
	t.after(() => hub.close());
	const base = `http://127.0.0.1:${hub.port}`, headers = { authorization: `Bearer ${tk}`, "content-type": "application/json" };
	await fetch(`${base}/agent/s1`, { method: "PUT", headers, body: JSON.stringify({ name: "s", cwd: "/tmp", busy: false, messages: [] }) });
	const put = await fetch(`${base}/agent/s1/media/${id}`, { method: "PUT", headers, body: JSON.stringify({ id, mimeType: "image/png", data }) });
	assert.equal(put.status, 200, await put.text());
	const thumb = await (await fetch(`${base}/api/sessions/s1/media/${id}?thumb=1`, { headers })).json();
	assert.equal(thumb.mimeType, "image/jpeg");
	assert.ok(thumb.data.length * 3 < data.length, `thumb ${thumb.data.length} vs full ${data.length}`);
	const full = await (await fetch(`${base}/api/sessions/s1/media/${id}`, { headers })).json();
	assert.equal(full.data, data, "opening gets the original");
});
