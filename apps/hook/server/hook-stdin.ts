/**
 * Utilities for PreToolUse hook stdin/stdout.
 *
 * When a PreToolUse hook fires, Claude Code sends a JSON blob on stdin
 * describing the tool call about to happen. These helpers parse that
 * input and format the deny response that carries user feedback back
 * to the agent.
 */

export interface HookStdinResult {
  /** The original bash command string (e.g. "plannotator annotate foo.md") */
  command: string;
  /** Working directory of the Claude Code session */
  cwd: string;
}

/**
 * Parse PreToolUse hook stdin JSON and extract the Bash command.
 * Throws on malformed input so the hook exits non-zero and
 * Claude Code falls back to running the Bash command directly.
 */
export function parseHookStdin(raw: string): HookStdinResult {
  const data = JSON.parse(raw);
  const command = data?.tool_input?.command;
  if (typeof command !== "string") {
    throw new Error("Missing tool_input.command in hook stdin");
  }
  return {
    command,
    cwd: data.cwd ?? process.cwd(),
  };
}

/**
 * Format a PreToolUse deny decision.
 *
 * "deny" prevents the original Bash command from running (the hook
 * already did all the work). permissionDecisionReason is shown
 * directly to the agent — this is how annotations reach Claude.
 */
export function formatPreToolUseDeny(feedback: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: feedback,
    },
  });
}
