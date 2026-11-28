export const ANSWERED_IN_REPLY_LINE = 'This question was marked answered from your reply. Reopen it on the card to pick here.';

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
    /** The linked machine (`ibx_` id) that could not be asked, when a far read failed (Combine across computers). */
    readonly machineId: string | null = null,
  ) {
    super(code === 'question_answered_in_reply' ? ANSWERED_IN_REPLY_LINE : message);
    this.name = 'InboxApiError';
  }
}

/**
 * An answer's JSON. A whole body that is empty or not JSON reads as `{}` (a 204, a refusal with no JSON). A body that
 * could not be read at all (the connection cut or aborted after the headers: the page leaving, the Inbox restarting)
 * is no answer: an OK one throws, as the fetch would have before its headers, never `{}` passed off as the model.
 * Told apart by where it fails (reading the body, or parsing what was read), not by the error's type, which differs
 * between browsers (WebKit's `json()` rejects a bad body with a DOMException, not a SyntaxError).
 */
export async function readJson<T>(response: Response): Promise<T> {
  let text = '';
  try {
    text = await response.text();
  } catch (cause) {
    if (response.ok) throw cause;
  }
  let body: Record<string, unknown> = {};
  try {
    if (text) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
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
      typeof body.machine === 'string' ? body.machine : null,
    );
  }
  return body as T;
}
