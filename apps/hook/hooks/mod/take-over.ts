/**
 * Claude running the `plannotator` CLI through Bash, answered by the mod.
 *
 * The skill and the tool steer Claude to the `plannotator` tool, but a model
 * that reaches for `plannotator annotate x.md --gate --json` in Bash would
 * otherwise block the session on the CLI and give Ask AI a separate AI. When
 * the command is one the tool can represent (`plannotatorCommandToToolInput`
 * in tool.ts decides, host-neutral), the `tool.call` hook answers the Bash call
 * with the tool's own launch and result text; the command never runs. Anything
 * else (strict gates, pipelines, unknown flags, a dev build run by path) runs
 * as written.
 *
 * Main loop only: a subagent may run in its own cwd or worktree, while the
 * mod launches in the session's cwd, so its `review` or `annotate notes.md`
 * would open the wrong diff or file. A subagent's command runs for real.
 */

import { plannotatorCommandToToolInput, type PlannotatorToolInput } from './tool'

/** Claude Code's shell tool. */
export const SHELL_TOOL = 'Bash'

/** The tool input a main-loop Bash call's command stands for; null runs it as written. */
export function shellTakeOver(command: unknown, fromSubagent: boolean): PlannotatorToolInput | null {
  if (fromSubagent || typeof command !== 'string') return null
  return plannotatorCommandToToolInput(command)
}

/** The Bash tool's result record, carrying the tool's text as the command's output. */
export interface ShellResult {
  stdout: string
  stderr: string
  interrupted: boolean
}

/** Open through the tool's launch; the tool's text becomes the Bash result, its error a deny. */
export async function answerShellCall(
  mod: { runTool(input: unknown): Promise<{ text: string } | { deny: string }> },
  input: PlannotatorToolInput,
): Promise<{ result: ShellResult } | { deny: string }> {
  const answer = await mod.runTool(input)
  return 'deny' in answer ? { deny: answer.deny } : { result: { stdout: answer.text, stderr: '', interrupted: false } }
}
