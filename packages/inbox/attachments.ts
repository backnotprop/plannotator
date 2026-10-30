/**
 * The window's side of attachments (step 2): how a file's text becomes
 * Plannotator's blocks, how the person's annotations read in the reply chip,
 * and the feedback text a Send carries after the picks.
 */

import { inboxUrl } from './inboxUrl';
import { shouldStripFrontmatter } from '@plannotator/core/annotatable';
import { codeFenceFor } from '@plannotator/core/markdown-structure';
import { cutText } from '@plannotator/core/inbox-questions';
import {
  formatInboxVideoTime,
  INBOX_VIDEO_BLOCK_ID,
  readInboxAttachmentKind,
  readInboxVideoTime,
  type InboxAnnotationRecord,
  type InboxAttachmentKind,
  type InboxAttachmentState,
} from '@plannotator/core/inbox-types';
import { AnnotationType, type Annotation, type Block, type CodeAnnotation, type ImageAttachment } from '@plannotator/ui/types';
import { diagramDocumentBlocks, exportLinkedDocAnnotations, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { whenTime } from './format';

/** Plannotator's blocks for a file: one diagram block for a diagram source, one code block for code, the markdown pipeline for text, none for HTML or a binary kind. */
export function attachmentBlocks(kindValue: InboxAttachmentKind | string, text: string, name: string): Block[] {
  const kind = readInboxAttachmentKind(kindValue);
  if (kind === 'html' || kind === 'image' || kind === 'video' || kind === 'pdf' || kind === 'file') return [];
  if (kind === 'mermaid' || kind === 'graphviz') return diagramDocumentBlocks(text, kind);
  if (kind === 'code') return codeDocumentBlocks(text, name);
  return parseMarkdownToBlocks(text, shouldStripFrontmatter(name) ? undefined : { frontmatter: false });
}

/**
 * Data and log files the window draws with the code view (exact lines,
 * indentation kept, line comments) though their kind is `text`: the markdown
 * pipeline ran their lines together and read `#` as a heading. Plain `.txt`
 * keeps the text view. Decided on screen, so files already sent show this way
 * too; a text comment left on one before shows as Unanchored.
 */
const CODE_VIEW_TEXT_EXTENSIONS = new Set(['log', 'yaml', 'yml', 'json', 'jsonc', 'json5', 'toml', 'ini', 'cfg', 'conf', 'properties', 'csv', 'tsv', 'xml']);

/** The kind the window draws a file as: its stored kind, except data and log files, drawn as code. */
export function inboxViewKind(kindValue: InboxAttachmentKind | string, name: string): InboxAttachmentKind {
  const kind = readInboxAttachmentKind(kindValue);
  if (kind !== 'text') return kind;
  const lower = name.toLowerCase();
  if (lower.endsWith('.env.example')) return 'code';
  const ext = /\.([a-z0-9]+)$/.exec(lower)?.[1];
  return ext !== undefined && CODE_VIEW_TEXT_EXTENSIONS.has(ext) ? 'code' : kind;
}

/** Names without an extension that a highlighter grammar knows by another name. */
const CODE_NAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'make',
  justfile: 'just',
  rakefile: 'ruby',
  gemfile: 'ruby',
  vagrantfile: 'ruby',
  brewfile: 'ruby',
};
/** Extensions a highlighter grammar knows by another name; any other extension is tried as is, and an unknown one stays plain. */
const CODE_EXTENSION_LANGUAGES: Record<string, string> = { h: 'c', hpp: 'cpp', ex: 'elixir', exs: 'elixir', tf: 'hcl' };

/** The highlighting language for a code file's name, or undefined (plain text). */
export function codeLanguageOf(name: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  if (!ext) return CODE_NAME_LANGUAGES[name.toLowerCase()];
  return CODE_EXTENSION_LANGUAGES[ext] ?? ext;
}

/**
 * The largest code file highlighted. Shiki runs one synchronous pass over the
 * whole text on the main thread (measured: 300 KB of JS 4 s, 1 MB 9.9 s, a
 * 1.6 MB minified bundle 163 s), so a larger file is drawn as plain text: one
 * text node, no language.
 */
