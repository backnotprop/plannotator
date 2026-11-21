export class InboxApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The request's field the refusal names (`files[1]`), when it names one. */
    readonly field: string | null = null,
    /** When a held read may be asked again (ms since the epoch), when the answer says. */
    readonly retryAt: number | null = null,
    /** `thread_name_taken`: the one open thread that has the name, when the answer names it. */
    readonly threadId: string | null = null,
    /** `question_revision_conflict`: the question's revision on the Inbox now, when the answer names it. */
    readonly currentRevision: number | null = null,
    readonly by: string | null = null,
  ) {
    super(message);
    this.name = 'InboxApiError';
  }
}

export async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new InboxApiError(
      response.status,
      typeof body.code === 'string' ? body.code : 'error',
      typeof body.error === 'string' ? body.error : `The Inbox answered ${response.status}.`,
      typeof body.field === 'string' ? body.field : null,
      typeof body.retry_at === 'number' ? body.retry_at : null,
      typeof body.thread_id === 'string' ? body.thread_id : null,
      typeof body.current_revision === 'number' ? body.current_revision : null,
      typeof body.by === 'string' ? body.by : null,
    );
  }
  return body as T;
}
