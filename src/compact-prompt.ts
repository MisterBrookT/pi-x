const groups = [
  {
    replacement: "- Use subagents only for genuinely independent work; keep one writer per worktree.",
    prefixes: [
      "- Use subagent only when delegation is needed.",
      "- Omit action for execution;",
      "- workflowScript rejects nested async function,",
      "- Inside workflowScript, use runs.run/runs.all",
      "- Keep one writer per cwd/worktree;",
    ],
  },
  {
    replacement: "- Use LSP for targeted diagnostics or source actions when configured.",
    prefixes: [
      "- Use lsp_diagnostics when files need diagnostics",
      "- Use the server parameter only when",
      "- If a configured server command is missing,",
      "- Use lsp_fix for files handled",
      "- Use kind when the server needs",
    ],
  },
] as const;

export function compactPixPrompt(prompt: string): string {
  const inserted = new Set<number>();
  const output: string[] = [];
  for (const line of prompt.split("\n")) {
    const groupIndex = groups.findIndex((group) => group.prefixes.some((prefix) => line.startsWith(prefix)));
    if (groupIndex < 0) {
      output.push(line);
      continue;
    }
    if (!inserted.has(groupIndex)) {
      output.push(groups[groupIndex].replacement);
      inserted.add(groupIndex);
    }
  }
  return output.join("\n");
}
