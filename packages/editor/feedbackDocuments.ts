/**
 * Which annotations go under which heading in a submitted feedback export.
 *
 * The export has a primary section for the session's own document (the plan,
 * the annotated file, or the folder) and a section listing every OTHER
 * document by path. The host's live state (`annotations`, `blocks`) is the
 * ACTIVE document, which is the root only while no linked/folder document is
 * open. Exporting the live state as the primary section AND the linked-doc map
 * (which also carries the active document) printed the open document twice.
 * This module decides the split once, for every export path.
 */
import type { Annotation, Block, ImageAttachment } from '@plannotator/ui/types';
import type { FeedbackDocuments } from '@plannotator/ui/hooks/useLinkedDoc';
import {
  diagramDocumentBlocks,
  parseMarkdownToBlocks,
  BUNDLE_DOC_EXPORT_HEADING,
  FOLDER_DOC_EXPORT_HEADING,
  LINKED_DOC_EXPORT_HEADING,
  type LinkedDocAnnotationEntry,
  type LinkedDocExportHeading,
  type MessageAnnotationEntry,
} from '@plannotator/ui/utils/parser';
import { diagramRenderKindForPath, isDiagramRenderKind, shouldStripFrontmatter } from '@plannotator/shared/annotatable';

/**
 * Blocks for a document identified by path: a diagram source (.mmd/.dot) is
 * ONE diagram block over its raw text, everything else is the markdown parse
 * with that path's frontmatter rule.
 */
export const blocksForDocument = (filepath: string, text: string): Block[] => {
  const kind = diagramRenderKindForPath(filepath);
  return kind !== null
    ? diagramDocumentBlocks(text, kind)
    : parseMarkdownToBlocks(text, { frontmatter: shouldStripFrontmatter(filepath) });
};

/**
 * Merge local annotations with SSE-delivered external ones, dropping
 * draft-restored copies of externals that SSE re-delivered (same source,
 * type and quote). The SSE version wins.
 */
export function mergeExternalAnnotations(local: Annotation[], external: Annotation[]): Annotation[] {
  if (external.length === 0) return local;
  const kept = local.filter((a) => {
    if (!a.source) return true;
    return !external.some((ext) =>
      ext.source === a.source &&
      ext.type === a.type &&
      ext.originalText === a.originalText
    );
  });
  return [...kept, ...external];
}

export interface FeedbackSectionsInput {
  /** The split from useLinkedDoc. */
  feedbackDocuments: FeedbackDocuments;
  /** Live state of the ACTIVE document; `annotations` already carries externals. */
  live: { annotations: Annotation[]; globalAttachments: ImageAttachment[]; blocks: Block[] };
  /** SSE externals. They belong to the session, not to one document, so they
   *  ride the primary section whichever document is open. */
  externalAnnotations: Annotation[];
  /** The root document's path (annotate file sessions); drives its parse. */
  sourceFilePath?: string;
  sourceConverted: boolean;
  annotateSource: 'file' | 'message' | 'folder' | null;
  /**
   * A review of several files: the files in review order. Documents are
   * exported in this order (anything else, such as a linked document, after
   * them in the order it was opened) under the bundle heading.
   */
  bundleOrder?: readonly string[] | null;
}

export interface FeedbackSections {
  /** The primary section: the root document. */
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
  blocks: Block[];
  sourceConverted: boolean;
  /** Every other document, once, by path, with blocks for line labels. */
  linkedDocuments: Map<string, LinkedDocAnnotationEntry>;
  linkedDocumentsHeading: LinkedDocExportHeading;
}

