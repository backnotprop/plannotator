import { plannotatorCommandToToolInput, type PlannotatorToolInput } from './tool'

export const SHELL_TOOL = 'Bash'

export function shellTakeOver(command: unknown, fromSubagent: boolean): PlannotatorToolInput | null {
  if (fromSubagent || typeof command !== 'string') return null
  return plannotatorCommandToToolInput(command, { tailscale: true })
}

export interface ShellResult {
  stdout: string
  stderr: string
  interrupted: boolean
}

export async function answerShellCall(
  mod: { runTool(input: unknown): Promise<{ text: string } | { deny: string }> },
  input: PlannotatorToolInput,
): Promise<{ result: ShellResult } | { deny: string }> {
  const answer = await mod.runTool(input)
  return 'deny' in answer ? { deny: answer.deny } : { result: { stdout: answer.text, stderr: '', interrupted: false } }
}
