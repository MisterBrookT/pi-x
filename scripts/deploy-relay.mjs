// Deploy the relay Worker (phone page) and confirm the live page matches this checkout.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const origin = (() => { try { return JSON.parse(readFileSync(join(homedir(), ".pi/agent/pix-remote/relay.json"), "utf8")).origin; } catch { return process.env.PIX_REMOTE_RELAY_URL; } })();
const log = m => console.log(`[relay deploy] ${m}`);
try {
  log("deploying relay/ …");
  execFileSync("npx", ["wrangler", "deploy"], { cwd: new URL("../relay/", import.meta.url), stdio: ["ignore", "ignore", "inherit"], timeout: 180_000 });
  if (!origin) { log("deployed (no relay origin configured to verify)"); process.exit(0); }
  const { remoteAppHtml } = await import("../src/remote-web.ts");
  const marker = remoteAppHtml.match(/<form class="composer"[\s\S]{0,400}/)[0];
  for (let i = 0; i < 10; i++) {
    const live = await (await fetch(origin + "/?v=" + Date.now(), { cache: "no-store" })).text();
    if (live.includes(marker)) { log(`live at ${origin}`); process.exit(0); }
    await new Promise(r => setTimeout(r, 2000));
  }
  log(`deployed, but ${origin} does not serve this version yet; check Cloudflare`);
} catch (e) {
  log(`FAILED: ${e.message}. The commit is kept; run \`node scripts/deploy-relay.mjs\` after fixing.`);
}
