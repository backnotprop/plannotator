import { earlierLinesNow, findBlock, type SideLines } from './line-anchor';

export interface InboxReviewAnchor {
  file: string;
  side: 'old' | 'new';
  line_start: number;
  line_end: number;
  code: string[];
  context_before?: string[];
  context_after?: string[];
  head?: string | null;
}

export interface InboxReviewLive {
  key: string;
  title: string;
}

export interface InboxReviewBatch {
  id: string;
  lead: boolean;
}

export interface InboxReviewResolved {
  at: string;
}

export interface InboxReviewAddressed {
  at: string;
  session: string | null;
  host: string | null;
  commit?: string | null;
}

export const REVIEW_ANCHOR_CODE_LINES_MAX = 80;
export const REVIEW_ANCHOR_CONTEXT_LINES_MAX = 3;
export const REVIEW_ANCHOR_LINE_CHARS_MAX = 400;
export const REVIEW_ANCHOR_FILE_CHARS_MAX = 1000;
export const REVIEW_LIVE_KEY_CHARS_MAX = 600;
export const REVIEW_LIVE_TITLE_CHARS_MAX = 120;

export class ReviewAnchorError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;

function lines(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value)) throw new ReviewAnchorError(field, `${field}: a list of lines.`);
  if (value.length > max) throw new ReviewAnchorError(field, `${field}: at most ${max} lines.`);
  return value.map((line, i) => {
    if (typeof line !== 'string') throw new ReviewAnchorError(field, `${field}[${i}]: a line of text.`);
    return line.length > REVIEW_ANCHOR_LINE_CHARS_MAX ? line.slice(0, REVIEW_ANCHOR_LINE_CHARS_MAX) : line;
  });
}

export function checkReviewAnchor(value: unknown, field = 'review_anchor'): InboxReviewAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReviewAnchorError(field, `${field}: an object.`);
  const raw = value as Record<string, unknown>;
  const file = raw.file;
  if (typeof file !== 'string' || !file.trim() || file.length > REVIEW_ANCHOR_FILE_CHARS_MAX || CONTROL.test(file)) {
    throw new ReviewAnchorError(`${field}.file`, `${field}.file: the file's path as the diff names it.`);
  }
  if (raw.side !== 'old' && raw.side !== 'new') throw new ReviewAnchorError(`${field}.side`, `${field}.side: "old" or "new".`);
  const start = raw.line_start;
  const end = raw.line_end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) < (start as number)) {
    throw new ReviewAnchorError(`${field}.line_start`, `${field}.line_start and line_end: whole numbers, start at most end (0 and 0 for the whole file).`);
  }
  if ((start === 0) !== (end === 0)) throw new ReviewAnchorError(`${field}.line_start`, `${field}: a whole-file comment is lines 0 to 0.`);
  const code = lines(raw.code ?? [], `${field}.code`, REVIEW_ANCHOR_CODE_LINES_MAX);
  const before = raw.context_before === undefined ? [] : lines(raw.context_before, `${field}.context_before`, REVIEW_ANCHOR_CONTEXT_LINES_MAX);
  const after = raw.context_after === undefined ? [] : lines(raw.context_after, `${field}.context_after`, REVIEW_ANCHOR_CONTEXT_LINES_MAX);
  const head = raw.head;
  if (head !== undefined && head !== null && (typeof head !== 'string' || !/^[0-9a-f]{7,64}$/i.test(head))) {
    throw new ReviewAnchorError(`${field}.head`, `${field}.head: a commit sha, or null for the working tree.`);
  }
  return {
    file,
    side: raw.side,
    line_start: start as number,
    line_end: end as number,
    code,
    ...(before.length > 0 ? { context_before: before } : {}),
    ...(after.length > 0 ? { context_after: after } : {}),
    ...(typeof head === 'string' ? { head: head.toLowerCase() } : {}),
  };
}

export function checkReviewLive(value: unknown): InboxReviewLive {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReviewAnchorError('review_live', 'review_live: an object.');
  const raw = value as Record<string, unknown>;
  if (typeof raw.key !== 'string' || !raw.key.trim() || raw.key.length > REVIEW_LIVE_KEY_CHARS_MAX || CONTROL.test(raw.key)) {
    throw new ReviewAnchorError('review_live.key', 'review_live.key: the review\'s key (pr:<url>, branch:<name> or head:<sha>).');
  }
  const title = typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim().slice(0, REVIEW_LIVE_TITLE_CHARS_MAX) : '';
  return { key: raw.key.trim(), title: title || raw.key.trim().slice(0, REVIEW_LIVE_TITLE_CHARS_MAX) };
}

export function reviewLiveKey(input: { prUrl?: string | null; branch?: string | null; head?: string | null }): string | null {
  if (input.prUrl) return `pr:${input.prUrl}`;
  if (input.branch) return `branch:${input.branch}`;
  if (input.head) return `head:${input.head}`;
  return null;
}

function fenceFor(code: readonly string[]): string {
  let longest = 2;
  for (const line of code) for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(longest + 1);
}

