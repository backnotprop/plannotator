/**
 * The window's side of attachments (step 2): how a file's text becomes
 * Plannotator's blocks, how the person's annotations read in the reply chip,
 * and the feedback text a Send carries after the picks.
 */

import { shouldStripFrontmatter } from '@plannotator/core/annotatable';
import { readInboxAttachmentKind, type InboxAnnotationRecord, type InboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { AnnotationType, type Annotation, type Block, type CodeAnnotation, type ImageAttachment } from '@plannotator/ui/types';
import { diagramDocumentBlocks, exportLinkedDocAnnotations, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';

/** Plannotator's blocks for a file: one diagram block for a diagram source, one code block for code, the markdown pipeline for text, none for HTML or a binary kind. */
export function attachmentBlocks(kindValue: InboxAttachmentKind | string, text: string, name: string): Block[] {
  const kind = readInboxAttachmentKind(kindValue);
  if (kind === 'html' || kind === 'image' || kind === 'pdf' || kind === 'file') return [];
  if (kind === 'mermaid' || kind === 'graphviz') return diagramDocumentBlocks(text, kind);
  if (kind === 'code') return codeDocumentBlocks(text, name);
  return parseMarkdownToBlocks(text, shouldStripFrontmatter(name) ? undefined : { frontmatter: false });
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

/** A file's path as the agent knows it: relative to its project when inside it, else the absolute path it attached. */
export function attachmentLabel(attachment: Pick<InboxAttachmentState, 'path' | 'name'>, projectRoot: string): string {
  const root = projectRoot.replace(/[\\/]+$/, '');
  if (attachment.path.startsWith(`${root}/`) || attachment.path.startsWith(`${root}\\`)) return attachment.path.slice(root.length + 1);
  return attachment.path || attachment.name;
}

/** Where an attachment's bytes are served: an image for `<img src>`, and any kind as a download. By id only. */
export function attachmentImageUrl(attachment: Pick<InboxAttachmentState, 'id'>, version: 'current' | 'sent' = 'current'): string {
  return `/api/inbox/attachments/${encodeURIComponent(attachment.id)}/image${version === 'sent' ? '?version=sent' : ''}`;
}

export function attachmentDownloadUrl(attachment: Pick<InboxAttachmentState, 'id'>, version: 'current' | 'sent' = 'current'): string {
  return `/api/inbox/attachments/${encodeURIComponent(attachment.id)}/download${version === 'sent' ? '?version=sent' : ''}`;
}

/** The version a thumbnail or download should read: the sent one when the file on disk cannot be read. */
export function readableVersion(attachment: Pick<InboxAttachmentState, 'unavailable'>): 'current' | 'sent' {
  return attachment.unavailable ? 'sent' : 'current';
}

/** What a comment on code lines keeps beside Plannotator's annotation fields. */
export interface InboxCodeRange {
  lineStart: number;
  lineEnd: number;
  /** The lines as they read when the comment was made. */
  code: string;
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
  const quote = `${first.length > 120 ? `${first.slice(0, 119)}…` : first}${lines.length > 1 ? ' …' : ''}`;
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
    inboxCode: { lineStart: input.lineStart, lineEnd: input.lineEnd, code: input.code },
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
  return annotationTag(annotationOf(record));
}

/** The quoted text a row shows: a guided-review comment's first commented line, else the annotation's quote. */
export function recordQuote(record: InboxAnnotationRecord): string {
  const comment = guideCommentOf(record);
  if (!comment) return annotationQuote(annotationOf(record));
  const lines = (comment.selectedText ?? comment.originalCode ?? '').split('\n');
  const first = lines.find((line) => line.trim() !== '')?.trim() ?? '';
  return `${first.length > 120 ? `${first.slice(0, 119)}…` : first}${lines.length > 1 && first ? ' …' : ''}`;
}

export const GUIDE_FEEDBACK_TITLE = 'Feedback on the guided review';

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
  if (comment.selectedText) output += `\n**Highlighted text:**\n\`\`\`\n${comment.selectedText}\n\`\`\`\n`;
  if ((comment.suggestedCode || comment.text) && comment.originalCode) output += `\n**Replaces:**\n\`\`\`\n${comment.originalCode}\n\`\`\`\n`;
  if (comment.suggestedCode) output += `\n**Suggested code:**\n\`\`\`\n${comment.suggestedCode}\n\`\`\`\n`;
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

export const ATTACHMENT_FEEDBACK_HEADING = {
  title: 'Feedback on the attached files',
  intro: 'The following feedback is on the files you attached, one section per file and version.',
};

/**
 * The feedback text a Send carries after the picks: Plannotator's export of
 * the annotations (the same entry renderer `exportAnnotations` uses), one
 * section per file and version, then the comments on guided reviews' diffs
 * (`guideFeedback`). `texts` holds each version's text, keyed
 * `<attachment id>\0<version>`, so line numbers name the lines the person read.
 */
export function attachmentFeedback(
  records: readonly InboxAnnotationRecord[],
  attachments: readonly InboxAttachmentState[],
  texts: ReadonlyMap<string, string>,
  projectRoot: string,
): string {
  if (records.length === 0) return '';
  const groups = new Map<string, { annotations: Annotation[]; markdown?: string; blocks: Block[] }>();
  for (const record of records) {
    // Comments on a guided review's diff go in their own section, after the files'.
    if (record.guide) continue;
    const attachment = attachments.find((a) => a.id === record.attachment_id) ?? attachments.find((a) => a.path === record.path);
    if (!attachment) continue;
    const sent = record.version !== 'current';
    const label = `${attachmentLabel(attachment, projectRoot)}${sent ? ' (the version you sent)' : ''}`;
    let group = groups.get(label);
    if (!group) {
      const text = texts.get(`${attachment.id}\0${record.version}`) ?? '';
      // Code comments name their own lines; an image has no lines.
      const kind = readInboxAttachmentKind(attachment.kind);
      group = { annotations: [], blocks: kind === 'code' ? [] : attachmentBlocks(kind, text, attachment.name) };
      groups.set(label, group);
    }
    group.annotations.push(annotationOf(record));
  }
  for (const group of groups.values()) {
    const code = codeCommentBlocks(group.annotations);
    if (code.length > 0) group.blocks = [...group.blocks, ...code];
  }
  const entries = new Map([...groups].map(([label, group]) => [label, { annotations: group.annotations, globalAttachments: [], blocks: group.blocks }]));
  const files = records.some((record) => !record.guide) ? exportLinkedDocAnnotations(entries, ATTACHMENT_FEEDBACK_HEADING).trim() : '';
  return [files, guideFeedback(records)].filter(Boolean).join('\n\n');
}
