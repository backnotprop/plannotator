/**
 * Where a review opens, beside `guide=` in the window's address: a file at a line (`code=path:line`, a context
 * note's lines; `&side=old` when the line is a removed line's number, as `:::note path#L3 old` names it), a guide
 * step (`step=N`, from 1), or All files (`files`). Absent: the review's start.
 */
export interface ReviewAt {
  path?: string;
  line?: number;
  step?: number;
  files?: boolean;
  side?: 'old';
}

/** The place in the address, or null. */
export function reviewAtOf(params: URLSearchParams): ReviewAt | null {
  const code = params.get('code');
  if (code) {
    const m = code.match(/^(.+):(\d+)$/);
    const line = m ? Number(m[2]) : NaN;
    return m && Number.isSafeInteger(line) && line > 0 ? { path: m[1]!, line, ...(params.get('side') === 'old' ? { side: 'old' as const } : {}) } : { path: code };
  }
  const step = Number(params.get('step'));
  if (params.has('step') && Number.isSafeInteger(step) && step > 0) return { step };
  if (params.has('files')) return { files: true };
  return null;
}

export function writeReviewAt(params: URLSearchParams, at: ReviewAt | null | undefined): void {
  if (!at) return;
  if (at.path) {
    params.set('code', at.line ? `${at.path}:${at.line}` : at.path);
    if (at.line && at.side === 'old') params.set('side', 'old');
  }
  else if (at.step) params.set('step', String(at.step));
  else if (at.files) params.set('files', '');
}