export const CODE_HIGHLIGHT_MAX_CHARS = 100_000;

/** A code file with a line longer than this (a minified bundle) wraps its lines in the code view instead of scrolling sideways. */
export const CODE_WRAP_LINE_CHARS = 1000;

/** Whether any line of `text` is longer than `max` characters. */
export function hasLineLongerThan(text: string, max: number): boolean {
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    if (end - start > max) return true;
    start = end + 1;
  }
  return false;
}

/**
 * A code file as ONE read-only code block, never the markdown pipeline (a
 * shell or Python `#` comment would read as a heading). Highlighted only up to
 * CODE_HIGHLIGHT_MAX_CHARS.
 */
export function codeDocumentBlocks(text: string, name: string): Block[] {
  return [
    {
      id: 'block-0',
      type: 'code',
      content: text.replace(/\n$/, ''),
      language: text.length <= CODE_HIGHLIGHT_MAX_CHARS ? codeLanguageOf(name) : undefined,
      order: 1,
      startLine: 1,
    },
  ];
}

export function annotationOf(record: InboxAnnotationRecord): Annotation {
  return record.annotation as unknown as Annotation;
}

/** The small tag beside a file in the chip's list: the element a pin is on ("button"), or the diagram part ("node B"). */
export function annotationTag(annotation: Annotation): string | null {
  const diagram = annotation.diagramAnchor;
  if (diagram) return diagram.kind === 'diagram' ? 'diagram' : `${diagram.kind}${'id' in diagram && diagram.id ? ` ${diagram.id}` : ''}`;
  const tag = annotation.elementContext?.tag ?? annotation.htmlAnchor?.tagName;
  return tag ? tag.toLowerCase() : null;
}

/** The quoted text a row shows: the selection, or the element or part it names. */
export function annotationQuote(annotation: Annotation): string {
  return annotation.originalText ?? '';
}

/** A file's path as the agent knows it: an image in a message's text by its src as written; an attached file relative to its project when inside it, else the absolute path it attached. */
export function attachmentLabel(attachment: Pick<InboxAttachmentState, 'path' | 'name' | 'ref'>, projectRoot: string): string {
  if (attachment.ref !== undefined) return attachment.ref;
  const root = projectRoot.replace(/[\\/]+$/, '');
  if (attachment.path.startsWith(`${root}/`) || attachment.path.startsWith(`${root}\\`)) return attachment.path.slice(root.length + 1);
  return attachment.path || attachment.name;
}

/** Where an attachment's bytes are served: an image for `<img src>`, and any kind as a download. By id only. */
export function attachmentImageUrl(attachment: Pick<InboxAttachmentState, 'id'>, version: 'current' | 'sent' = 'current'): string {
  return inboxUrl(`/attachments/${encodeURIComponent(attachment.id)}/image${version === 'sent' ? '?version=sent' : ''}`);
}

/** A video's bytes for `<video src>` (HTTP Range, by id only). */
export function attachmentVideoUrl(attachment: Pick<InboxAttachmentState, 'id'>, version: 'current' | 'sent' = 'current'): string {
  return inboxUrl(`/attachments/${encodeURIComponent(attachment.id)}/video${version === 'sent' ? '?version=sent' : ''}`);
}

export function attachmentDownloadUrl(attachment: Pick<InboxAttachmentState, 'id'>, version: 'current' | 'sent' = 'current'): string {
  return inboxUrl(`/attachments/${encodeURIComponent(attachment.id)}/download${version === 'sent' ? '?version=sent' : ''}`);
}

/** An attached HTML page in a tab of its own, sandboxed, from its own folder ("Open in" → Browser). */
export function attachmentPageUrl(attachment: Pick<InboxAttachmentState, 'id'>, version: 'current' | 'sent' = 'current'): string {
  return inboxUrl(`/attachments/${encodeURIComponent(attachment.id)}/page${version === 'sent' ? '?version=sent' : ''}`);
}

/** Wider than this width-to-height ratio, an image is a panorama: the gallery crops it from the left, the viewer scrolls it sideways. */
export const WIDE_IMAGE_RATIO = 4;

