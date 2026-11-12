import type { Annotation, Block, DocumentRenderAs, ImageAttachment } from '@plannotator/ui/types';
import type { FeedbackDocuments } from '@plannotator/ui/hooks/useLinkedDoc';
import {
  codeDocumentBlocks,
  diagramDocumentBlocks,
  parseMarkdownToBlocks,
  BUNDLE_DOC_EXPORT_HEADING,
  FOLDER_DOC_EXPORT_HEADING,
  LINKED_DOC_EXPORT_HEADING,
  type LinkedDocAnnotationEntry,
  type LinkedDocExportHeading,
  type MessageAnnotationEntry,
} from '@plannotator/ui/utils/parser';
import { parseAsciidocToBlocks } from '@plannotator/ui/utils/asciidocParser';
import { codeDocumentLanguage, documentRenderKindForPath, isDiagramRenderKind, shouldStripFrontmatter } from '@plannotator/shared/annotatable';

export const blocksForRenderAs = (
  text: string,
  renderAs: DocumentRenderAs | undefined,
  frontmatter: boolean,
  path?: string | null,
): Block[] => {
  if (isDiagramRenderKind(renderAs)) return diagramDocumentBlocks(text, renderAs);
  if (renderAs === 'asciidoc') return parseAsciidocToBlocks(text);
  if (renderAs === 'code') return codeDocumentBlocks(text, codeDocumentLanguage(path));
  return parseMarkdownToBlocks(text, { frontmatter });
};

export const blocksForDocument = (filepath: string, text: string): Block[] =>
  blocksForRenderAs(text, documentRenderKindForPath(filepath) ?? 'markdown', shouldStripFrontmatter(filepath), filepath);

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
  feedbackDocuments: FeedbackDocuments;
  live: { annotations: Annotation[]; globalAttachments: ImageAttachment[]; blocks: Block[] };
  externalAnnotations: Annotation[];
  sourceFilePath?: string;
  sourceConverted: boolean;
  annotateSource: 'file' | 'message' | 'folder' | null;
  bundleOrder?: readonly string[] | null;
}

export interface FeedbackSections {
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
  blocks: Block[];
  sourceConverted: boolean;
  linkedDocuments: Map<string, LinkedDocAnnotationEntry>;
  linkedDocumentsHeading: LinkedDocExportHeading;
}

export function resolveFeedbackSections(input: FeedbackSectionsInput): FeedbackSections {
  const { root, documents } = input.feedbackDocuments;

  let annotations = input.live.annotations;
  let globalAttachments = input.live.globalAttachments;
  let blocks = input.live.blocks;
  if (root) {
    annotations = mergeExternalAnnotations(root.annotations, input.externalAnnotations);
    globalAttachments = root.globalAttachments;
    const markdown = root.markdown ?? '';
    blocks = blocksForRenderAs(markdown, root.renderAs, shouldStripFrontmatter(input.sourceFilePath), input.sourceFilePath);
  }

  const order = input.bundleOrder ?? null;
  const rank = (path: string) => {
    if (!order) return 0;
    const index = order.indexOf(path);
    return index === -1 ? order.length : index;
  };
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

export type SubmittedAnnotation = Annotation & { documentPath?: string };

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
