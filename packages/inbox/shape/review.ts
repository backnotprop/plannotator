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
import type { ShapeReviewAt, ShapeReviewNarrow, ShapeSurfaceReview } from '@plannotator/ui/components/shape/types';

/** The review a board in this thread is part of: its newest one. */
export function shapeReviewMessage(thread: InboxThread | null): InboxMessageWire | null {
  if (!thread) return null;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (m.guide?.review) return m;
  }
  return null;
}

/**
 * A stack badge's "Read it in the review" narrowing (`narrow=` beside the place, JSON): the part's name, the PR, and
 * the files. Anything else in the address is not a narrowing.
 */
export function shapeReviewNarrowOf(value: string | null): ShapeReviewNarrow | null {
  if (!value) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const files = Array.isArray(n.files) ? n.files.filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length <= 500).slice(0, 30) : [];
  if (typeof n.part !== 'string' || !n.part.trim() || typeof n.pr !== 'number' || !Number.isSafeInteger(n.pr) || n.pr < 1 || !files.length) return null;
  return {
    part: n.part.slice(0, 120),
    pr: n.pr,
    ...(typeof n.title === 'string' && n.title ? { title: n.title.slice(0, 200) } : {}),
    ...(typeof n.url === 'string' && /^https?:\/\//i.test(n.url) ? { url: n.url.slice(0, 2000) } : {}),
    ...(typeof n.hue === 'number' && Number.isFinite(n.hue) && n.hue >= 0 && n.hue < 360 ? { hue: Math.round(n.hue) % 360 } : {}),
    files,
  };
}

/** Where the review opens, in the window's address beside `guide=`: `code=path:line`, `step=N`, or `files`, and a stack badge's `narrow=`. */
export function shapeReviewAtOf(params: URLSearchParams): ShapeReviewAt | null {
  const narrow = shapeReviewNarrowOf(params.get('narrow'));
  const withNarrow = (at: ShapeReviewAt): ShapeReviewAt => (narrow ? { ...at, narrow } : at);
  const code = params.get('code');
  if (code) {
    const m = code.match(/^(.+):(\d+)$/);
    const line = m ? Number(m[2]) : NaN;
    return withNarrow(m && Number.isSafeInteger(line) && line > 0 ? { path: m[1]!, line } : { path: code });
  }
  const step = Number(params.get('step'));
  if (params.has('step') && Number.isSafeInteger(step) && step > 0) return withNarrow({ step });
  if (params.has('files')) return { files: true };
  return null;
}

export function writeShapeReviewAt(params: URLSearchParams, at: ShapeReviewAt | null | undefined): void {
  if (!at) return;
  if (at.path) params.set('code', at.line ? `${at.path}:${at.line}` : at.path);
  else if (at.step) params.set('step', String(at.step));
  else if (at.files) params.set('files', '');
  if (at.narrow && (at.path || at.step)) params.set('narrow', JSON.stringify(at.narrow));
}

/** The files a review changes, read once per review. */
const reviewFiles = new Map<string, Promise<ReadonlySet<string> | null>>();
/** A review's whole patch (a stack badge's file in the code popup), read once per review. */
const reviewPatches = new Map<string, Promise<string | null>>();

export function shapeReviewPatch(messageId: string, read: (messageId: string) => Promise<{ snapshot: unknown }>): Promise<string | null> {
  let patch = reviewPatches.get(messageId);
  if (!patch) {
    patch = read(messageId).then(
      (answer) => {
        const parsed = parseGuideSnapshot(answer.snapshot);
        return parsed.ok ? parsed.value.review.rawPatch : null;
      },
      () => {
        reviewPatches.delete(messageId);
        return null;
      },
    );
    reviewPatches.set(messageId, patch);
  }
  return patch;
}

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
    patch: () => shapeReviewPatch(message.id, read),
  };
}
