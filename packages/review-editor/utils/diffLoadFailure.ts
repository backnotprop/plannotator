/**
 * Why the page's first `GET /api/diff` failed, for the load error state
 * (`ReviewLoadError`). A real review session never falls back to the demo
 * diff: only the standalone dev page (`bun run dev:review`, no server) does,
 * and the App decides that with `import.meta.env.DEV`.
 */

export interface DiffLoadFailureInfo {
  /** One plain sentence: what happened, for a person. */
  summary: string;
  /** The server's own words in one short plain line (or the HTTP status), shown smaller under the summary. */
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

/** Longest detail shown: one short line, never a page of markup or a stack trace. */
const MAX_DETAIL_CHARS = 160;

/**
 * One short plain line from a failed answer's body: a JSON body's `error` when it is a string, else (for any other
 * JSON) nothing; a text or HTML body's first line with any markup taken out. Capped.
 */
export function diffLoadDetailLine(body: string): string {
  const text = body.trim();
  if (!text) return '';
  let line = '';
  try {
    const parsed: unknown = JSON.parse(text);
    const error = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
    line = typeof error === 'string' ? error : '';
  } catch {
    line = text
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '\n')
      .replace(/<!--[\s\S]*?-->/g, '\n')
      .replace(/<[^>]*>/g, '\n')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }
  const first = line.split('\n').map((part) => part.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return first.length > MAX_DETAIL_CHARS ? `${first.slice(0, MAX_DETAIL_CHARS - 1).trimEnd()}…` : first;
}

/** The failure for a `/api/diff` answer that was not ok. */
export async function diffLoadFailureFromResponse(res: Response): Promise<DiffLoadFailure> {
  let detail = '';
  try {
    detail = diffLoadDetailLine(await res.text());
  } catch {
    // The body could not be read; the status still says something.
  }
  if (!detail) detail = res.statusText.trim();
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

/**
 * The info for any failure while loading: a described one as is. Anything else is the page failing to read or apply
 * the answer (a body that is not a review): the summary says so, and no detail, since the error's own words are the
 * page's code ("e.includes is not a function"), not anything the person can act on. The console keeps it.
 */
export function diffLoadFailureInfo(error: unknown): DiffLoadFailureInfo {
  if (error instanceof DiffLoadFailure) return error.info;
  return {
    summary: 'The changes for this review arrived but could not be shown.',
    detail: null,
    canDecide: false,
  };
}