export function reviewAnchorPlace(anchor: InboxReviewAnchor): string {
  if (anchor.line_start === 0) return `\`${anchor.file}\` (the whole file)`;
  const lines = anchor.line_start === anchor.line_end ? `line ${anchor.line_start}` : `lines ${anchor.line_start}-${anchor.line_end}`;
  const at = anchor.head ? `, at ${anchor.head.slice(0, 7)}` : '';
  return `\`${anchor.file}\` ${lines} (${anchor.side} side${at})`;
}

function codeBlock(anchor: InboxReviewAnchor): string {
  if (anchor.code.length === 0) return '';
  const fence = fenceFor(anchor.code);
  return `\n${fence}\n${anchor.code.join('\n')}\n${fence}`;
}

export function reviewAnchorBlock(message: { id: string; review_anchor?: InboxReviewAnchor | null }): string {
  const anchor = message.review_anchor;
  if (!anchor || typeof anchor.file !== 'string' || !Array.isArray(anchor.code)) return '';
  return `(A review comment on ${reviewAnchorPlace(anchor)}:${codeBlock(anchor)}\nAnswer it with reply_to ${message.id}.)`;
}

export function reviewBatchBlock(lead: { id: string }, comments: readonly { id: string; body: string; review_anchor?: InboxReviewAnchor | null }[]): string {
  const listed = comments.filter((c) => c.review_anchor && typeof c.review_anchor.file === 'string' && Array.isArray(c.review_anchor.code));
  if (listed.length === 0) return '';
  const count = listed.length === 1 ? '1 comment' : `${listed.length} comments`;
  const head = `(A code review of ${count}. Answer each comment with reply_to its id, so the answer lands on its lines; answer the review as a whole with reply_to ${lead.id}.)`;
  const items = listed.map((comment) => `Comment ${comment.id} on ${reviewAnchorPlace(comment.review_anchor!)}:${codeBlock(comment.review_anchor!)}\n${comment.body.trim()}`);
  return [head, ...items].join('\n\n');
}

export type ReviewThreadPlace = 'here' | 'moved' | 'changed' | 'unknown';

export interface ReviewThreadNow {
  place: ReviewThreadPlace;
  line_start: number;
  line_end: number;
}

export function reviewAnchorNow(anchor: InboxReviewAnchor, now: SideLines | undefined): ReviewThreadNow {
  const { line_start: start, line_end: end } = anchor;
  if (start === 0) return { place: 'here', line_start: 0, line_end: 0 };
  if (anchor.code.length !== end - start + 1) return { place: 'unknown', line_start: start, line_end: end };
  const before = new Map<number, string>();
  const above = anchor.context_before ?? [];
  above.forEach((text, i) => before.set(start - above.length + i, text));
  anchor.code.forEach((text, i) => before.set(start + i, text));
  (anchor.context_after ?? []).forEach((text, i) => before.set(end + 1 + i, text));
  const found = findBlock(start, end, before, now);
  if (found) return { place: found.moved ? 'moved' : 'here', line_start: found.at, line_end: found.at + (end - start) };
  const shifted = earlierLinesNow([start, end], before, now);
  if (shifted) return { place: 'changed', line_start: shifted[0], line_end: shifted[1] };
  return { place: 'unknown', line_start: start, line_end: end };
}

export interface ReviewThreadMessage {
  id: string;
  reply_to: string | null;
  created_at: string;
  review_anchor?: InboxReviewAnchor | null;
  review_batch?: InboxReviewBatch | null;
  review_resolved?: InboxReviewResolved | null;
  review_addressed?: InboxReviewAddressed | null;
}

export interface ReviewConversation<M extends ReviewThreadMessage> {
  id: string;
  anchor: InboxReviewAnchor;
  messages: M[];
  resolved: InboxReviewResolved | null;
  addressed: InboxReviewAddressed | null;
}

export function reviewConversations<M extends ReviewThreadMessage>(messages: readonly M[]): ReviewConversation<M>[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const owner = new Map<string, string | null>();
  const ownerOf = (message: M): string | null => {
    if (owner.has(message.id)) return owner.get(message.id)!;
    owner.set(message.id, null);
    let found: string | null = null;
    if (message.review_anchor) found = message.id;
    else if (message.review_batch?.lead) found = null;
    else if (message.reply_to) {
      const parent = byId.get(message.reply_to);
      if (parent) found = ownerOf(parent);
    }
    owner.set(message.id, found);
    return found;
  };
  const out = new Map<string, ReviewConversation<M>>();
  for (const message of messages) {
    const id = ownerOf(message);
    if (!id) continue;
    let conversation = out.get(id);
    if (!conversation) {
      const root = byId.get(id)!;
      conversation = { id, anchor: root.review_anchor!, messages: [], resolved: root.review_resolved ?? null, addressed: null };
      out.set(id, conversation);
    }
    conversation.messages.push(message);
    if (message.review_addressed && (!conversation.addressed || message.review_addressed.at > conversation.addressed.at)) conversation.addressed = message.review_addressed;
  }
  return [...out.values()];
}
