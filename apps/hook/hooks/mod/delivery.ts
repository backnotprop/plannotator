/**
 * What to do with a decision the CLI published (the host result record,
 * `apps/hook/server/host-result.ts`): submit it to Claude as a plugin turn, or
 * only log a line because there is nothing for Claude to act on.
 *
 * Pure: the controller does the I/O.
 */

export type SessionKind = 'plan' | 'review' | 'annotate' | 'last'

/** The CLI's host result record, version 1 (fields only ever added). */
export interface HostResultRecord {
  v: number
  surface: 'plan' | 'review' | 'annotate' | 'annotate-last'
  decision: 'approved' | 'annotated' | 'dismissed' | 'denied' | 'answered'
  message: string
  noop: boolean
  annotationCount?: number
  platform?: boolean
  withNotes?: boolean
  approvedPlan?: string
  permissionMode?: string
}

/** Feedback longer than this goes to a file Claude reads, never truncated. */
export const INLINE_LIMIT_BYTES = 12 * 1024

/** Added to a plan approval: the approval is completed by Claude's next ExitPlanMode. */
export const PLAN_APPROVAL_NEXT_STEP =
  'Call ExitPlanMode once more with the approved plan, without editing the plan file first; it will be allowed.'

export function parseHostResult(text: string): HostResultRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const surfaces = ['plan', 'review', 'annotate', 'annotate-last']
  const decisions = ['approved', 'annotated', 'dismissed', 'denied', 'answered']
  if (typeof record.v !== 'number' || record.v < 1) return null
  if (typeof record.surface !== 'string' || !surfaces.includes(record.surface)) return null
  if (typeof record.decision !== 'string' || !decisions.includes(record.decision)) return null
  if (typeof record.message !== 'string' || typeof record.noop !== 'boolean') return null
  return record as unknown as HostResultRecord
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** The outcome as the plugin turn's first line names it. */
export function outcomeOf(record: HostResultRecord): string {
  const count = record.annotationCount
  const comments = typeof count === 'number' && count > 0 ? ` · ${plural(count, 'comment', 'comments')}` : ''
  switch (record.decision) {
    case 'approved':
      if (record.surface === 'plan') return record.withNotes ? 'Approved with notes' : 'Approved'
      return record.noop ? 'Approved' : `Approved with notes${comments}`
    case 'answered':
      return 'Questions answered'
    case 'denied':
      return 'Changes requested'
    case 'dismissed':
      return 'Closed. No decision.'
    case 'annotated':
      return record.surface === 'review' ? `Changes requested${comments}` : `Feedback${comments}`
  }
}

export type Delivery =
  | { action: 'submit'; text: string; overflow?: { path: string; text: string } }
  | { action: 'log'; text: string; suggest?: string }

export interface DeliveryContext {
  subject: string
  /** Where the full text is written when it is over the inline limit. */
  overflowPath: string
  inlineLimitBytes?: number
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Decide the delivery. Done / LGTM / Close never start a turn (a log line
 * instead); a review posted straight to a PR platform logs and suggests the
 * follow-up; everything else is submitted, prefixed with one line naming the
 * subject and outcome, and moved to a file Claude reads when it is too long.
 */
export function deliveryFor(record: HostResultRecord, context: DeliveryContext): Delivery {
  const { subject } = context

  if (record.surface === 'review' && record.platform) {
    const posted = record.message.trim() || 'review posted'
    return {
      action: 'log',
      text: `${posted[0]?.toUpperCase() ?? ''}${posted.slice(1)}. Nothing was sent to Claude.`,
      suggest: `address the review comments on ${subject}`,
    }
  }

  if (record.noop) {
    const what = record.decision === 'approved' ? 'approved with no notes' : 'closed with no annotations'
    return { action: 'log', text: `${subject} ${what}. Nothing was sent to Claude.` }
  }

  const prefix = `Plannotator: ${subject} — ${outcomeOf(record)}.`
  const nextStep = record.surface === 'plan' && record.decision === 'approved' ? `\n\n${PLAN_APPROVAL_NEXT_STEP}` : ''
  const body = record.message.trim()
  const inline = `${prefix}\n\n${body}${nextStep}`
  const limit = context.inlineLimitBytes ?? INLINE_LIMIT_BYTES

  if (byteLength(body) <= limit) return { action: 'submit', text: inline }

  const kb = Math.ceil(byteLength(body) / 1024)
  const counts = typeof record.annotationCount === 'number' && record.annotationCount > 0
    ? `, ${plural(record.annotationCount, 'annotation', 'annotations')}`
    : ''
  return {
    action: 'submit',
    text: `${prefix}\n\nThe full feedback (${kb} KB${counts}) is too long to include here. Read all of it with the Read tool before you continue: ${context.overflowPath}${nextStep}`,
    overflow: { path: context.overflowPath, text: `${body}\n` },
  }
}

/**
 * A CLI that predates the host result file (the plugin and the binary update
 * separately): what it printed on stdout, the text the skill would have shown
 * Claude. Empty output, or the legacy close/approve lines, carry nothing.
 */
export function legacyResult(kind: SessionKind, printed: string): HostResultRecord {
  const surface = kind === 'review' ? 'review' : kind === 'last' ? 'annotate-last' : 'annotate'
  const text = printed.trim()
  if (!text || text === 'Review session closed without feedback.') {
    return { v: 1, surface, decision: 'dismissed', message: '', noop: true }
  }
  if (text === 'The user approved.') return { v: 1, surface, decision: 'approved', message: '', noop: true }
  return { v: 1, surface, decision: 'annotated', message: text, noop: false }
}
