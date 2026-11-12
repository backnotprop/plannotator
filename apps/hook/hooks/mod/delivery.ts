import { PLANNOTATOR_OUTCOME_REVIEW_POSTED, plannotatorDecisionHeading, type PlannotatorTarget } from './tool'

export type SessionKind = 'plan' | 'review' | 'annotate' | 'last'

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
  closedBy?: 'agent'
  unsentAnnotations?: number
  target?: string | string[]
}

function targetOf(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    return value as string[]
  }
  return undefined
}

export const INLINE_LIMIT_BYTES = 12 * 1024

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
  const { target: rawTarget, ...rest } = record
  const target = targetOf(rawTarget)
  return { ...(rest as unknown as HostResultRecord), ...(target !== undefined ? { target } : {}) }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

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
  sessionId?: string
  overflowPath: string
  inlineLimitBytes?: number
  deliverApproval?: boolean
  target?: PlannotatorTarget
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

const PLATFORM_STATUS_LINE = /^(?:(?:Pull request|Merge request) (?:approved|reviewed) on |Changes requested on )/

export function isPlatformStatusLine(message: string): boolean {
  return PLATFORM_STATUS_LINE.test(message.trim())
}

function misreadAsPlatformPost(record: HostResultRecord): boolean {
  return record.surface === 'review' && record.platform === true && record.message.trim() !== '' && !isPlatformStatusLine(record.message)
}

export function deliveryFor(record: HostResultRecord, context: DeliveryContext): Delivery {
  const { subject } = context

  if (record.closedBy === 'agent') {
    const unsent = record.unsentAnnotations
    const saved = typeof unsent === 'number' && unsent > 0 ? ` ${unsent} unsent ${unsent === 1 ? 'comment' : 'comments'} kept in the draft.` : ''
    return { action: 'log', text: `Claude closed ${subject}.${saved} Nothing was sent to Claude.` }
  }

  const platformPost = record.surface === 'review' && record.platform === true && isPlatformStatusLine(record.message)
  if (platformPost && context.deliverApproval === true) {
    const heading = plannotatorDecisionHeading(subject, context.sessionId, PLANNOTATOR_OUTCOME_REVIEW_POSTED, record.target ?? context.target)
    return { action: 'submit', text: `${heading}\n\n${record.message.trim()}` }
  }
  if (platformPost) {
    const posted = record.message.trim() || 'review posted'
    return {
      action: 'log',
      text: `${posted[0]?.toUpperCase() ?? ''}${posted.slice(1)}. Nothing was sent to Claude.`,
      suggest: `address the review comments on ${subject}`,
    }
  }

  const approvalAwaited = context.deliverApproval === true && record.decision === 'approved'
  if (record.noop && !approvalAwaited && !misreadAsPlatformPost(record)) {
    const what = record.decision === 'approved' ? 'approved with no notes' : 'closed with no annotations'
    return { action: 'log', text: `${subject} ${what}. Nothing was sent to Claude.` }
  }

  const prefix = plannotatorDecisionHeading(subject, context.sessionId, outcomeOf(record), record.target ?? context.target)
  const nextStep = record.surface === 'plan' && record.decision === 'approved' ? `\n\n${PLAN_APPROVAL_NEXT_STEP}` : ''
  const body = record.message.trim()
  const inline = body ? `${prefix}\n\n${body}${nextStep}` : `${prefix}${nextStep}`
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

export const LEGACY_REVIEW_APPROVED_TEXT = '# Code Review\n\nCode review completed — no changes requested.'
export const LEGACY_REVIEW_APPROVED_WITH_NOTES_HEADING = '# Code Review — Approved with Notes'

export const LEGACY_ANNOTATE_APPROVED_WITH_NOTES_HEADING = '# Approved with Notes'

export const LEGACY_ANNOTATE_NO_FEEDBACK_TEXTS: readonly string[] = [
  'User reviewed the document and has no feedback.',
  'User reviewed the messages and has no feedback.',
]

export function legacyResult(kind: SessionKind, printed: string): HostResultRecord {
  const surface = kind === 'review' ? 'review' : kind === 'last' ? 'annotate-last' : 'annotate'
  const text = printed.trim()
  if (!text || text === 'Review session closed without feedback.') {
    return { v: 1, surface, decision: 'dismissed', message: '', noop: true }
  }
  if (text === 'The user approved.') return { v: 1, surface, decision: 'approved', message: '', noop: true }
  if (surface !== 'review' && LEGACY_ANNOTATE_NO_FEEDBACK_TEXTS.includes(text)) {
    return { v: 1, surface, decision: 'annotated', message: '', noop: true }
  }
  if (surface === 'review' && text === LEGACY_REVIEW_APPROVED_TEXT) {
    return { v: 1, surface, decision: 'approved', message: text, noop: true }
  }
  if (surface === 'review' && text.startsWith(LEGACY_REVIEW_APPROVED_WITH_NOTES_HEADING)) {
    return { v: 1, surface, decision: 'approved', message: text, noop: false, withNotes: true }
  }
  if (surface !== 'review' && text.startsWith(`${LEGACY_ANNOTATE_APPROVED_WITH_NOTES_HEADING}\n`)) {
    return { v: 1, surface, decision: 'approved', message: text, noop: false, withNotes: true }
  }
  return { v: 1, surface, decision: 'annotated', message: text, noop: false }
}