/**
 * Whether an image fits in a `box`-pixel square at its own size, by the size
 * its header gave: a thumbnail draws it as it is rather than blown up (a 1×1
 * image is a dot, not a block of one colour).
 */
export function imageFitsWithin(attachment: Pick<InboxAttachmentState, 'width' | 'height'>, box: number): boolean {
  const { width, height } = attachment;
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0 && width <= box && height <= box;
}

/** The version a thumbnail or download should read: the sent one when the file on disk cannot be read. */
export function readableVersion(attachment: Pick<InboxAttachmentState, 'unavailable'>): 'current' | 'sent' {
  return attachment.unavailable ? 'sent' : 'current';
}

/** What a comment on code lines keeps beside Plannotator's annotation fields. */
export interface InboxCodeRange {
  lineStart: number;
  lineEnd: number;
  /**
   * The lines as they read when the comment was made, cut to
   * CODE_EXCERPT_MAX_CHARS when longer (a minified file's one line can be
   * hundreds of KB): then `length` and `hash` name the whole.
   */
  code: string;
  /** The whole lines' length, when `code` is an excerpt. */
  length?: number;
  /** `codeHash` of the whole lines, when `code` is an excerpt. */
  hash?: string;
}

/** The most of a comment's lines kept in its record and shown in the export; longer lines keep a hash of the whole. */
export const CODE_EXCERPT_MAX_CHARS = 4096;

/** A short hash of code lines (FNV-1a, 64 bits as two 32-bit halves with different seeds), to tell whether long lines still read the same. */
export function codeHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

/** Whether the file's lines still read as a comment's: by hash for an excerpt, by the text itself for a record that kept it whole (every record before excerpts). */
export function codeRangeMatches(range: InboxCodeRange, lines: string): boolean {
  if (range.hash !== undefined) return lines.length === range.length && codeHash(lines) === range.hash;
  return lines === range.code;
}

type CodeCommentAnnotation = Annotation & { inboxCode?: InboxCodeRange };

/** The line range a code comment is on, or null for any other annotation. */
export function codeRangeOf(annotation: Annotation): InboxCodeRange | null {
  const range = (annotation as CodeCommentAnnotation).inboxCode;
  if (!range || !Number.isInteger(range.lineStart) || !Number.isInteger(range.lineEnd) || range.lineStart < 1 || range.lineEnd < range.lineStart) return null;
  return range;
}

/** A line comment made in the code view, as the annotation the Inbox stores: the export reads its lines from `blockId` and `inboxCode`. */
export function codeCommentAnnotation(input: { id: string; lineStart: number; lineEnd: number; text: string; code: string; author?: string; createdA?: number }): CodeCommentAnnotation {
  const lines = input.code.split('\n');
  const first = lines.find((line) => line.trim() !== '')?.trim() ?? '';
  const quote = `${cutText(first, 120)}${lines.length > 1 ? ' …' : ''}`;
  return {
    id: input.id,
    blockId: `code-L${input.lineStart}-${input.lineEnd}`,
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: input.text,
    originalText: quote,
    createdA: input.createdA ?? Date.now(),
    ...(input.author ? { author: input.author } : {}),
    inboxCode:
      input.code.length > CODE_EXCERPT_MAX_CHARS
        ? { lineStart: input.lineStart, lineEnd: input.lineEnd, code: cutText(input.code, CODE_EXCERPT_MAX_CHARS), length: input.code.length, hash: codeHash(input.code) }
        : { lineStart: input.lineStart, lineEnd: input.lineEnd, code: input.code },
  };
}

/** A stored code comment as the code view draws it inline. */
export function codeAnnotationOf(annotation: Annotation, filePath: string): CodeAnnotation | null {
  const range = codeRangeOf(annotation);
  if (!range) return null;
  return {
    id: annotation.id,
    type: 'comment',
    scope: 'line',
    filePath,
    lineStart: range.lineStart,
    lineEnd: range.lineEnd,
    side: 'new',
    text: annotation.text,
    originalCode: range.code,
    createdAt: annotation.createdA,
    ...(annotation.author ? { author: annotation.author } : {}),
  } as CodeAnnotation;
}

