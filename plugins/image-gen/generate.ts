// Image generation on brook's ChatGPT/Codex subscription through the official Codex CLI.
// Pix never reads or forwards the Codex token: `codex exec` uses its own login, runs its built-in
// image_generation tool, and saves files under <CODEX_HOME>/generated_images/<thread_id>/.
// No API key, no OpenRouter, no paid fallback: if the CLI fails, the tool fails.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { inventory } from "../../packages/accountkit/index.ts";

export interface ImageRequest { prompt: string; aspect?: "square" | "landscape" | "portrait"; inputs?: string[]; n?: number }
export interface ImageResult { path: string; width?: number; height?: number }
export type Runner = (args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;

export const IMAGE_TIMEOUT_MS = 180_000;
const SIZES = { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" } as const;

/** The active Codex login: an enabled AccountKit codex account with a dir, else Codex's default home. */
export function codexHome(): string {
  const a = inventory().find(x => x.provider === "codex" && x.dir && !(x as { disabled?: boolean }).disabled);
  return a?.dir ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function buildPrompt(r: ImageRequest): string {
  const n = Math.max(1, Math.min(4, r.n ?? 1)), size = SIZES[r.aspect ?? "square"];
  return [
    `Use your image generation tool to create exactly ${n} image${n > 1 ? "s" : ""} at ${size}.`,
    r.inputs?.length ? "Edit or build on the attached image(s)." : "",
    `Image description: ${r.prompt}`,
    "Do not run shell commands or edit files. When done, reply only with: done",
  ].filter(Boolean).join("\n");
}

/** PNG/WebP/JPEG pixel size from the file header, without decoding. */
export function imageSize(path: string): { width?: number; height?: number } {
  const b = Buffer.alloc(64), fd = openSync(path, "r");
  try { readSync(fd, b, 0, 64, 0); } finally { closeSync(fd); }
  if (b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 12, 16) === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  return {};
}

const defaultRunner: Runner = (args, env, timeoutMs) => new Promise(resolve => {
  const child = spawn("codex", args, { env, stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  child.stdout.on("data", d => { stdout += d; });
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  child.on("close", code => { clearTimeout(timer); resolve({ code, stdout }); });
  child.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout }); });
});

export async function generateImages(r: ImageRequest, outDir: string, run: Runner = defaultRunner, home = codexHome()): Promise<ImageResult[]> {
  if (!r.prompt?.trim()) throw new Error("prompt is required");
  for (const p of r.inputs ?? []) if (!existsSync(p)) throw new Error(`input image not found: ${p}`);
  const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--ignore-rules",
    ...(r.inputs ?? []).flatMap(p => ["-i", p]), buildPrompt(r)];
  const { code, stdout } = await run(args, { ...process.env, CODEX_HOME: home }, IMAGE_TIMEOUT_MS);
  const thread = /"thread_id":"([A-Za-z0-9-]+)"/.exec(stdout)?.[1];
  const dir = thread ? join(home, "generated_images", thread) : undefined;
  const files = dir && existsSync(dir) ? readdirSync(dir).filter(f => /\.(png|webp|jpe?g)$/i.test(f)).sort() : [];
  if (!files.length) throw new Error(code === 0 ? "Codex finished without an image (the backend may have declined the prompt)" : `codex exec failed (exit ${code}); check \`codex login status\``);
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return files.map((f, i) => {
    const path = join(outDir, `image-${stamp}-${i + 1}${extname(f)}`);
    copyFileSync(join(dir!, f), path);
    return { path, ...imageSize(path) };
  });
}