export function resolveFeedbackSections(input: FeedbackSectionsInput): FeedbackSections {
  const { root, documents } = input.feedbackDocuments;

  let annotations = input.live.annotations;
  let globalAttachments = input.live.globalAttachments;
  let blocks = input.live.blocks;
  if (root) {
    // A linked document is open, so the live state is THAT document (it is in
    // `documents`); the primary section is the stashed root.
    annotations = mergeExternalAnnotations(root.annotations, input.externalAnnotations);
    globalAttachments = root.globalAttachments;
    const markdown = root.markdown ?? '';
    blocks = isDiagramRenderKind(root.renderAs)
      ? diagramDocumentBlocks(markdown, root.renderAs)
      : parseMarkdownToBlocks(markdown, { frontmatter: shouldStripFrontmatter(input.sourceFilePath) });
  }

  const order = input.bundleOrder ?? null;
  const rank = (path: string) => {
    if (!order) return 0;
    const index = order.indexOf(path);
    return index === -1 ? order.length : index;
  };
  // Stable sort: unlisted documents keep their opening order after the files.
  const entries = order
    ? [...documents].sort(([a], [b]) => rank(a) - rank(b))
    : [...documents];
  const linkedDocuments = new Map<string, LinkedDocAnnotationEntry>();
  for (const [filepath, entry] of entries) {
    linkedDocuments.set(filepath, entry.markdown
      ? { ...entry, blocks: blocksForDocument(filepath, entry.markdown) }
      : entry);
  }

  return {
    annotations,
    globalAttachments,
    blocks,
    sourceConverted: input.sourceConverted,
    linkedDocuments,
    linkedDocumentsHeading: order
      ? BUNDLE_DOC_EXPORT_HEADING
      : input.annotateSource === 'folder'
        ? FOLDER_DOC_EXPORT_HEADING
        : LINKED_DOC_EXPORT_HEADING,
  };
}

/**
 * Multi-message annotate-last: the per-message entries are built from each
 * message's LOCAL annotations, so SSE externals (agent / WebMCP comments)
 * reached neither the export nor the submit body. They are about what is on
 * screen, so they ride the CURRENT message's entry (the first entry, the
 * latest message, when the current one is not among them), deduped against
 * draft-restored copies exactly like the single-document path.
 */
export function mergeExternalsIntoMessageEntries(
  entries: MessageAnnotationEntry[],
  currentMessageId: string | null | undefined,
  externalAnnotations: Annotation[],
): MessageAnnotationEntry[] {
  if (externalAnnotations.length === 0 || entries.length === 0) return entries;
  const found = entries.findIndex((entry) => entry.messageId === currentMessageId);
  const index = found === -1 ? 0 : found;
  return entries.map((entry, i) => i === index
    ? { ...entry, annotations: mergeExternalAnnotations(entry.annotations, externalAnnotations) }
    : entry);
}

/**
 * One submitted annotation. `documentPath` is set on comments made on a
 * document OTHER than the session's own (a folder session's files, a linked
 * document); absent means the session's own document or message. Additive:
 * the server and the feedback archive read it, nothing else does.
 */
export type SubmittedAnnotation = Annotation & { documentPath?: string };

/**
 * The `annotations` array a submit body carries: every annotation the
 * feedback export covers, so the count a host reports and the archive records
 * matches the text the agent reads. It used to be the OPEN document's
 * annotations only, so a folder session with comments in two files reported
 * "1 comment".
 */
export function collectSubmittedAnnotations(
  sections: Pick<FeedbackSections, 'annotations' | 'linkedDocuments'>,
  messageEntries?: readonly MessageAnnotationEntry[],
): SubmittedAnnotation[] {
  const out: SubmittedAnnotation[] = [];
  const addDocuments = (documents: ReadonlyMap<string, LinkedDocAnnotationEntry> | undefined) => {
    if (!documents) return;
    for (const [documentPath, entry] of documents) {
      for (const annotation of entry.annotations) out.push({ ...annotation, documentPath });
    }
  };
  if (messageEntries) {
    // Multi-message annotate-last: the export walks every message.
    for (const entry of messageEntries) {
      out.push(...entry.annotations);
      addDocuments(entry.linkedDocs);
    }
    return out;
  }
  out.push(...sections.annotations);
  addDocuments(sections.linkedDocuments);
  return out;
}
