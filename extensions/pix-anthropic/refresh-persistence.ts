import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const installed = Symbol.for("pix.anthropic.refresh-persistence");

/**
 * Pi 0.84–0.85 passes prompt cancellation through OAuth refresh AND the locked
 * auth.json write. A server-side rotation can succeed just as that write is
 * cancelled. There is no provider hook for the commit boundary, so shield Pix's
 * auth resolution at the public runtime entry point until Pi fixes this upstream.
 *
 * Like OMP's stored-credential refresh, cancel only the caller's wait. Pi still
 * owns locking, the freshness recheck, merging and persistence; no second token
 * store is introduced. Network I/O remains bounded in refreshAnthropicToken.
 * Other providers and inference requests retain their normal cancellation.
 */
export function installRefreshPersistence(): void {
	const original = ModelRuntime.prototype.getAuth;
	if (Reflect.get(original, installed)) return;

	const getAuth: typeof original = function (providerOrModel, overrides = {}) {
		const provider = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const signal = overrides.signal;
		const resolveAuth = original.bind(this);
		if (provider !== "pix-anthropic" || !signal) {
			return typeof providerOrModel === "string"
				? resolveAuth(providerOrModel, overrides)
				: resolveAuth(providerOrModel, overrides);
		}
		if (signal.aborted) return Promise.reject(signal.reason);

		return new Promise((resolve, reject) => {
			const onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			const detached = { ...overrides, signal: undefined };
			const pending = typeof providerOrModel === "string"
				? resolveAuth(providerOrModel, detached)
				: resolveAuth(providerOrModel, detached);
			// Attach both handlers even after cancellation: a late failure must not
			// become an unhandled rejection, nor should a late success be discarded.
			void pending.then(resolve, reject).finally(() => {
				signal.removeEventListener("abort", onAbort);
			});
		});
	};
	Object.defineProperty(getAuth, installed, { value: true });
	ModelRuntime.prototype.getAuth = getAuth;
}
