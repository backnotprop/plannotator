import { isAbsolutePath } from './paths'

export const PLAN_TOOL = 'ExitPlanMode'

export const MAX_PLAN_FILE_BYTES = 2 * 1024 * 1024

export function isTrustablePlanPath(path: unknown): path is string {
  return typeof path === 'string' && isAbsolutePath(path) && /\.md$/i.test(path)
}

export function normalizePlanForHash(plan: string): string {
  return plan.replace(/\s+$/, '')
}

export interface PendingApproval {
  hash: string
  plan: string
  permissionMode?: string
  version: number
}

export interface OpenPlanReview {
  launchId: string
  dir: string
  version: number
  revisionSeq: number
  url?: string
}

export type PlanCallAction =
  | { kind: 'pass-approved'; approval: PendingApproval }
  | { kind: 'revise'; review: OpenPlanReview }
  | { kind: 'start' }

export function planCallAction(
  planHash: string,
  state: { approval: PendingApproval | null; open: OpenPlanReview | null },
): PlanCallAction {
  if (state.approval && state.approval.hash === planHash) return { kind: 'pass-approved', approval: state.approval }
  if (state.open) return { kind: 'revise', review: state.open }
  return { kind: 'start' }
}

export const PLAN_APPROVALS_DIR = 'plan-approvals'
export const PLAN_APPROVAL_RECORD_VERSION = 1

export interface PlanApprovalRecord {
  v: typeof PLAN_APPROVAL_RECORD_VERSION
  hash: string
  plan: string
  permissionMode?: string
  at: number
}

export function planApprovalRecord(approval: PendingApproval, at: number): PlanApprovalRecord {
  return {
    v: PLAN_APPROVAL_RECORD_VERSION,
    hash: approval.hash,
    plan: approval.plan,
    ...(approval.permissionMode ? { permissionMode: approval.permissionMode } : {}),
    at,
  }
}

export function approvedPermissionDecision(toolInput: unknown, approval: PendingApproval) {
  const input = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {}
  return {
    behavior: 'allow' as const,
    updatedInput: { ...input, plan: approval.plan },
    ...(approval.permissionMode
      ? { updatedPermissions: [{ type: 'setMode' as const, mode: approval.permissionMode, destination: 'session' as const }] }
      : {}),
  }
}

export function waitingDenyText(version: number, url?: string): string {
  const where = url ? ` (${url})` : ''
  return `Plan v${version} is open in Plannotator for the user's review${where}. It is NOT approved. Stay in plan mode and do not implement. End your turn. The user's decision will arrive as a message from the plannotator plugin. Until then you may answer questions, and you may revise the plan by calling ExitPlanMode again.`
}

export function revisedDenyText(version: number): string {
  return `Plan v${version} replaced v${version - 1} in the open review. Still not approved. End your turn and wait for the decision.`
}

export function unchangedDenyText(version: number): string {
  return `Plan v${version} is unchanged and still in review. It is NOT approved. End your turn and wait for the decision.`
}

export function decidingDenyText(): string {
  return 'The user is recording a decision on the plan in Plannotator right now, so this revision was not added. It is NOT approved. End your turn and wait for the decision message from the plannotator plugin.'
}

export function revisionPendingDenyText(version: number): string {
  return `Plan v${version} was sent to the open Plannotator review. It is NOT approved. End your turn and wait for the decision.`
}

export function cliLacksModPlan(stderr: string): boolean {
  return /Unknown command: claude-mod-plan\b/.test(stderr) || /No plan content in hook event/.test(stderr)
}

export const CLASSIC_PLAN_REVIEW_TEXT =
  'Your plannotator CLI is older than the Plannotator plugin and has no non-blocking plan review, so plans open in the classic review, which holds this session until you decide. Update the CLI (curl -fsSL https://plannotator.ai/install.sh | bash, or on Windows irm https://plannotator.ai/install.ps1 | iex) and start or resume a session to get non-blocking plan review.'

export const CLASSIC_PLAN_RETRY_TEXT =
  "The plan review did not open: the user's plannotator CLI is older than the Plannotator plugin and has no non-blocking plan review. The plan is NOT approved. Call ExitPlanMode again with the same plan; it will open in the classic review."

export function planWaitingStatus(version: number): string {
  return `Plan v${version} · waiting for your review`
}
