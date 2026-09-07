import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

/** Braille frames pi-subagents renders for running work (tui/render.ts RUNNING_FRAMES). */
export const SUBAGENT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Pi's own working indicator cadence (pi-tui loader DEFAULT_INTERVAL_MS). */
export const SUBAGENT_SPINNER_INTERVAL_MS = 80;
/** Widget keys owned by pi-subagents that render running spinners. */
const ANIMATED_WIDGET_KEYS = new Set(["subagent-async", "subagent-fleet-status"]);

export const spinnerFrameStep = (now: number, intervalMs = SUBAGENT_SPINNER_INTERVAL_MS): number =>
  Math.floor(now / intervalMs);

/** Use one animation clock; adding upstream's slower frame would skip frames. */
export const advanceSpinnerFrames = (line: string, steps: number): string => {
  const count = SUBAGENT_SPINNER_FRAMES.length;
  const frame = SUBAGENT_SPINNER_FRAMES[((steps % count) + count) % count];
  return [...line].map(character => SUBAGENT_SPINNER_FRAMES.includes(character) ? frame : character).join("");
};

export const hasSpinnerFrame = (lines: string[]): boolean =>
  lines.some(line => [...line].some(character => SUBAGENT_SPINNER_FRAMES.includes(character)));

type WidgetFactory = (tui: TUI, theme: ExtensionContext["ui"]["theme"]) => Component & { dispose?(): void };

interface SpinnerTimers {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  now: () => number;
}

const defaultTimers: SpinnerTimers = { setInterval, clearInterval, now: Date.now };

/**
 * Repaint an existing subagent widget at pi's native spinner cadence.
 * The upstream component caches its lines per 1s frame, so the animation is
 * applied to the rendered output instead of re-collecting fleet state.
 */
export const animateSubagentWidget = (
  factory: WidgetFactory,
  { intervalMs = SUBAGENT_SPINNER_INTERVAL_MS, timers = defaultTimers }: { intervalMs?: number; timers?: SpinnerTimers } = {},
): WidgetFactory => (tui, theme) => {
  const inner = factory(tui, theme);
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => {
    if (!timer) return;
    timers.clearInterval(timer);
    timer = undefined;
  };
  const startTimer = () => {
    if (timer) return;
    timer = timers.setInterval(() => tui.requestRender(), intervalMs);
    timer.unref?.();
  };
  const overrides = {
    render: (width: number) => {
      const lines = inner.render(width);
      if (!hasSpinnerFrame(lines)) {
        stopTimer();
        return lines;
      }
      startTimer();
      const steps = spinnerFrameStep(timers.now(), intervalMs);
      return lines.map(line => advanceSpinnerFrames(line, steps));
    },
    invalidate: () => inner.invalidate?.(),
    dispose: () => {
      stopTimer();
      inner.dispose?.();
    },
  };
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "render" || property === "invalidate" || property === "dispose") return overrides[property];
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const animatedContexts = new WeakMap<object, ExtensionContext>();
const animatedUis = new WeakMap<object, ExtensionContext["ui"]>();

/**
 * Wrap an extension context so pi-subagents widgets animate at the native cadence.
 * Wrappers are cached per underlying object because upstream compares context and
 * ui identity to decide when to re-register widgets.
 */
export function withAnimatedSubagentWidgets(ctx: ExtensionContext): ExtensionContext {
  if (!ctx || typeof ctx !== "object" || ctx.mode !== "tui") return ctx;
  const cachedContext = animatedContexts.get(ctx);
  if (cachedContext) return cachedContext;
  const animated = new Proxy(ctx, {
    get(target, property, receiver) {
      if (property !== "ui") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      const ui = target.ui;
      if (!ui) return ui;
      const cachedUi = animatedUis.get(ui);
      if (cachedUi) return cachedUi;
      const wrappedUi = new Proxy(ui, {
        get(uiTarget, uiProperty, uiReceiver) {
          if (uiProperty !== "setWidget") {
            const value = Reflect.get(uiTarget, uiProperty, uiReceiver);
            return typeof value === "function" ? value.bind(uiTarget) : value;
          }
          return (key: string, content: unknown, options?: unknown) => {
            const wrapped = ANIMATED_WIDGET_KEYS.has(key) && typeof content === "function"
              ? animateSubagentWidget(content as WidgetFactory)
              : content;
            return (uiTarget.setWidget as (key: string, content: unknown, options?: unknown) => void)(key, wrapped, options);
          };
        },
      });
      animatedUis.set(ui, wrappedUi);
      return wrappedUi;
    },
  });
  animatedContexts.set(ctx, animated);
  return animated;
}
