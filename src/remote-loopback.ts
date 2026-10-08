// Pi routes global fetch through http_proxy/https_proxy (EnvHttpProxyAgent), which reads NO_PROXY on
// every request. A local proxy such as Clash answers 502 for 127.0.0.1, so the session could never reach
// its own hub. Exempt loopback so hub traffic stays on the Mac.
const loopback = ["127.0.0.1", "localhost", "::1"];

export function bypassProxyForLoopback(env: NodeJS.ProcessEnv = process.env) {
  const current = env.no_proxy ?? env.NO_PROXY ?? "";
  if (current.trim() === "*") return;
  const entries = current.split(/[\s,]+/).filter(Boolean);
  const missing = loopback.filter(host => !entries.includes(host));
  if (!missing.length) return;
  const next = [...entries, ...missing].join(",");
  env.no_proxy = next;
  env.NO_PROXY = next;
}