/** One block per code comment's lines, so the export labels each "(line 12)" / "(lines 12–14)". */
export function codeCommentBlocks(annotations: readonly Annotation[]): Block[] {
  const blocks: Block[] = [];
  for (const annotation of annotations) {
    const range = codeRangeOf(annotation);
    if (!range || blocks.some((b) => b.id === annotation.blockId)) continue;
    blocks.push({
      id: annotation.blockId,
      type: 'paragraph',
      content: range.code,
      order: blocks.length + 1,
      startLine: range.lineStart,
      sourceLineCount: range.lineEnd - range.lineStart + 1,
    });
  }
  return blocks;
}

/** A comment on a whole image, with the person's marked-up copy when they drew on it. */
export function imageCommentAnnotation(input: { id: string; name: string; text: string; markup?: ImageAttachment | null; author?: string; createdA?: number }): Annotation {
  return {
    id: input.id,
    blockId: 'image',
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: input.text,
    originalText: input.name,
    createdA: input.createdA ?? Date.now(),
    ...(input.author ? { author: input.author } : {}),
    ...(input.markup ? { images: [input.markup] } : {}),
  };
}

/** A comment's moment kept to the millisecond (contract 4: seconds, millisecond precision). */
export function videoTimeOf(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000) / 1000);
}

/** The frame's name as a comment carries it: "launch-cut-v3 at 1:42". */
export function videoFrameName(name: string, time: number): string {
  return `${name.replace(/\.[^.]+$/, '') || name} at ${formatInboxVideoTime(time)}`;
}

/**
 * A comment at a moment of a video (contract 4): `blockId: "video"`,
 * `inboxVideo: { time }` in seconds, and the frame the window grabbed (or the
 * person's marked-up copy of it) as `images[0]`.
 */
export function videoCommentAnnotation(input: { id: string; name: string; time: number; text: string; frame?: ImageAttachment | null; author?: string; createdA?: number }): Annotation {
  const time = videoTimeOf(input.time);
  return {
    id: input.id,
    blockId: INBOX_VIDEO_BLOCK_ID,
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: input.text,
    originalText: `${input.name} at ${formatInboxVideoTime(time)}`,
    createdA: input.createdA ?? Date.now(),
    ...(input.author ? { author: input.author } : {}),
    ...(input.frame ? { images: [input.frame] } : {}),
    inboxVideo: { time },
  } as Annotation;
}

/** Video comments by the moment they are at (the panel, the rail, the export); a comment with no time sorts last. */
export function compareVideoTimes(a: unknown, b: unknown): number {
  return (readInboxVideoTime(a) ?? Number.POSITIVE_INFINITY) - (readInboxVideoTime(b) ?? Number.POSITIVE_INFINITY) || 0;
}

