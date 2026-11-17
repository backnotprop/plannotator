/**
 * Why the page's first `GET /api/diff` failed, in words for the load error
 * state (`ReviewLoadError`). A real review session never falls back to the
 * demo diff: only the standalone dev page (`bun run dev:review`, no server)
 * does, and the App decides that with `import.meta.env.DEV`.
 */

/** A load failure whose message is already written for the person. */
export class DiffLoadFailure extends Error {}

/** Longest server text shown; a stack trace or an HTML page is cut here. */
const MAX_DETAIL_CHARS = 400;

/** The message for a `/api/diff` answer that was not ok: the server's own `error` field or text, else its status. */
export async function diffLoadFailureFromResponse(res: Response): Promise<DiffLoadFailure> {
  let detail = '';
  try {
    const text = (await res.text()).trim();
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        const error = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
        detail = typeof error === 'string' ? error.trim() : text;
      } catch {
        detail = text;
      }
    }
  } catch {
    // The body could not be read; the status still says something.
  }
  if (detail.length > MAX_DETAIL_CHARS) detail = `${detail.slice(0, MAX_DETAIL_CHARS)}…`;
  return new DiffLoadFailure(
    detail
      ? `The review server could not build the diff (HTTP ${res.status}): ${detail}`
      : `The review server could not build the diff (HTTP ${res.status}).`,
  );
}

/** For a `/api/diff` request that got no answer at all (a stopped server, a dropped connection). */
export function diffLoadUnreachable(): DiffLoadFailure {
  return new DiffLoadFailure('The review server did not answer. It may have stopped.');
}

/** The message for any failure while loading: a written one as is, anything else (the page failing to apply the diff) with its own message. */
export function diffLoadFailureMessage(error: unknown): string {
  if (error instanceof DiffLoadFailure) return error.message;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message ? `The diff could not be shown: ${message}` : 'The diff could not be shown.';
}
