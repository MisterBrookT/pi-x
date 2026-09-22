// Minimal MCP wire server for deterministic transport integration tests.
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "pix-fixture", version: "1.0.0" } };
  else if (request.method === "ping") result = {};
  else if (request.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo supplied text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
  else if (request.method === "tools/call" && request.params.name === "echo") result = { content: [{ type: "text", text: `echo:${request.params.arguments.text}` }] };
  else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not supported by fixture" } }) + "\n"); continue; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
