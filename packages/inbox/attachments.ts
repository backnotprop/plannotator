/**
 * The window's side of attachments (step 2): how a file's text becomes
 * Plannotator's blocks, how the person's annotations read in the reply chip,
 * and the feedback text a Send carries after the picks.
 */

import { shouldStripFrontmatter } from '@plannotator/core/annotatable';
import type { InboxAnnotationRecord, InboxAttachmentKind, InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { Annotation, Block } from '@plannotator/ui/types';
import { diagramDocumentBlocks, exportLinkedDocAnnotations, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';

/** Plannotator's blocks for a file: one diagram block for a diagram source, the markdown pipeline for text, none for HTML. */
export function attachmentBlocks(kind: InboxAttachmentKind, text: string, name: string): Block[] {
  if (kind === 'html') return [];
  if (kind === 'mermaid' || kind === 'graphviz') return diagramDocumentBlocks(text, kind);
  return parseMarkdownToBlocks(text, shouldStripFrontmatter(name) ? undefined : { frontmatter: false });
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

/** A file's path as the agent knows it: relative to its project when inside it. */
export function attachmentLabel(attachment: Pick<InboxAttachmentState, 'path' | 'name'>, projectRoot: string): string {
  const root = projectRoot.replace(/[\\/]+$/, '');
  if (attachment.path.startsWith(`${root}/`) || attachment.path.startsWith(`${root}\\`)) return attachment.path.slice(root.length + 1);
  return attachment.name;
}

export const ATTACHMENT_FEEDBACK_HEADING = {
  title: 'Feedback on the attached files',
  intro: 'The following feedback is on the files you attached, one section per file and version.',
};

/**
 * The feedback text a Send carries after the picks: Plannotator's export of
 * the annotations (the same entry renderer `exportAnnotations` uses), one
 * section per file and version. `texts` holds each version's text, keyed
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
    const attachment = attachments.find((a) => a.id === record.attachment_id) ?? attachments.find((a) => a.path === record.path);
    if (!attachment) continue;
    const sent = record.version !== 'current';
    const label = `${attachmentLabel(attachment, projectRoot)}${sent ? ' (the version you sent)' : ''}`;
    let group = groups.get(label);
    if (!group) {
      const text = texts.get(`${attachment.id}\0${record.version}`) ?? '';
      group = { annotations: [], blocks: attachmentBlocks(attachment.kind, text, attachment.name) };
      groups.set(label, group);
    }
    group.annotations.push(annotationOf(record));
  }
  const entries = new Map([...groups].map(([label, group]) => [label, { annotations: group.annotations, globalAttachments: [], blocks: group.blocks }]));
  return exportLinkedDocAnnotations(entries, ATTACHMENT_FEEDBACK_HEADING).trim();
}
