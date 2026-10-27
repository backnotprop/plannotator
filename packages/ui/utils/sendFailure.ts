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

export type SendFailure =
  /** fetch rejected: the server is gone (stopped, crashed) or unreachable. */
  | { kind: 'unreachable' }
  /** The server answered with a non-2xx status it has no dedicated UI for. */
  | { kind: 'rejected'; status: number }
  /** The review was decided already (another window sent it, or the session
   *  that opened it ended). Sending again cannot work. */
  | { kind: 'decided' }
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
  if (res.status === 409 && (await refusalCode(res)) === ALREADY_DECIDED_CODE) {
    throw new DecisionSendError({ kind: 'decided' });
  }
  throw new DecisionSendError({ kind: 'rejected', status: res.status });
}

export function sendFailureOf(error: unknown): SendFailure {
  return error instanceof DecisionSendError ? error.failure : { kind: 'unknown' };
}

/** Whether sending the same decision again could work. */
export function canRetrySend(failure: SendFailure): boolean {
  return failure.kind !== 'decided';
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
    default:
      return 'Something went wrong before it was sent.';
  }
}