/** "102.4 s", or "14 s" (one decimal, none when whole). */
function secondsLabel(seconds: number): string {
  const tenths = Math.round(seconds * 10) / 10;
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)} s`;
}

/** The location line the export prints under a video comment: "At 1:42 (102.4 s of 7:41)" (without "of …" when the length is unknown). */
export function videoLocationLine(time: number, durationMs?: number): string {
  const of = typeof durationMs === 'number' && durationMs > 0 ? ` of ${formatInboxVideoTime(durationMs / 1000)}` : '';
  return `At ${formatInboxVideoTime(time)} (${secondsLabel(time)}${of})`;
}

/** A comment on a guided review's diff, as the review app made it, or null for an attachment's annotation. */
export function guideCommentOf(record: InboxAnnotationRecord): CodeAnnotation | null {
  return record.guide ? (record.annotation as unknown as CodeAnnotation) : null;
}

/** "line 12" / "lines 12-14", as the review app's cards read. */
function lineRangeLabel(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

/** The small tag beside a row in the chip's list: the element, diagram part, or a guided-review comment's lines. */
export function recordTag(record: InboxAnnotationRecord): string | null {
  if (record.guide) return lineRangeLabel(record.guide.line_start, record.guide.line_end);
  if (record.message) return null;
  return annotationTag(annotationOf(record));
}

/** The quoted text a row shows: a guided-review comment's first commented line, else the annotation's quote. */
export function recordQuote(record: InboxAnnotationRecord): string {
  const comment = guideCommentOf(record);
  if (!comment) return annotationQuote(annotationOf(record));
  const lines = (comment.selectedText ?? comment.originalCode ?? '').split('\n');
  const first = lines.find((line) => line.trim() !== '')?.trim() ?? '';
  return `${cutText(first, 120)}${lines.length > 1 && first ? ' …' : ''}`;
}

export const GUIDE_FEEDBACK_TITLE = 'Feedback on the guided review';

/** Quoted code in a fence no line of it can close (the review app's `fenced`). */
function fenced(code: string): string {
  const fence = codeFenceFor(code);
  return `${fence}\n${code}\n${fence}\n`;
}

/**
 * One comment as the review app's export writes it (exportReviewFeedback in
 * packages/review-editor/utils/exportFeedback.ts, line scope): the line range
 * and side, the comment, the lines it is on, any suggested code. Kept equal
 * to it by guideFeedback.test.ts.
 */
function guideCommentEntry(comment: CodeAnnotation, heading: string): string {
  const range = comment.lineStart === comment.lineEnd ? `Line ${comment.lineStart}` : `Lines ${comment.lineStart}-${comment.lineEnd}`;
  const token = comment.tokenText
    ? ` — \`\`${comment.tokenText.replace(/`/g, '\\`')}\`\`${comment.charStart != null ? ` (chars ${comment.charStart}-${comment.charEnd})` : ''}`
    : '';
  const prefix = comment.conventionalLabel
    ? `**${comment.conventionalLabel}${comment.decorations?.length ? ` (${comment.decorations.join(', ')})` : ''}:** `
    : '';
  let output = `${heading} ${range} (${comment.side})${token}\n`;
  if (comment.text) output += `${prefix}${comment.text}\n`;
  else if (prefix) output += `${prefix.trimEnd()}\n`;
  if (comment.selectedText) output += `\n**Highlighted text:**\n${fenced(comment.selectedText)}`;
  if ((comment.suggestedCode || comment.text) && comment.originalCode) output += `\n**Replaces:**\n${fenced(comment.originalCode)}`;
  if (comment.suggestedCode) output += `\n**Suggested code:**\n${fenced(comment.suggestedCode)}`;
  return `${output}\n`;
}

/** The review app's per-file sections for a set of line comments: `## path`, then each comment by line. */
export function guideCommentSections(comments: readonly CodeAnnotation[]): string {
  const byFile = new Map<string, CodeAnnotation[]>();
  for (const comment of comments) byFile.set(comment.filePath, [...(byFile.get(comment.filePath) ?? []), comment]);
  let output = '';
  for (const [file, list] of byFile) {
    output += `## ${file}\n\n`;
    for (const comment of [...list].sort((a, b) => a.lineStart - b.lineStart)) output += guideCommentEntry(comment, '###');
  }
  return output;
}

/**
 * The comments on guided reviews' diffs, as the feedback text a Send carries:
 * one section per guided review, under "Feedback on the guided review", with
 * the review app's export of its comments (file path, line numbers and side,
 * the comment, the commented lines).
 */
export function guideFeedback(records: readonly InboxAnnotationRecord[]): string {
  const byMessage = new Map<string, { title: string; comments: CodeAnnotation[] }>();
  for (const record of records) {
    const comment = guideCommentOf(record);
    if (!comment || !record.guide) continue;
    const entry = byMessage.get(record.message_id) ?? { title: record.guide.title, comments: [] };
    entry.comments.push(comment);
    byMessage.set(record.message_id, entry);
  }
  return [...byMessage.values()]
    .map(
      ({ title, comments }) =>
        `# ${GUIDE_FEEDBACK_TITLE}\n\nThe following comments are on the diffs of the guided review "${title}" you sent, one section per file. Line numbers are the file's own: (new) the changed file, (old) the original.\n\n${guideCommentSections(comments)}`.trim(),
    )
    .join('\n\n');
}

