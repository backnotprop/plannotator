import { plannotatorDecisionHeading, type PlannotatorTarget } from './tool'

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
  /** A dismissal the host asked for (the tool's `close`), not the reviewer's. */
  closedBy?: 'agent'
  unsentAnnotations?: number
  /**
   * What the decision is about, in full, as the server that took it resolved
   * it (absolute path, URL, a bundle's files, reviewed directory or PR URL).
   * Absent from a CLI older than the field and for annotate-last.
   */
  target?: string | string[]
}

/** A well-formed `target`, or undefined (a malformed one is dropped, never trusted). */
function targetOf(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    return value as string[]
  }
  return undefined
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
  const { target: rawTarget, ...rest } = record
  const target = targetOf(rawTarget)
  return { ...(rest as unknown as HostResultRecord), ...(target !== undefined ? { target } : {}) }
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
  /** The launch's `pn-` id, named in the turn's first line. */
  sessionId?: string
  /** Where the full text is written when it is over the inline limit. */
  overflowPath: string
  inlineLimitBytes?: number
  /** Deliver an approval even when it carries nothing (a gate the `plannotator` tool opened). */
  deliverApproval?: boolean
  /**
   * The launch's own idea of the target (from the ready file, else the mod's
   * resolution of the words): named when the record carries none (an older CLI).
   */
  target?: PlannotatorTarget
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * The status lines the review editor posts after a review goes to the PR
 * platform (`statusMessage` in packages/review-editor/App.tsx; delivery.test.ts
 * builds them the same way): "Pull request|Merge request approved|reviewed on
 * <platform>…" and "Changes requested on <platform>…".
 */
const PLATFORM_STATUS_LINE = /^(?:(?:Pull request|Merge request) (?:approved|reviewed) on |Changes requested on )/

export function isPlatformStatusLine(message: string): boolean {
  return PLATFORM_STATUS_LINE.test(message.trim())
}

/**
 * OLD-CLI GUARD (0.28.0 to 0.28.3). Those CLIs read any review with zero code
 * annotations as the PR-platform status post and wrote `platform: true,
 * noop: true`, so feedback made only of PR description, PR comment or editor
 * comments (which ride only in the feedback text) reached Claude as nothing.
 * The mod updates from main independently of the binary, so it still meets
 * those records. A `platform` record whose message is not one of the editor's
 * status lines is that misread feedback: deliver it. A CLI with the fix sets
 * `platform` only on the real status post, which always matches, so it never
 * takes this path.
 */
function misreadAsPlatformPost(record: HostResultRecord): boolean {
  return record.surface === 'review' && record.platform === true && record.message.trim() !== '' && !isPlatformStatusLine(record.message)
}

/**
 * Decide the delivery. Done / LGTM / Close never start a turn (a log line
 * instead); a review posted straight to a PR platform logs and suggests the
 * follow-up; everything else is submitted, prefixed with one line naming the
 * subject and outcome, and moved to a file Claude reads when it is too long.
 */
export function deliveryFor(record: HostResultRecord, context: DeliveryContext): Delivery {
  const { subject } = context

  // Claude closed it itself: nothing for Claude, whatever the record says.
  if (record.closedBy === 'agent') {
    const unsent = record.unsentAnnotations
    const saved = typeof unsent === 'number' && unsent > 0 ? ` ${unsent} unsent ${unsent === 1 ? 'comment' : 'comments'} kept in the draft.` : ''
    return { action: 'log', text: `Claude closed ${subject}.${saved} Nothing was sent to Claude.` }
  }

  const platformPost = record.surface === 'review' && record.platform === true && isPlatformStatusLine(record.message)
  if (platformPost) {
    const posted = record.message.trim() || 'review posted'
    return {
      action: 'log',
      text: `${posted[0]?.toUpperCase() ?? ''}${posted.slice(1)}. Nothing was sent to Claude.`,
      suggest: `address the review comments on ${subject}`,
    }
  }

  // A gated session Claude opened itself (the `plannotator` tool): Claude was
  // told to wait for the sign-off, so a bare approval still starts a turn.
  const approvalAwaited = context.deliverApproval === true && record.decision === 'approved'
  if (record.noop && !approvalAwaited && !misreadAsPlatformPost(record)) {
    const what = record.decision === 'approved' ? 'approved with no notes' : 'closed with no annotations'
    return { action: 'log', text: `${subject} ${what}. Nothing was sent to Claude.` }
  }

  // The record's target is the submitting server's own: it wins over the launch's.
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

/**
 * The CLI's default review approval prompts (`DEFAULT_REVIEW_APPROVED_PROMPT`
 * and the first line of `DEFAULT_REVIEW_APPROVED_WITH_NOTES_PROMPT` in
 * packages/shared/prompts.ts; delivery.test.ts keeps them equal). An older
 * CLI prints them on stdout for an approval, and only stdout says what the
 * decision was.
 */
export const LEGACY_REVIEW_APPROVED_TEXT = '# Code Review\n\nCode review completed — no changes requested.'
export const LEGACY_REVIEW_APPROVED_WITH_NOTES_HEADING = '# Code Review — Approved with Notes'

/**
 * The first line of the CLI's default annotate approved-with-notes prompt
 * (`DEFAULT_ANNOTATE_APPROVED_WITH_NOTES_PROMPT`; delivery.test.ts keeps them
 * equal), which plaintext `--gate` prints for an approval that carries a note.
 * A launch whose result file is missing is then still delivered as "Approved
 * with notes" rather than as feedback. A customized prompt cannot be told
 * apart and arrives as feedback, as for review.
 */
export const LEGACY_ANNOTATE_APPROVED_WITH_NOTES_HEADING = '# Approved with Notes'

/**
 * What the editor posts, and an annotate CLI prints, for a Done with nothing
 * to send (`ANNOTATE_NO_FEEDBACK_SENTENCE` in packages/editor/annotateSubmission.ts
 * and the multi-message variant in packages/ui/utils/parser.ts; delivery.test.ts
 * keeps them equal). A newer CLI marks that decision `noop` in its result
 * record; an older one only prints the sentence.
 */
export const LEGACY_ANNOTATE_NO_FEEDBACK_TEXTS: readonly string[] = [
  'User reviewed the document and has no feedback.',
  'User reviewed the messages and has no feedback.',
]

/**
 * A CLI that predates the host result file (the plugin and the binary update
 * separately): what it printed on stdout, the text the skill would have shown
 * Claude. Empty output, or the legacy close/approve lines, carry nothing; a
 * review approval (the default approved prompt) is an LGTM, as the newer CLI
 * reports it, rather than "Changes requested". A user-customized approved
 * prompt cannot be told apart from feedback and is delivered as feedback.
 * Stdout does not say whether a review was the PR-platform status post, so
 * that line also arrives as feedback; nothing here infers it from the text.
 */
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
    return { v: 1, surface, decision: 'approved', message: '', noop: true }
  }
  if (surface === 'review' && text.startsWith(LEGACY_REVIEW_APPROVED_WITH_NOTES_HEADING)) {
    return { v: 1, surface, decision: 'approved', message: text, noop: false, withNotes: true }
  }
  if (surface !== 'review' && text.startsWith(`${LEGACY_ANNOTATE_APPROVED_WITH_NOTES_HEADING}\n`)) {
    return { v: 1, surface, decision: 'approved', message: text, noop: false, withNotes: true }
  }
  return { v: 1, surface, decision: 'annotated', message: text, noop: false }
}
