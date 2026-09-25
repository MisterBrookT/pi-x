// Local-only deterministic Pi-shaped session for the Safari/XCTest UI journey.
import { readFile } from "node:fs/promises";
import { startRemoteHub } from "../src/remote-hub.ts";
import { imageRef } from "../src/remote-state.ts";

const token = "simulator-demo-token-not-production";
const port = Number(process.env.PIX_TEST_FIXTURE_PORT || 18787);
const hub = await startRemoteHub({ token, port });
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const base = `http://127.0.0.1:${port}`;
const id = "simulator-demo";
// A real screenshot-like PNG, so the Simulator run checks legibility, not just presence.
const picture = { type: "image", mimeType: "image/png", data: (await readFile(new URL("./fixtures/remote-image-test.png", import.meta.url))).toString("base64") };
const pictureRef = imageRef(picture);
const messages = [
  { id: "u1", role: "user", text: "Review the project structure", timestamp: 1 },
  { id: "a1", role: "assistant", text: "The app is connected to this live session. Tool results are below.", timestamp: 2,
    tools: [{ id: "t1", name: "read", input: '{"path":"src/index.ts"}', output: "export function main() {}" },
      { id: "t2", name: "read", input: '{"path":"remote-image-test.png"}', output: "Read image file [image/png]", images: [pictureRef] }] },
];
const publish = () => fetch(`${base}/agent/${id}`, { method: "PUT", headers: auth,
  body: JSON.stringify({ id, name: "Pix simulator test", cwd: "/workspace/demo", busy: false, messages }) });
await publish();
await fetch(`${base}/agent/${id}/media/${pictureRef.id}`, { method: "PUT", headers: auth, body: JSON.stringify({ mimeType: picture.mimeType, data: picture.data }) });
const timer = setInterval(() => void publish(), 8_000);
let running = true;
const poll = async () => {
  while (running) {
    try {
      const result = await fetch(`${base}/agent/${id}/next`, { headers: auth });
      for (const text of (await result.json()).prompts ?? []) {
        messages.push({ id: `u${messages.length}`, role: "user", text, timestamp: Date.now() });
        messages.push({ id: `a${messages.length}`, role: "assistant", text: "Phone prompt reached the same session.", timestamp: Date.now() });
        await publish();
      }
    } catch { if (running) await new Promise((resolve) => setTimeout(resolve, 300)); }
  }
};
void poll();
console.log("fixture ready");
process.on("SIGTERM", () => { running = false; clearInterval(timer); void hub.close().then(() => process.exit()); });
