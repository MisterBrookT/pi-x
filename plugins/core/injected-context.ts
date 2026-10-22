/**
 * Text that plugins add to the system prompt per request (before_agent_start). Pi keeps no copy of it in the
 * session, so Pi's /export and ctx.getSystemPrompt() never show it. Plugins register a provider here, and
 * /context html renders each one as its own section. Shared through globalThis: plugins load in separate jiti graphs.
 */
type Provider = (ctx: unknown) => string | undefined | Promise<string | undefined>;
const KEY = Symbol.for("pix.injectedContext");
const reg = ((globalThis as any)[KEY] ??= new Map<string, Provider>()) as Map<string, Provider>;

export const setInjected = (name: string, provider: Provider) => { reg.set(name, provider); };
export async function injectedSections(ctx: unknown): Promise<{ name: string; text: string }[]> {
	const out: { name: string; text: string }[] = [];
	for (const [name, p] of reg) { try { const text = await p(ctx); if (text?.trim()) out.push({ name, text }); } catch { /* a broken provider never breaks the export */ } }
	return out;
}
