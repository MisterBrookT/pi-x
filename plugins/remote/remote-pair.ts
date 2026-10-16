import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type Command = (name: string, args: string[]) => Promise<string>;
const run: Command = async (name, args) => (await exec(name, args, { timeout: 4_000, maxBuffer: 1024 * 1024 })).stdout;

/** Only trust a private Serve route that points at our loopback hub, never Funnel. */
export function privateServeUrl(config: any, dnsName: string, port: number): string | undefined {
  if (!dnsName || !config?.Web || typeof config.Web !== "object") return;
  const hostname = dnsName.replace(/\.$/, "").toLowerCase();
  for (const [hostPort, web] of Object.entries(config.Web) as [string, any][]) {
    const [host, httpsPort] = hostPort.toLowerCase().split(":");
    if (host !== hostname || httpsPort !== "443" || config.AllowFunnel?.[hostPort]) continue;
    const proxy = web?.Handlers?.["/"]?.Proxy;
    if (proxy === `http://127.0.0.1:${port}` || proxy === `http://localhost:${port}`) return `https://${hostname}/`;
  }
}

export async function prepareRemotePairing(port: number, token: string, command: Command = run): Promise<{ message: string; cleanup?: () => Promise<void> }> {
  // A local userspace tailscaled may use a non-default socket (e.g. Kaji on macOS).
  const localSocket = join(homedir(), ".local/share/tailscaled/sock");
  const socket = process.env.TAILSCALE_SOCKET || (existsSync(localSocket) ? localSocket : "");
  const ts = (args: string[]) => command("tailscale", socket ? [`--socket=${socket}`, ...args] : args);
  let state: any;
  try { state = JSON.parse(await ts(["status", "--json"])); }
  catch { return { message: "Connect Tailscale on your Mac and iPhone, then run /rc again." }; }
  if (state.BackendState !== "Running" || !state.Self?.DNSName) {
    return { message: "Connect Tailscale on your Mac and iPhone, then run /rc again." };
  }
  let config: any;
  try { config = JSON.parse(await ts(["serve", "status", "--json"])); }
  catch { return { message: "Could not inspect Tailscale Serve. Run tailscale serve status on your Mac." }; }
  let url = privateServeUrl(config, state.Self.DNSName, port);
  if (!url && !Object.keys(config?.Web || {}).length && !Object.keys(config?.TCP || {}).length && !Object.keys(config?.AllowFunnel || {}).length) {
    try {
      await ts(["serve", "--bg", String(port)]);
      config = JSON.parse(await ts(["serve", "status", "--json"]));
      url = privateServeUrl(config, state.Self.DNSName, port);
    } catch (error: any) {
      const output = `${error?.stdout || ""}\n${error?.stderr || ""}`;
      const approval = output.match(/https:\/\/login\.tailscale\.com\/f\/serve\?node=[A-Za-z0-9_-]+/);
      if (approval) {
        try { await command(process.platform === "darwin" ? "open" : "xdg-open", [approval[0]]); } catch {}
        return { message: `Tailscale Serve needs one-time approval: ${approval[0]}. Approve it, then run /rc again.` };
      }
    }
  }
  if (!url) return { message: "Tailscale Serve is not privately routing to Pix Remote. Check tailscale serve status; do not use Funnel." };
  return openPairingQR(`${url}#token=${encodeURIComponent(token)}`, command);
}

export async function prepareRelayPairing(origin: string, key: string, command: Command = run) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error("Relay must use an HTTPS origin");
  return openPairingQR(`${url.origin}/#key=${encodeURIComponent(key)}`, command);
}

async function openPairingQR(link: string, command: Command): Promise<{ message: string; cleanup?: () => Promise<void> }> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "pix-remote-pair-"));
    await chmod(directory, 0o700);
    const image = join(directory, "pair.png");
    await command("qrencode", ["-t", "PNG", "-s", "8", "-m", "4", "-o", image, link]);
    await chmod(image, 0o600);
    await command(process.platform === "darwin" ? "open" : "xdg-open", [image]);
    return { message: "Scan the QR code with your iPhone camera. Treat the QR code as a password.", cleanup: () => rm(directory!, { recursive: true, force: true }) };
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true });
    return { message: `QR unavailable (install qrencode). Open this private URL on your phone: ${link}` };
  }
}
