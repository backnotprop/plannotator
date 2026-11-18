/**
 * Why the page's first `GET /api/diff` failed, for the load error state
 * (`ReviewLoadError`). A real review session never falls back to the demo
 * diff: only the standalone dev page (`bun run dev:review`, no server) does,
 * and the App decides that with `import.meta.env.DEV`.
 */

export interface DiffLoadFailureInfo {
  /** One plain sentence: what happened, for a person. */
  summary: string;
  /** The server's own words (or the error), shown smaller under the summary. */
  detail: string | null;
  /**
   * Whether the screen may offer Send Feedback and Close. Only a 5xx from
   * `/api/diff` says a review server is alive on this port and failed to build
   * the diff. An unreachable server cannot take a decision, and a 404 (or any
   * other answer) may be a different session that took the port since this
   * tab loaded: these decisions carry no session nonce (none was learned), so
   * the stale-tab guard cannot stop them.
   */
  canDecide: boolean;
}

/** A load failure already described for the person. */
export class DiffLoadFailure extends Error {
  readonly info: DiffLoadFailureInfo;
  constructor(info: DiffLoadFailureInfo) {
    super(info.detail ? `${info.summary} ${info.detail}` : info.summary);
    this.info = info;
  }
}

/** Longest server text shown; a stack trace or an HTML page is cut here. */
const MAX_DETAIL_CHARS = 400;

/** The failure for a `/api/diff` answer that was not ok. */
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
  const serverError = res.status >= 500;
  return new DiffLoadFailure({
    summary: serverError
      ? 'Plannotator could not load the changes for this review.'
      : 'This page could not get a review from Plannotator.',
    detail: detail ? `${detail} (HTTP ${res.status})` : `HTTP ${res.status}`,
    canDecide: serverError,
  });
}

/** For a `/api/diff` request that got no answer at all (a stopped server, a dropped connection). */
export function diffLoadUnreachable(): DiffLoadFailure {
  return new DiffLoadFailure({
    summary: "Plannotator isn't running or can't be reached, so this review could not load.",
    detail: null,
    canDecide: false,
  });
}

/** The info for any failure while loading: a described one as is, anything else (the page failing to apply the diff) with its own message. */
export function diffLoadFailureInfo(error: unknown): DiffLoadFailureInfo {
  if (error instanceof DiffLoadFailure) return error.info;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return {
    summary: 'The changes for this review arrived but could not be shown.',
    detail: message || null,
    canDecide: false,
  };
}
