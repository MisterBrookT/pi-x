/**
 * Network guard for every outbound request the web tools make.
 *
 * A URL supplied by a model or a webpage must never reach a private service.
 * The defence has three parts, and all of them matter:
 *
 *   1. Only http/https, never a loopback hostname.
 *   2. Resolve DNS with `all: true` and reject unless *every* answer is
 *      public. Checking one address invites DNS rebinding, where a second
 *      answer points at 127.0.0.1.
 *   3. Follow redirects manually and revalidate each hop, since a public
 *      host may redirect straight to an internal one.
 *
 * `allowRanges` is a deliberate escape hatch for TUN/fake-IP proxies whose
 * synthetic addresses (typically 198.18.0.0/15) would otherwise be blocked.
 */

import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface Cidr {
  bytes: Uint8Array;
  prefix: number;
}

export interface GuardOptions {
  /** CIDR strings or bare IPs exempt from the private-address checks. */
  allowRanges?: Cidr[];
  /** Injected for tests; defaults to the system resolver. */
  lookup?: (hostname: string) => Promise<{ address: string }[]>;
}

/** Lower-case, strip IPv6 brackets and the root-zone trailing dot. */
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** 198.18.0.0/15, the range TUN/fake-IP proxies hand out. */
function isFakeIpProxyAddress(a: number, b: number): boolean {
  return a === 198 && (b === 18 || b === 19);
}

/** Private, loopback, link-local, multicast, or malformed IPv4. */
export function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    isFakeIpProxyAddress(a, b) ||
    a >= 224
  );
}

/** Expand an IPv6 literal to eight groups, or null when malformed. */
export function parseIPv6(address: string): number[] | null {
  let text = address;
  // A trailing dotted quad (::ffff:127.0.0.1) becomes two hex groups.
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    const ipv4 = text.slice(lastColon + 1);
    if (net.isIP(ipv4) !== 4) return null;
    const o = ipv4.split(".").map(Number);
    text = `${text.slice(0, lastColon)}:${(((o[0] as number) << 8) | (o[1] as number)).toString(16)}:${(((o[2] as number) << 8) | (o[3] as number)).toString(16)}`;
  }
  const pieces = text.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? (pieces[0] as string).split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? (pieces[1] as string).split(":") : [];
  const missing = 8 - left.length - right.length;
  if (pieces.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...left, ...Array(pieces.length === 2 ? missing : 0).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    out.push(Number.parseInt(group, 16));
  }
  return out;
}

/** Unspecified, loopback, unique-local, link-local, or mapped-private IPv6. */
export function isBlockedIPv6(address: string): boolean {
  const groups = parseIPv6(address);
  if (!groups) return true;
  const first = groups[0] as number;
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  // An IPv4-mapped address must face the IPv4 rules, or ::ffff:10.0.0.1 slips through.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const g6 = groups[6] as number;
    const g7 = groups[7] as number;
    return isBlockedIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join("."));
  }
  return false;
}

function addressBytes(address: string, version: number): Uint8Array | null {
  if (version === 4) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return Uint8Array.from(parts);
  }
  const groups = parseIPv6(address);
  if (!groups) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  });
  return bytes;
}

/** Parse `10.0.0.0/8` or a bare IP into network bytes plus a prefix length. */
export function parseCidr(entry: string): Cidr {
  if (typeof entry !== "string" || !entry.trim()) throw new Error("ssrf.allowRanges entries must be non-empty strings");
  const [address, prefixText, ...rest] = entry.trim().split("/");
  if (rest.length > 0) throw new Error(`Invalid CIDR in ssrf.allowRanges: ${entry}`);
  const version = net.isIP(address as string);
  if (version === 0) throw new Error(`Invalid address in ssrf.allowRanges: ${entry}`);
  const maxPrefix = version === 4 ? 32 : 128;
  let prefix = maxPrefix;
  if (prefixText !== undefined) {
    if (!/^\d{1,3}$/.test(prefixText)) throw new Error(`Invalid CIDR prefix in ssrf.allowRanges: ${entry}`);
    prefix = Number(prefixText);
    if (prefix < 1 || prefix > maxPrefix) throw new Error(`Invalid CIDR prefix in ssrf.allowRanges: ${entry}`);
  }
  const bytes = addressBytes(address as string, version);
  if (!bytes) throw new Error(`Invalid address in ssrf.allowRanges: ${entry}`);
  return { bytes, prefix };
}

export function parseAllowRanges(entries: unknown): Cidr[] {
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) throw new Error("ssrf.allowRanges must be an array of CIDR strings");
  return entries.map((entry) => parseCidr(entry as string));
}

function inRange(address: string, version: number, ranges: Cidr[]): boolean {
  if (ranges.length === 0) return false;
  const bytes = addressBytes(address, version);
  if (!bytes) return false;
  for (const range of ranges) {
    if (range.bytes.length !== bytes.length) continue;
    let bits = range.prefix;
    let matched = true;
    for (let i = 0; matched && bits > 0; i++) {
      const take = Math.min(8, bits);
      const mask = (0xff << (8 - take)) & 0xff;
      if (((bytes[i] as number) & mask) !== ((range.bytes[i] as number) & mask)) matched = false;
      bits -= take;
    }
    if (matched) return true;
  }
  return false;
}

/** Throw unless `address` is a routable public IP. */
export function assertPublicAddress(address: string, hostname: string, allowRanges: Cidr[] = []): void {
  const normalized = normalizeHostname(address);
  const version = net.isIP(normalized);
  if (version === 0) throw new Error(`Resolved non-IP address for ${hostname}: ${address}`);
  if (inRange(normalized, version, allowRanges)) return;
  if (version === 4 && isBlockedIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    const hint = isFakeIpProxyAddress(parts[0] as number, parts[1] as number)
      ? '. This address is in 198.18.0.0/15, commonly used by TUN/fake-IP proxies. Add ["198.18.0.0/15"] to ssrf.allowRanges in web-search.json if that matches your setup.'
      : "";
    throw new Error(`Blocked internal address for ${hostname}: ${normalized}${hint}`);
  }
  if (version === 6 && isBlockedIPv6(normalized)) {
    throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
  }
}

/** Resolve and vet a URL, returning it only when every answer is public. */
export async function validateRemoteUrl(rawUrl: string | URL, options: GuardOptions = {}): Promise<URL> {
  const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs can be fetched remotely");
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new Error("URL must include a hostname");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`Blocked internal hostname: ${hostname}`);
  }
  const allowRanges = options.allowRanges ?? [];
  if (net.isIP(hostname)) {
    assertPublicAddress(hostname, hostname, allowRanges);
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await (options.lookup ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true })))(hostname);
  } catch (error) {
    throw new Error(`Failed to resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
  // Every answer, not just the first: one private record is enough to rebind.
  for (const { address } of addresses) assertPublicAddress(address, hostname, allowRanges);
  return url;
}

export interface FetchOptions extends GuardOptions {
  fetch?: typeof fetch;
  maxRedirects?: number;
}

/** Fetch with each redirect hop revalidated against the same rules. */
export async function fetchRemoteUrl(
  url: string | URL,
  init: RequestInit = {},
  options: FetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let current = await validateRemoteUrl(url, options);
  let requestInit = init;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetchImpl(current, { ...requestInit, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (hop === maxRedirects) throw new Error(`Too many redirects fetching ${current.toString()}`);
    current = await validateRemoteUrl(new URL(location, current), options);
    const method = requestInit.method?.toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      const { body: _body, ...rest } = requestInit;
      requestInit = { ...rest, method: "GET" };
    }
  }
  throw new Error(`Too many redirects fetching ${current.toString()}`);
}
