// Where the local hub lives and how to reach it: shared by every plugin that talks to the hub.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export const remoteHost = "127.0.0.1";
export const remoteDefaultPort = 8787;
export const remoteTokenPath = join(homedir(), ".pi/agent/pix-remote/token");
/** Bookmarks shown in the phone sidebar: [{ "label": "Book", "url": "https://..." }]. Local only, never in Git. */
export const remoteUploadsDir = join(homedir(), ".pi/agent/pix-remote/uploads");
export const remoteLinksPath = join(homedir(), ".pi/agent/pix-remote/links.json");
export async function readRemoteLinks(path = remoteLinksPath): Promise<{ label: string; url: string }[]> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return (Array.isArray(raw) ? raw : []).flatMap((l: any) => {
      const label = String(l?.label ?? "").trim().slice(0, 60), url = String(l?.url ?? "").trim();
      return label && /^https?:\/\//.test(url) ? [{ label, url: url.slice(0, 2000) }] : [];
    }).slice(0, 20);
  } catch { return []; }
}

export const relayConfigPath = join(homedir(), ".pi", "agent", "pix-remote", "relay.json");

/** Minara's dashboards only belong in Minara sessions. Other links show everywhere. */
const MINARA_LINKS = new Set(["Decision book", "Arena"]);
export const linkFits = (label: string, cwd: string, home = homedir()) => {
  if (!MINARA_LINKS.has(label)) return true;
  const root = join(home, "workspace/minara");
  return cwd === root || cwd.startsWith(root + sep);
};
