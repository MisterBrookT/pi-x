// Watch one file for appends and call `run` after a short quiet spell. Watches the folder, so it works before
// the file exists and across editors that replace it. While `run` is working, one more call is queued at most.
import { existsSync, mkdirSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

export function watchDocs(file: string, run: () => Promise<unknown>, debounceMs = 300): () => void {
	const dir = dirname(file), name = basename(file);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	let timer: ReturnType<typeof setTimeout> | undefined, busy = false, again = false;
	const fire = async () => {
		if (busy) { again = true; return; }
		busy = true;
		try { await run(); } catch { /* logged by run */ }
		busy = false;
		if (again) { again = false; void fire(); }
	};
	const w = watch(dir, (_e, f) => {
		if (f && String(f) !== name) return;
		clearTimeout(timer);
		timer = setTimeout(fire, debounceMs);
	});
	return () => { clearTimeout(timer); w.close(); };
}
