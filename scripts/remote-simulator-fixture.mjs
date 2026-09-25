// Local-only deterministic Pi-shaped session for the Safari/XCTest UI journey.
import { startRemoteHub } from "../src/remote-hub.ts";

const token = "simulator-demo-token-not-production";
const port = Number(process.env.PIX_TEST_FIXTURE_PORT || 18787);
const hub = await startRemoteHub({ token, port });
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const base = `http://127.0.0.1:${port}`;
const id = "simulator-demo";
const messages = [
  { id: "u1", role: "user", text: "Review the project structure", timestamp: 1 },
  { id: "a1", role: "assistant", text: "The app is connected to this live session. Tool results are below.", timestamp: 2,
    tools: [{ id: "t1", name: "read", input: '{"path":"src/index.ts"}', output: "export function main() {}" }] },
];
const publish = () => fetch(`${base}/agent/${id}`, { method: "PUT", headers: auth,
  body: JSON.stringify({ id, name: "Pix simulator test", cwd: "/workspace/demo", busy: false, messages }) });
await publish();
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
