/**
 * Non-blocking plan review: the decisions behind the `tool.call` hook on
 * ExitPlanMode and the `classic.PermissionRequest` answer. Pure.
 */

/** Claude Code's plan-mode tool. */
export const PLAN_TOOL = 'ExitPlanMode'

/** The annotate cap the CLI applies to a plan file it trusts (MAX_ANNOTATABLE_FILE_BYTES). */
export const MAX_PLAN_FILE_BYTES = 2 * 1024 * 1024

/**
 * Whether the plan file named by ExitPlanMode may be read instead of its
 * inline `plan` (the #1667 stale-snapshot fix, mirrored from
 * `apps/hook/server/claude-plan.ts`): an absolute `.md` path.
 * The caller also requires a regular file within MAX_PLAN_FILE_BYTES.
 */
export function isTrustablePlanPath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && /\.md$/i.test(path)
}

/** Hash input: trailing whitespace is not a different plan. */
export function normalizePlanForHash(plan: string): string {
  return plan.replace(/\s+$/, '')
}

/** The approval the reviewer gave, waiting for Claude's next ExitPlanMode. */
export interface PendingApproval {
  hash: string
  plan: string
  permissionMode?: string
  version: number
}

/** The open review of this session, if any. */
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

/** What an ExitPlanMode call does, given the session's plan review state. */
export function planCallAction(
  planHash: string,
  state: { approval: PendingApproval | null; open: OpenPlanReview | null },
): PlanCallAction {
  if (state.approval && state.approval.hash === planHash) return { kind: 'pass-approved', approval: state.approval }
  if (state.open) return { kind: 'revise', review: state.open }
  return { kind: 'start' }
}

/** The `classic.PermissionRequest` decision that lets the approved plan through. */
export function approvedPermissionDecision(toolInput: unknown, approval: PendingApproval) {
  const input = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {}
  return {
    behavior: 'allow' as const,
    // Claude Code drops an ExitPlanMode allow without updatedInput (>= 2.1.199);
    // carry the approved text so execution starts from what the reviewer saw.
    updatedInput: { ...input, plan: approval.plan },
    ...(approval.permissionMode
      ? { updatedPermissions: [{ type: 'setMode' as const, mode: approval.permissionMode, destination: 'session' as const }] }
      : {}),
  }
}

// --- Copy (what Claude reads in the denied ExitPlanMode result) -----------

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

/** Shown in the status line and toasts. */
export function planWaitingStatus(version: number): string {
  return `Plan v${version} · waiting for your review`
}