/**
 * A file's heading in the export: an attached file by its path; an image the
 * message's text shows by its src as written plus the message it was in, so
 * the agent knows which picture it was: `design/checkout-b.png (image in
 * your 11:22 AM message)`. When another message of `others` shows the same
 * src within the same minute, the time carries its seconds (`11:22:41 AM`),
 * and when that still ties, the message's place among them (`message 2`), so
 * two pictures never share one heading.
 */
export function exportFileLabel(
  attachment: Pick<InboxAttachmentState, 'path' | 'name' | 'ref' | 'sent_at'> & { message_id?: string },
  projectRoot: string,
  others: readonly Pick<InboxAttachmentState, 'ref' | 'sent_at' | 'message_id'>[] = [],
  /** The image is in the person's own message: "(image in my … message)", never "your". */
  mine = false,
): string {
  const label = attachmentLabel(attachment, projectRoot);
  if (attachment.ref === undefined) return label;
  const whose = mine ? 'my' : 'your';
  const minute = whenTime(attachment.sent_at);
  const sameRef = others.filter((o) => o.ref === attachment.ref && o.message_id !== attachment.message_id && whenTime(o.sent_at) === minute);
  if (sameRef.length === 0) return `${label} (image in ${whose} ${minute ? `${minute} ` : ''}message)`;
  const secondsOf = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  };
  const second = secondsOf(attachment.sent_at);
  const tied = sameRef.filter((o) => secondsOf(o.sent_at) === second);
  if (tied.length === 0) return `${label} (image in ${whose} ${second} message)`;
  const order = [...tied, { sent_at: attachment.sent_at, message_id: attachment.message_id ?? '' }]
    .map((o) => `${o.sent_at}\0${o.message_id ?? ''}`)
    .filter((key, index, all) => all.indexOf(key) === index)
    .sort();
  const place = order.indexOf(`${attachment.sent_at}\0${attachment.message_id ?? ''}`) + 1;
  return `${label} (image in ${whose} ${second} message ${place})`;
}

/** A comment on the text of an agent's message (approval "inbox-message-comments"), or false for any other annotation. */
export function isMessageComment(record: InboxAnnotationRecord): boolean {
  return record.message !== undefined;
}

/** A comment on a file (not a guided review's diff, not a message's text): what the file viewers list. */
export function isFileComment(record: InboxAnnotationRecord): boolean {
  return !record.guide && !record.message;
}

export const MESSAGE_FEEDBACK_HEADING = {
  title: 'Feedback on your messages',
  intro: 'The following feedback is on the text of your messages in this thread, one section per message. Each quote is the words I selected (as shown on screen) in your message.',
};

/** A message comment's section heading: "Feedback on your message from 2:58 PM (msg_…)", the time in the person's own time zone. */
export function messageFeedbackLabel(record: Pick<InboxAnnotationRecord, 'message_id' | 'message'>, time: (iso: string) => string = whenTime): string {
  const at = record.message ? time(record.message.at) : '';
  return `Feedback on your message${at ? ` from ${at}` : ''} (${record.message_id})`;
}

/**
 * One comment on a message's text: "Feedback on" the words selected, then
 * the comment, every line of it quoted. The words are the rendered text, so
 * they can span paragraphs and hold anything a message can (a code block, a
 * line starting with `#`): words on one line sit inline in quotes, words on
 * several lines go in a fenced block no line of theirs can close
 * (`codeFenceFor`, as the guided-review export quotes code), so nothing in
 * them reads as a heading or leaves a fence open.
 */
function messageCommentEntry(annotation: Annotation, number: number): string {
  const words = annotation.originalText ?? '';
  const label = annotation.isQuickLabel && annotation.text ? `[${annotation.text}] ` : '';
  const multiline = /[\r\n]/.test(words);
  let out = `### ${number}. ${label}Feedback on${multiline ? ':' : `: "${words}"`}\n`;
  if (multiline) {
    const fence = codeFenceFor(words);
    out += `${fence}\n${words.replace(/\r\n?/g, '\n')}\n${fence}\n`;
  }
  if (!annotation.isQuickLabel && annotation.text) out += `${annotation.text.split(/\r\n|\r|\n/).map((line) => `> ${line}`).join('\n')}\n`;
  return `${out}\n`;
}

