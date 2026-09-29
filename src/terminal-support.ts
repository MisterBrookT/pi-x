/**
 * Pi picks inline image and link support from the terminal's name, and it does not know Otty yet,
 * so images show as file paths. Otty supports Kitty graphics and OSC 8 links. Decide here from the
 * process environment, so it works however Pi was started (fresh shell, script, phone launch).
 * Skipped over SSH and inside tmux/screen, and never overrides an explicit PI_* setting.
 */
export function ottyCapabilities(env: NodeJS.ProcessEnv = process.env): { images?: "kitty"; hyperlinks?: true } {
  const term = (env.TERM ?? "").toLowerCase();
  if (env.TERM_PROGRAM !== "otty" || env.SSH_CONNECTION || env.TMUX || /^(tmux|screen)/.test(term)) return {};
  return {
    ...(env.PI_IMAGE_PROTOCOL === undefined ? { images: "kitty" as const } : {}),
    ...(env.PI_HYPERLINKS === undefined ? { hyperlinks: true as const } : {}),
  };
}
