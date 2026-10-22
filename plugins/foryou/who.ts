/** The person behind a loop: name, source app, and their id in that app when the chat gives it. */
import { sourceOf, type Who } from "../core/avatarkit.ts";

/** sourceKey "wechat:wxid_x" in a private chat names the person directly; groups only give the name. */
export function whoFor(name: string, kind: string, sourceKey = ""): Who {
	const source = sourceOf({ kind, sourceKey });
	const id = source === "wechat" && /^wechat:wxid_[^@]+$/.test(sourceKey) ? sourceKey.slice(7) : undefined;
	return { name: name.trim().slice(0, 40), source, ...(id ? { id } : {}) };
}

const ROLE = /^(Website|Kairos|X|Pi|For you|Review|Fix|Add|Test|Run)$/i;
/** Backfill for loops made before `who`: "陈老师: …" at the start of the title, else a known person named in title/why. */
export function guessWho(it: { title?: string; why?: string; prepared?: string; source?: string; sourceKey?: string; kind?: string }, people: string[]): Who | undefined {
	const t = String(it.title ?? ""), body = `${it.why ?? ""} ${it.prepared ?? ""}`;
	const head = t.match(/^([^:：\s]{1,12})[:：]/)?.[1];
	const first = (text: string) => people.filter(p => text.includes(p)).sort((a, b) => text.indexOf(a) - text.indexOf(b))[0];
	const name = head && !ROLE.test(head) ? head : first(t) ?? first(body);
	return name ? whoFor(name, it.kind ?? it.source ?? "", it.sourceKey) : undefined;
}
