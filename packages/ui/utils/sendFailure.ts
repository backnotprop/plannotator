/**
 * Why a decision POST (send feedback, approve, deny) did not land (#1392).
 *
 * The review pages used to swallow these failures: a POST to a server that
 * had stopped rejected with a network error, the catch only re-enabled the
 * button, and the reviewer could not tell that nothing reached the agent.
 * The handlers now tag the failure so the page can say which one happened
 * (`SendFailureToast`).
 */

/** The `code` every plan, annotate and review server (Bun and Pi) puts on its
 *  409 for a decision that arrives after the review was decided or closed
 *  (also `packages/shared/host-control.ts`). */
export const ALREADY_DECIDED_CODE = 'already_decided';

/** The `code` of plan review's 409 for a decision on an older revision. */
export const PLAN_REVISED_CODE = 'plan_revised';

/** The codes a code review server (Bun and Pi) refuses a decision with when
 *  nobody can receive it: nothing was sent and the draft is kept
 *  (packages/shared/review-agent-gone.ts, whose literals live in
 *  packages/shared/review-agent-gone-words.ts; this package is published and
 *  shared is not, so it keeps its own copies, pinned by
 *  sendFailure.agentGone.test.ts). `agent_gone`: the agent quit (410).
 *  `agent_away`: no session right now, one may come back (409, Pi between
 *  sessions). `no_session`: the review never had a session to send to (410).
 *  The words a person reads for these come from the review page
 *  (packages/review-editor/components/AgentGoneNotice.tsx `agentGoneReasonFor`). */
export const AGENT_GONE_CODE = 'agent_gone';
export const AGENT_AWAY_CODE = 'agent_away';
export const NO_SESSION_CODE = 'no_session';

export type SendFailure =
  /** fetch rejected: the server is gone (stopped, crashed) or unreachable. */
  | { kind: 'unreachable' }
  /** The server answered with a non-2xx status it has no dedicated UI for. */
  | { kind: 'rejected'; status: number }
  /** The review was decided already (another window sent it, or the session
   *  that opened it ended). Sending again cannot work. */
  | { kind: 'decided' }
  /** The agent that asked for this review is gone: nothing was sent, the
   *  comments are kept. Sending again cannot reach it. */
  | { kind: 'agent-gone' }
  /** No agent session can take it right now; sending again may work. */
  | { kind: 'agent-away' }
  /** The review has no agent session to send to. */
  | { kind: 'no-session' }
  /** Anything else thrown before the response settled. */
  | { kind: 'unknown' };

export class DecisionSendError extends Error {
  readonly failure: SendFailure;
  constructor(failure: SendFailure, options?: { cause?: unknown }) {
    super(`Decision not sent (${failure.kind})`, options);
    this.name = 'DecisionSendError';
    this.failure = failure;
  }
}

/** `.catch()` for a decision fetch: a rejected fetch means the server is unreachable. */
export function throwUnreachable(cause: unknown): never {
  throw new DecisionSendError({ kind: 'unreachable' }, { cause });
}

/** The `code` of a refusal body, when it has one. Never consumes `res`. */
export async function refusalCode(res: Response): Promise<string | undefined> {
  try {
    const code = ((await res.clone().json()) as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Throws the failure for a response that is not ok: `decided` for the
 *  servers' already-decided refusal, `rejected` with the status otherwise. */
export async function assertSendOk(res: Response): Promise<void> {
  if (res.ok) return;
  const code = res.status === 409 || res.status === 410 ? await refusalCode(res) : undefined;
  if (res.status === 409 && code === ALREADY_DECIDED_CODE) throw new DecisionSendError({ kind: 'decided' });
  if (res.status === 409 && code === AGENT_AWAY_CODE) throw new DecisionSendError({ kind: 'agent-away' });
  if (res.status === 410 && code === AGENT_GONE_CODE) throw new DecisionSendError({ kind: 'agent-gone' });
  if (res.status === 410 && code === NO_SESSION_CODE) throw new DecisionSendError({ kind: 'no-session' });
  throw new DecisionSendError({ kind: 'rejected', status: res.status });
}

/**
 * The failure to show for a send made after the page heard that the agent is
 * gone: a server that could not be reached (it ended once its agent was gone
 * and no tab held it) is shown as the agent being gone. Any other answer says
 * what it says.
 */
export function sendErrorAfterAgentGone(error: unknown, agentGone: boolean): unknown {
  if (!agentGone || sendFailureOf(error).kind !== 'unreachable') return error;
  return new DecisionSendError({ kind: 'agent-gone' }, { cause: error });
}

export function sendFailureOf(error: unknown): SendFailure {
  return error instanceof DecisionSendError ? error.failure : { kind: 'unknown' };
}

/** Whether sending the same decision again could work. */
export function canRetrySend(failure: SendFailure): boolean {
  return failure.kind !== 'decided' && failure.kind !== 'agent-gone' && failure.kind !== 'no-session';
}

/** The one sentence under the toast's title: why nothing reached the agent. */
export function describeSendFailure(failure: SendFailure): string {
  switch (failure.kind) {
    case 'unreachable':
      return "Plannotator isn't running or can't be reached.";
    case 'rejected':
      return `Plannotator answered with an error (${failure.status}).`;
    case 'decided':
      return 'This review was already decided, in another window or because its session ended.';
    // The code review page passes its own reason for these
    // (`showSendFailureToast({ reason })`); anywhere else, the plain refusal.
    case 'agent-gone':
    case 'no-session':
      return 'Plannotator answered with an error (410).';
    case 'agent-away':
      return 'Plannotator answered with an error (409).';
    default:
      return 'Something went wrong before it was sent.';
  }
}