/** Comments in the order their words come in the message: by block, then by where in it. */
function compareInMessage(a: Annotation, b: Annotation): number {
  return String(a.blockId ?? '').localeCompare(String(b.blockId ?? ''), undefined, { numeric: true }) || (a.startOffset ?? 0) - (b.startOffset ?? 0);
}

/**
 * The comments on the text of agents' messages, as the feedback text a Send
 * carries (approval "inbox-message-comments"): one section per message,
 * oldest message first, under "Feedback on your message from <time> (<id>)",
 * each comment quoting the words selected, then the comment. No line
 * numbers: the words are what find the place.
 */
export function messageFeedback(records: readonly InboxAnnotationRecord[], time: (iso: string) => string = whenTime): string {
  const messages = records.filter((record) => record.message);
  if (messages.length === 0) return '';
  const byMessage = new Map<string, { at: string; annotations: Annotation[] }>();
  for (const record of messages) {
    const entry = byMessage.get(record.message_id) ?? { at: record.message!.at, annotations: [] };
    entry.annotations.push(annotationOf(record));
    byMessage.set(record.message_id, entry);
  }
  const ordered = [...byMessage].sort(([idA, a], [idB, b]) => a.at.localeCompare(b.at) || idA.localeCompare(idB));
  let out = `# ${MESSAGE_FEEDBACK_HEADING.title}\n\n${MESSAGE_FEEDBACK_HEADING.intro}\n\n`;
  for (const [id, entry] of ordered) {
    const list = [...entry.annotations].sort(compareInMessage);
    out += `## ${messageFeedbackLabel({ message_id: id, message: { at: entry.at } }, time)}\n\n`;
    out += `I've reviewed this message and have ${list.length} piece${list.length === 1 ? '' : 's'} of feedback:\n\n`;
    list.forEach((annotation, index) => {
      out += messageCommentEntry(annotation, index + 1);
    });
  }
  return `${out}---`;
}

export const ATTACHMENT_FEEDBACK_HEADING = {
  title: 'Feedback on the attached files',
  intro: 'The following feedback is on the files you attached, one section per file and version.',
};

/**
 * What a file's heading in the export adds when the comments are on a version
 * that was sent rather than the file as it is now. The thread reads them back
 * to link the heading in the person's sent reply (replyFileLinks.ts).
 */
export const SENT_VERSION_SUFFIX = {
  /** An image the store captured the first time the thread was read. */
  firstSaw: ' (the version I first saw)',
  /** An image in the person's own message. */
  mine: ' (the version I sent)',
  yours: ' (the version you sent)',
} as const;

/** The same heading when the feedback covers an image your message's text showed. */
export const ATTACHMENT_AND_IMAGE_FEEDBACK_HEADING = {
  title: ATTACHMENT_FEEDBACK_HEADING.title,
  intro: 'The following feedback is on the files you attached and the images your messages showed, one section per file and version.',
};

/**
 * The feedback text a Send carries after the picks: the comments on the text
 * of agents' messages (`messageFeedback`), then Plannotator's export of the
 * files' annotations (the same entry renderer `exportAnnotations` uses), one
 * section per file and version, then the comments on guided reviews' diffs
 * (`guideFeedback`). `texts` holds each version's text, keyed
 * `<attachment id>\0<version>`, so line numbers name the lines the person read.
 */
