// Every visible pin has a semantic 1-3 word label: never a hash, a doc token or a random host part.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meaningless, pinLabel, resolveLabels } from "../plugins/core/pin-label.ts";
import { loadArtifacts, pinArtifact } from "../plugins/core/artifacts.ts";

const L = (title, url, kind = /^(~|\/)/.test(url) ? "file" : /feishu/.test(url) ? "doc" : "link") => pinLabel({ title, url, kind, at: 0 });

test("labels from real pins: no hashes or random host parts", () => {
	assert.equal(L("Xv1odRf2FoJ3sWxd3fbcR5XxnGg", "https://byterum.feishu.cn/docx/Xv1odRf2FoJ3sWxd3fbcR5XxnGg"), "Doc", "unnamed Feishu doc waits for its real title");
	assert.equal(L("soma-selections-peace-adaptive.trycloudflare.com", "https://soma-selections-peace-adaptive.trycloudflare.com/kairos/docs"), "Docs preview");
	assert.equal(L("PR #10 Kairos docs + arena", "https://github.com/DMindAI/dmind-website/pull/10"), "PR #10");
	assert.equal(L("Live arena (token)", "https://kairos.brooktang.fun/arena"), "Live arena");
	assert.equal(L("arena", "https://kairos.brooktang.fun/arena"), "Arena");
	assert.equal(L("token=x", "https://decision.brooktang.fun/leaderboard?token=x"), "Leaderboard");
	assert.equal(L("rc.brooktang.fun", "https://rc.brooktang.fun"), "Link");
	assert.equal(L("kairos-scorecard.jpg", "/Users/b/Desktop/kairos-scorecard.jpg"), "Kairos scorecard");
	assert.equal(L("Kairos docs preview (DGX)", "https://x.trycloudflare.com/kairos/docs"), "Kairos docs preview");
	assert.equal(L("Kairos 新闻源清单:类型、延迟", "https://byterum.feishu.cn/docx/N"), "Kairos 新闻源清单");
	for (const s of ["Xv1odRf2FoJ3sWxd3fbcR5XxnGg", "M8ORdKnVqoSp53xTHKpcaxFbnBd\\", "${token}`", "docx_token", "9164f38e9a", "rc.brooktang.fun"]) assert.ok(meaningless(s), s);
	for (const s of ["Docs preview", "Arena", "Q3 report", "10-21 meeting notes"]) assert.ok(!meaningless(s), s);
});

test("unnamed pins are named once in the background (Feishu title first, then the model) and cached", async () => {
	const d = mkdtempSync(join(tmpdir(), "pl-"));
	pinArtifact("s", { title: "Xv1odRf2FoJ3sWxd3fbcR5XxnGg", url: "https://byterum.feishu.cn/docx/Xv1odRf2FoJ3sWxd3fbcR5XxnGg" }, d);
	pinArtifact("s", { title: "a8f3c2e91b", url: "https://a8f3c2e91b.example.com" }, d);
	pinArtifact("s", { title: "Docs preview", url: "https://b.pages.dev/docs" }, d);
	let calls = 0;
	const feishu = async a => (calls++, /feishu/.test(a.url) ? "Minara 桌面端增量提测｜2026-10-28" : undefined);
	const model = async () => (calls++, "Release notes");
	await resolveLabels("s", loadArtifacts("s", d), { dir: d, feishu, model });
	assert.deepEqual(loadArtifacts("s", d).map(pinLabel), ["Minara 桌面端增量提测", "Release notes", "Docs preview"]);
	const before = calls;
	await resolveLabels("s", loadArtifacts("s", d), { dir: d, feishu, model });
	assert.equal(calls, before, "cached: not asked again");
});
