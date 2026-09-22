import { resolve } from "node:path";
import { InteractiveMode, type AgentSession } from "@earendil-works/pi-coding-agent";
import { openInBrowser } from "./context.ts";

interface ExportMode {
  session: Pick<AgentSession, "exportToHtml" | "state" | "systemPrompt">;
  handleExportCommand(text: string): Promise<void>;
  showStatus(text: string): void;
}
const installed = Symbol.for("pix.export.browser");
type ExportPrototype = ExportMode & { [installed]?: { open: typeof openInBrowser } };

/** Pi handles /export before extension commands or input hooks. Keep its native
 * handler, parser, theme, and tool rendering; observe only successful HTML exports.
 * This narrow TUI adapter is covered against the installed Pi implementation.
 */
export function installBrowserExport(
  prototype = InteractiveMode.prototype as unknown as ExportPrototype,
  open = openInBrowser,
): void {
  if (prototype[installed]) { prototype[installed].open = open; return; }
  const original = prototype.handleExportCommand;
  if (typeof original !== "function") throw new Error("Pi's native /export handler is unavailable");
  const state = { open };
  const pending = new WeakMap<ExportMode, Promise<void>>();
  prototype.handleExportCommand = function(text) {
    // Serialize repeated submissions so temporary capture hooks cannot overlap.
    const run = async () => {
      const session = this.session;
      const descriptor = Object.getOwnPropertyDescriptor(session, "exportToHtml");
      const exportHtml = session.exportToHtml;
      let path: string | undefined;
      session.exportToHtml = async (...args) => {
        // Pi's exporter reads state.systemPrompt, which can be empty/stale on
        // resume or after tool changes. Export a current snapshot without
        // changing the live agent or rewriting any prompt text.
        const snapshot = new Proxy(session, {
          get(target, key) {
            if (key === "state") return { ...target.state, systemPrompt: target.systemPrompt };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const result = await exportHtml.apply(snapshot, args);
        path = result;
        return result;
      };
      try { await original.call(this, text); }
      finally {
        if (descriptor) Object.defineProperty(session, "exportToHtml", descriptor);
        else Reflect.deleteProperty(session, "exportToHtml");
      }
      if (!path) return; // JSONL and failed exports never open a browser.
      let opened = false;
      try { opened = await state.open(resolve(path)); } catch { /* The HTML remains usable. */ }
      this.showStatus(opened ? "Export opened in your browser." : `Could not open the browser. HTML saved at: ${path}`);
    };
    const next = (pending.get(this) ?? Promise.resolve()).then(run, run);
    pending.set(this, next);
    return next;
  };
  prototype[installed] = state;
}

export default function registerExport(): void {
  installBrowserExport();
}
