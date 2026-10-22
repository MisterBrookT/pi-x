/** Wire helpers for proxy accounts (cliproxy): swap the auth header, map undated model ids. Routing lives in accountkit.ts. */
/** Headers for the proxy: same Anthropic headers, the proxy key instead of brook's token. */
export function proxyHeaders(h: Record<string, string>, key: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(h)) if (!/^(authorization|x-api-key)$/i.test(k)) out[k] = v;
	out.authorization = `Bearer ${key}`;
	return out;
}

/** cliproxy only knows dated ids for some older models. */
const DATED: Record<string, string> = {
	"claude-haiku-4-5": "claude-haiku-4-5-20251001",
	"claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
	"claude-opus-4-5": "claude-opus-4-5-20251101",
	"claude-opus-4-1": "claude-opus-4-1-20250805",
	"claude-sonnet-4": "claude-sonnet-4-20250514",
	"claude-opus-4": "claude-opus-4-20250514",
};
export function proxyBody(serialized: string): string {
	const m = serialized.match(/"model":"([^"]+)"/);
	return m && DATED[m[1]] ? serialized.replace(m[0], `"model":"${DATED[m[1]]}"`) : serialized;
}
