/**
 * A board's review (approval "shape-whats-changed"): with no Code tab on Plannotator's board, What's changed's
 * Guided review and Full review, its guide-step links and the board's `file:line` links open the review's own guided
 * review, the way its thread does (`#thread=…&guide=<message>`), at that step, file or line.
 *
 * The review is the newest message in the board's thread that carries a review (`guide.review`). A board with no
 * thread, or a thread with no review, has none: its links open the file in the board's own viewer, as before.
 */
import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import { parseGuideSnapshot } from '@plannotator/core/guide-format';
import type { ShapeReviewAt, ShapeSurfaceReview } from '@plannotator/ui/components/shape/types';

/** The review a board in this thread is part of: its newest one. */
export function shapeReviewMessage(thread: InboxThread | null): InboxMessageWire | null {
  if (!thread) return null;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (m.guide?.review) return m;
  }
  return null;
}

/** Where the review opens, in the window's address beside `guide=`: `code=path:line`, `step=N`, or `files`. */
export function shapeReviewAtOf(params: URLSearchParams): ShapeReviewAt | null {
  const code = params.get('code');
  if (code) {
    const m = code.match(/^(.+):(\d+)$/);
    const line = m ? Number(m[2]) : NaN;
    return m && Number.isSafeInteger(line) && line > 0 ? { path: m[1]!, line } : { path: code };
  }
  const step = Number(params.get('step'));
  if (params.has('step') && Number.isSafeInteger(step) && step > 0) return { step };
  if (params.has('files')) return { files: true };
  return null;
}

export function writeShapeReviewAt(params: URLSearchParams, at: ShapeReviewAt | null | undefined): void {
  if (!at) return;
  if (at.path) params.set('code', at.line ? `${at.path}:${at.line}` : at.path);
  else if (at.step) params.set('step', String(at.step));
  else if (at.files) params.set('files', '');
}

/** The files a review changes, read once per review. */
const reviewFiles = new Map<string, Promise<ReadonlySet<string> | null>>();

export function shapeReviewFiles(messageId: string, read: (messageId: string) => Promise<{ snapshot: unknown }>): Promise<ReadonlySet<string> | null> {
  let files = reviewFiles.get(messageId);
  if (!files) {
    files = read(messageId).then(
      (answer) => {
        const parsed = parseGuideSnapshot(answer.snapshot);
        return parsed.ok ? new Set(parseDiffToFiles(parsed.value.review.rawPatch).map((f) => f.path)) : null;
      },
      () => {
        // Not read (a blip): asked again next time.
        reviewFiles.delete(messageId);
        return null;
      },
    );
    reviewFiles.set(messageId, files);
  }
  return files;
}

/**
 * The board's review: the facts What's changed shows, and `open`, which goes to the review there. A file the
 * review does not change, or a step it does not have, answers false: the board shows the file in its own viewer.
 */
export function shapeReview(message: InboxMessageWire, go: (messageId: string, at: ShapeReviewAt | null) => void, read: (messageId: string) => Promise<{ snapshot: unknown }>): ShapeSurfaceReview {
  const guide = message.guide!;
  const pr = guide.source?.pr?.number;
  return {
    label: pr ? `#${pr}` : undefined,
    files: guide.files,
    additions: guide.additions,
    deletions: guide.deletions,
    steps: guide.sections,
    async open(at) {
      if (at.step && at.step > guide.sections) return false;
      if (at.path) {
        const files = await shapeReviewFiles(message.id, read);
        if (!files?.has(at.path)) return false;
      }
      go(message.id, at.path || at.step || at.files ? at : null);
      return true;
    },
  };
}
