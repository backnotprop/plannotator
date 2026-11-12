import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import { parseGuideSnapshot } from '@plannotator/core/guide-format';
import type { ShapeReviewAt, ShapeReviewNarrow, ShapeSurfaceReview } from '@plannotator/ui/components/shape/types';

export function shapeReviewMessage(thread: InboxThread | null): InboxMessageWire | null {
  if (!thread) return null;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (m.guide?.review) return m;
  }
  return null;
}

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

export interface ReviewAt extends ShapeReviewAt {
  side?: 'old';
}

export function shapeReviewAtOf(params: URLSearchParams): ReviewAt | null {
  const narrow = shapeReviewNarrowOf(params.get('narrow'));
  const withNarrow = (at: ReviewAt): ReviewAt => (narrow ? { ...at, narrow } : at);
  const code = params.get('code');
  if (code) {
    const m = code.match(/^(.+):(\d+)$/);
    const line = m ? Number(m[2]) : NaN;
    return withNarrow(m && Number.isSafeInteger(line) && line > 0 ? { path: m[1]!, line, ...(params.get('side') === 'old' ? { side: 'old' as const } : {}) } : { path: code });
  }
  const step = Number(params.get('step'));
  if (params.has('step') && Number.isSafeInteger(step) && step > 0) return withNarrow({ step });
  if (params.has('files')) return { files: true };
  return null;
}

export function writeShapeReviewAt(params: URLSearchParams, at: ReviewAt | null | undefined): void {
  if (!at) return;
  if (at.path) {
    params.set('code', at.line ? `${at.path}:${at.line}` : at.path);
    if (at.line && at.side === 'old') params.set('side', 'old');
  }
  else if (at.step) params.set('step', String(at.step));
  else if (at.files) params.set('files', '');
  if (at.narrow && (at.path || at.step)) params.set('narrow', JSON.stringify(at.narrow));
}

const reviewFiles = new Map<string, Promise<ReadonlySet<string> | null>>();
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
        reviewFiles.delete(messageId);
        return null;
      },
    );
    reviewFiles.set(messageId, files);
  }
  return files;
}

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
