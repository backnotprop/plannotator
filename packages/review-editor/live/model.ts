import { newSideLines, oldSideLines } from '@plannotator/core/line-anchor';
import { reviewAnchorNow, reviewConversations, REVIEW_ANCHOR_CODE_LINES_MAX, type InboxReviewAnchor, type ReviewConversation, type ReviewThreadNow } from '@plannotator/core/review-threads';
import type { InboxMessage } from '@plannotator/core/inbox-types';

export type LiveMessage = InboxMessage;

export interface LiveTarget {
  host: string;
  session: string;
}

export interface LiveAgent extends LiveTarget {
  label: string | null;
  busy: boolean;
  project: string;
  here: boolean;
}

export interface LiveState {
  inbox: boolean;
  review: { key: string; title: string } | null;
  launched_by: LiveTarget | null;
  thread: { id: string; title: string | null; to: LiveTarget | null } | null;
  messages: LiveMessage[];
  thread_url?: string | null;
}

export interface PlacedThread {
  conversation: ReviewConversation<LiveMessage>;
  now: ReviewThreadNow;
  inDiff: boolean;
}

export interface CommentLike {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new';
  scope?: 'line' | 'file' | 'general';
}

const HOST_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  pi: 'Pi',
  opencode: 'OpenCode',
  codex: 'Codex',
  qwen: 'Qwen',
  t3: 'T3 Code',
};

export function hostName(host: string | null | undefined): string {
  return (host && HOST_NAMES[host]) || 'Agent';
}

export function authorName(message: LiveMessage): string {
  if (message.author.kind === 'person') return 'You';
  const author = message.author as { host?: string | null; name?: string | null };
  return author.name || hostName(author.host);
}

export function agentLabel(agent: LiveAgent): string {
  return agent.label ? `${hostName(agent.host)} (${agent.label})` : hostName(agent.host);
}

function linesOf(patch: string, side: 'old' | 'new') {
  return side === 'old' ? oldSideLines(patch) : newSideLines(patch);
}

export function placeThreads(messages: readonly LiveMessage[], files: readonly { path: string; patch: string }[]): PlacedThread[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return reviewConversations(messages).map((conversation) => {
    const file = byPath.get(conversation.anchor.file);
    if (!file) return { conversation, now: { place: 'unknown', line_start: conversation.anchor.line_start, line_end: conversation.anchor.line_end }, inDiff: false };
    const now = reviewAnchorNow(conversation.anchor, linesOf(file.patch, conversation.anchor.side));
    return { conversation, now, inDiff: now.place !== 'unknown' || conversation.anchor.line_start === 0 };
  });
}

export function anchorOfComment(comment: CommentLike, files: readonly { path: string; patch: string }[], head: string | null = null): InboxReviewAnchor {
  const file = files.find((f) => f.path === comment.filePath);
  const whole = comment.scope === 'file' || comment.lineStart <= 0;
  const start = whole ? 0 : comment.lineStart;
  const end = whole ? 0 : Math.max(comment.lineEnd, comment.lineStart);
  const lines = file ? linesOf(file.patch, comment.side) : new Map<number, string>();
  const code: string[] = [];
  if (!whole) for (let n = start; n <= end && code.length < REVIEW_ANCHOR_CODE_LINES_MAX; n++) code.push(lines.get(n) ?? '');
  const around = (from: number, to: number) => {
    const out: string[] = [];
    for (let n = from; n <= to; n++) {
      const text = lines.get(n);
      if (text !== undefined) out.push(text);
      else if (out.length > 0) break;
    }
    return out;
  };
  const before = whole ? [] : around(Math.max(1, start - 3), start - 1);
  const after = whole ? [] : around(end + 1, end + 3);
  return {
    file: comment.filePath,
    side: comment.side,
    line_start: start,
    line_end: end,
    code: code.length === end - start + 1 ? code : [],
    ...(before.length > 0 ? { context_before: before } : {}),
    ...(after.length > 0 ? { context_after: after } : {}),
    ...(head ? { head } : {}),
  };
}

export type DeliveryWord = 'Queued' | 'Delivered' | 'Read';

