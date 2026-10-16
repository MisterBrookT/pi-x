import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Open a file or URL in the desktop browser. False if that failed. */
export const openInBrowser = async (path: string, run = promisify(execFile)): Promise<boolean> => {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	try {
		await run(command, [path]);
		return true;
	} catch {
		return false;
	}
};
