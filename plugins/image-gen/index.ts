import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateImages, type Runner } from "./generate.ts";

const MIME: Record<string, string> = { ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
export const imageOutDir = () => process.env.PIX_IMAGE_DIR ?? join(process.env.PIX_HOME ?? join(homedir(), ".pix"), "artifacts", "images");

export default function (pi: ExtensionAPI, run?: Runner) {
  pi.registerTool({
    name: "generate_image",
    label: "Generate image",
    description: "Generate or edit images on brook's ChatGPT/Codex subscription (official Codex CLI; the backend picks the model). Returns saved file paths and the images. Takes up to 3 minutes.",
    promptSnippet: "generate_image: create or edit images (product shots, illustrations, mockups) via the Codex subscription",
    parameters: Type.Object({
      prompt: Type.String({ description: "What to draw. Be concrete about layout, background and any text." }),
      aspect: Type.Optional(Type.Union([Type.Literal("square"), Type.Literal("landscape"), Type.Literal("portrait")])),
      inputs: Type.Optional(Type.Array(Type.String(), { description: "Absolute paths of images to edit or build on" })),
      n: Type.Optional(Type.Number({ minimum: 1, maximum: 4 })),
    }),
    async execute(_id, params) {
      const images = await generateImages(params, imageOutDir(), run);
      const lines = images.map(i => `${i.path}${i.width ? ` (${i.width}x${i.height})` : ""}`);
      return {
        content: [
          { type: "text", text: `Saved ${images.length} image(s); model chosen by the Codex backend (not reported by the CLI):\n${lines.join("\n")}` },
          ...images.map(i => ({ type: "image" as const, data: readFileSync(i.path).toString("base64"), mimeType: MIME[extname(i.path).toLowerCase()] ?? "image/png" })),
        ],
        details: { images },
      };
    },
  });
}