export function deliveryWord(message: LiveMessage, messages: readonly LiveMessage[]): DeliveryWord | null {
  if (message.author.kind !== 'person') return null;
  const lead = message.review_batch && !message.review_batch.lead
    ? messages.find((m) => m.review_batch?.id === message.review_batch!.id && m.review_batch.lead) ?? message
    : message;
  const later = messages.some((m) => m.author.kind === 'agent' && m.created_at >= message.created_at && (m.reply_to === message.id || m.reply_to === lead.id));
  if (later) return 'Read';
  const tagsDelivered = (lead.tags ?? []).length > 0 && (lead.tags ?? []).every((tag) => !!tag.delivery);
  if (lead.delivery || tagsDelivered) return 'Delivered';
  return 'Queued';
}

export function openThreadIds(placed: readonly PlacedThread[], fileOrder: readonly string[]): string[] {
  const rank = new Map(fileOrder.map((path, i) => [path, i]));
  return placed
    .filter((p) => !p.conversation.resolved)
    .sort((a, b) => (rank.get(a.conversation.anchor.file) ?? 1e9) - (rank.get(b.conversation.anchor.file) ?? 1e9) || a.now.line_start - b.now.line_start)
    .map((p) => p.conversation.id);
}

export function stepThread(order: readonly string[], current: string | null, direction: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = current ? order.indexOf(current) : -1;
  if (at < 0) return direction === 1 ? order[0]! : order[order.length - 1]!;
  return order[(at + direction + order.length) % order.length]!;
}

export function threadLines(now: ReviewThreadNow): string {
  if (now.line_start === 0) return 'whole file';
  return now.line_start === now.line_end ? `line ${now.line_start}` : `lines ${now.line_start}–${now.line_end}`;
}

export function unsentComments<C extends CommentLike & { text?: string }>(comments: readonly C[], placed: readonly PlacedThread[]): C[] {
  const sent = new Set(placed.map(({ conversation }) => {
    const first = conversation.messages[0];
    return JSON.stringify([conversation.anchor.file, conversation.anchor.side, conversation.anchor.line_start, conversation.anchor.line_end, first?.body.trim() ?? '']);
  }));
  return comments.filter((c) => {
    if ((c.scope ?? 'line') === 'general' || !c.filePath || !c.text?.trim()) return false;
    const whole = c.scope === 'file' || c.lineStart <= 0;
    const key = JSON.stringify([c.filePath, c.side, whole ? 0 : c.lineStart, whole ? 0 : Math.max(c.lineEnd, c.lineStart), c.text.trim()]);
    return !sent.has(key);
  });
}

export function commentOfMessage(message: LiveMessage): { filePath: string; lineStart: number; lineEnd: number; side: 'old' | 'new'; scope: 'line' | 'file'; text: string } | null {
  const anchor = message.review_anchor;
  if (!anchor) return null;
  const whole = anchor.line_start === 0;
  return { filePath: anchor.file, lineStart: anchor.line_start, lineEnd: anchor.line_end, side: anchor.side, scope: whole ? 'file' : 'line', text: message.body };
}

export interface ForgeThreadComments {
  fileComments: { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string; start_line?: number; start_side?: 'LEFT' | 'RIGHT' }[];
  fileLevelComments: { path: string; body: string }[];
}

export function threadForgeText(thread: PlacedThread): string {
  const [first, ...rest] = thread.conversation.messages;
  const lines = [first?.body.trim() ?? ''];
  for (const message of rest) lines.push(`**${authorName(message)}:** ${message.body.trim()}`);
  return lines.filter(Boolean).join('\n\n');
}

export function forgeCommentsOf(threads: readonly PlacedThread[]): ForgeThreadComments {
  const out: ForgeThreadComments = { fileComments: [], fileLevelComments: [] };
  for (const thread of threads) {
    if (!thread.inDiff) continue;
    const body = threadForgeText(thread);
    const { anchor } = thread.conversation;
    if (anchor.line_start === 0) {
      out.fileLevelComments.push({ path: anchor.file, body });
      continue;
    }
    const side = anchor.side === 'old' ? 'LEFT' : 'RIGHT';
    const { line_start: start, line_end: end } = thread.now;
    out.fileComments.push({ path: anchor.file, line: end, side, body, ...(end > start ? { start_line: start, start_side: side } : {}) });
  }
  return out;
}
