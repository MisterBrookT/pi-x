/**
 * Otty supports Kitty graphics and OSC 8 links, though its graphics can disappear
 * in scrollback. Keep inline images as the default rather than silently replacing
 * them with links; that scrollback defect needs a terminal-side fix.
 * Skip remote and multiplexed terminals; do not change their capabilities.
 */
export function ottyCapabilities(env: NodeJS.ProcessEnv = process.env): { images?: "kitty"; hyperlinks?: true } {
  const term = (env.TERM ?? "").toLowerCase();
  if (env.TERM_PROGRAM !== "otty" || env.SSH_CONNECTION || env.TMUX || /^(tmux|screen)/.test(term)) return {};
  return {
    ...(env.PI_IMAGE_PROTOCOL === undefined ? { images: "kitty" as const } : {}),
    ...(env.PI_HYPERLINKS === undefined ? { hyperlinks: true as const } : {}),
  };
}
