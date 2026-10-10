import test from "node:test";
import assert from "node:assert/strict";
import { decodeWords, parseFetch, textPreview, toMsg } from "../src/imap.ts";

test("decodeWords: base64 and Q encoded subjects", () => {
	assert.equal(decodeWords("=?UTF-8?B?5a6J5YWo5o+Q6YaS?="), "安全提醒");
	assert.equal(decodeWords("=?UTF-8?Q?Fill_the_form?= now"), "Fill the form now");
});

test("textPreview: multipart picks text/plain and decodes base64", () => {
	const raw = 'Content-Type: multipart/alternative; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from("请填写表格").toString("base64") + "\r\n--b1\r\nContent-Type: text/html\r\n\r\n<b>x</b>\r\n--b1--\r\n";
	assert.equal(textPreview(raw), "请填写表格");
});

test("textPreview: strips html even without a content type", () => {
	assert.equal(textPreview("Subject: x\r\n\r\n<!doctype html><html><style>a{}</style><p>Please&nbsp;fill</p></html>"), "Please fill");
});

test("parseFetch + toMsg: literal bodies become messages with sender name and subject", () => {
	const body = "From: \"HR Office\" <hr@zju.edu.cn>\r\nSubject: Form due Friday\r\n\r\nPlease fill the form.";
	const resp = Buffer.from(`* 1 FETCH (UID 42 INTERNALDATE "10-Oct-2026 09:07:27 +0000" BODY[]<0> {${Buffer.byteLength(body)}}\r\n${body})\r\nA4 OK done\r\n`);
	const [r] = parseFetch(resp);
	assert.equal(r.uid, "42");
	const m = toMsg(r.uid, r.raw, r.date);
	assert.deepEqual(m, { id: "42", time: "2026-10-10T09:07:27.000Z", sender: "HR Office", text: "Subject: Form due Friday\nPlease fill the form." });
});

test("regression: non-ASCII Gmail queries are sent as UTF-8 literals, ASCII stays quoted", async () => {
	const { imapString } = await import("../src/imap.ts");
	assert.equal(imapString('in:inbox "x"'), '"in:inbox \\"x\\""');
	assert.equal(imapString("填写 form"), `{${Buffer.byteLength("填写 form")}+}\r\n填写 form`);
});