export function attachmentFeedback(
  records: readonly InboxAnnotationRecord[],
  attachments: readonly InboxAttachmentState[],
  texts: ReadonlyMap<string, string>,
  projectRoot: string,
  /** The person's own messages (their images are named "image in my … message"). */
  options: {
    personMessageIds?: ReadonlySet<string>;
    /**
     * The names of the agents a comment tags with `@` (approval "inbox-tag-agents"): the export marks
     * which comment carried a tag ("Tagged Pi"). Absent: tags are not named.
     */
    tagNames?: (ids: readonly string[]) => string[];
  } = {},
): string {
  if (records.length === 0) return '';
  const messages = messageFeedback(records);
  let inlineImages = false;
  const groups = new Map<string, { annotations: Annotation[]; markdown?: string; blocks: Block[]; video?: { durationMs?: number } }>();
  for (const record of records) {
    // Comments on a guided review's diff go in their own section, after the files'; a message's text has its own, before them.
    if (record.guide || record.message) continue;
    const attachment = attachments.find((a) => a.id === record.attachment_id) ?? attachments.find((a) => a.path === record.path);
    const sent = record.version !== 'current';
    if (!attachment) {
      // A file the caller does not list (an image a message shows, on a phone app older than
      // `inline_images`): its comment still rides the Send, under the path it was made on.
      const label = `${record.path}${sent ? SENT_VERSION_SUFFIX.yours : ''}`;
      const group = groups.get(label) ?? { annotations: [], blocks: [] };
      groups.set(label, group);
      const { exportLocation: _dropped, ...annotation } = annotationOf(record) as Annotation & { exportLocation?: unknown };
      group.annotations.push(annotation as Annotation);
      continue;
    }
    if (attachment.ref !== undefined) inlineImages = true;
    const mine = attachment.ref !== undefined && options.personMessageIds?.has(attachment.message_id) === true;
    const sentLabel = attachment.captured === 'on_open' ? SENT_VERSION_SUFFIX.firstSaw : mine ? SENT_VERSION_SUFFIX.mine : SENT_VERSION_SUFFIX.yours;
    const label = `${exportFileLabel(attachment, projectRoot, attachments, mine)}${sent ? sentLabel : ''}`;
    let group = groups.get(label);
    if (!group) {
      const text = texts.get(`${attachment.id}\0${record.version}`) ?? '';
      // Code comments name their own lines; an image has no lines.
      const kind = readInboxAttachmentKind(attachment.kind);
      group = {
        annotations: [],
        blocks: kind === 'code' ? [] : attachmentBlocks(kind, text, attachment.name),
        ...(kind === 'video' ? { video: { durationMs: attachment.duration_ms } } : {}),
      };
      groups.set(label, group);
    }
    // Never a client's `exportLocation` (a record from before the store dropped it): only the line computed below prints.
    const { exportLocation: _stored, ...annotation } = annotationOf(record) as Annotation & { exportLocation?: unknown };
    group.annotations.push(annotation as Annotation);
  }
  for (const group of groups.values()) {
    const code = codeCommentBlocks(group.annotations);
    if (code.length > 0) group.blocks = [...group.blocks, ...code];
    // A video's comments go by the moment they are at, each with its "At 1:42 (102.4 s of 7:41)" line.
    // Export copies only: the exporter orders same-block entries by offset, and prints `exportLocation`.
    if (group.video) {
      const durationMs = group.video.durationMs;
      group.annotations = [...group.annotations].sort(compareVideoTimes).map((annotation, index) => {
        const time = readInboxVideoTime(annotation);
        return { ...annotation, startOffset: index, endOffset: index, ...(time !== null ? { exportLocation: videoLocationLine(time, durationMs) } : {}) } as Annotation;
      });
    }
  }
  // A comment that tags agents says so under its heading, after a video's moment (export copies only).
  if (options.tagNames) {
    for (const group of groups.values()) {
      group.annotations = group.annotations.map((annotation) => {
        const ids = Array.isArray(annotation.mentions) ? annotation.mentions : [];
        const names = ids.length > 0 ? options.tagNames!(ids) : [];
        if (names.length === 0) return annotation;
        const line = `Tagged ${names.join(', ')}: this comment sends the reply to ${names.length === 1 ? 'it' : 'them'} too.`;
        const before = (annotation as Annotation & { exportLocation?: string }).exportLocation;
        return { ...annotation, exportLocation: before ? `${before} · ${line}` : line } as Annotation;
      });
    }
  }
  const entries = new Map([...groups].map(([label, group]) => [label, { annotations: group.annotations, globalAttachments: [], blocks: group.blocks }]));
  const files = records.some(isFileComment) ? exportLinkedDocAnnotations(entries, inlineImages ? ATTACHMENT_AND_IMAGE_FEEDBACK_HEADING : ATTACHMENT_FEEDBACK_HEADING).trim() : '';
  return [messages, files, guideFeedback(records)].filter(Boolean).join('\n\n');
}
