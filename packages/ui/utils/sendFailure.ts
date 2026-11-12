export const ALREADY_DECIDED_CODE = 'already_decided';

export const PLAN_REVISED_CODE = 'plan_revised';

export type SendFailure =
  | { kind: 'unreachable' }
  | { kind: 'rejected'; status: number }
  | { kind: 'decided' }
  | { kind: 'unknown' };

export class DecisionSendError extends Error {
  readonly failure: SendFailure;
  constructor(failure: SendFailure, options?: { cause?: unknown }) {
    super(`Decision not sent (${failure.kind})`, options);
    this.name = 'DecisionSendError';
    this.failure = failure;
  }
}

export function throwUnreachable(cause: unknown): never {
  throw new DecisionSendError({ kind: 'unreachable' }, { cause });
}

export async function refusalCode(res: Response): Promise<string | undefined> {
  try {
    const code = ((await res.clone().json()) as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

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

export function canRetrySend(failure: SendFailure): boolean {
  return failure.kind !== 'decided';
}

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
