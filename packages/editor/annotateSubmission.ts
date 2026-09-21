import type {
  Annotation,
  Block,
  CodeAnnotation,
  EditorAnnotation,
  ImageAttachment,
} from "@plannotator/ui/types";
import {
  exportAnnotations,
  exportCodeFileAnnotations,
  exportEditorAnnotations,
  exportLinkedDocAnnotations,
  exportMessageAnnotations,
  parseMarkdownToBlocks,
  type LinkedDocAnnotationEntry,
  type MessageAnnotationEntry,
} from "@plannotator/ui/utils/parser";
import { shouldStripFrontmatter } from "@plannotator/shared/annotatable";
import { composeFeedbackWithEditSections } from "./directEdits";

export interface AnnotateApprovalBodyInput {
  supported: boolean;
  draftGeneration: number;
  feedback: string;
  annotations: unknown[];
  codeAnnotations: unknown[];
  /** Which message the notes are about (annotate-last picker). */
  selectedMessageId?: string;
  /** "messages" when the notes span more than one selected message. */
  feedbackScope?: "message" | "messages";
}

/**
 * The zero-feedback payload sentence. Every existing CLI consumer's plain-mode
 * output and the strict-gate exit codes depend on this exact byte sequence
 * (spec §5.3/§6.1), and the approval framing below reuses it so "Done with a
 * note…" can never read as a change request.
 */
export const ANNOTATE_NO_FEEDBACK_SENTENCE =
  "User reviewed the document and has no feedback.";

export function buildAnnotateApprovalBody(
  input: AnnotateApprovalBodyInput,
): {
  draftGeneration: number;
  feedback?: string;
  annotations?: unknown[];
  codeAnnotations?: unknown[];
  selectedMessageId?: string;
  feedbackScope?: "message" | "messages";
} {
  if (!input.supported) {
    return { draftGeneration: input.draftGeneration };
  }
  return {
    draftGeneration: input.draftGeneration,
    feedback: input.feedback,
    annotations: input.annotations,
    codeAnnotations: input.codeAnnotations,
    // Notes must anchor to the same message Send Feedback would target.
    ...(input.selectedMessageId ? { selectedMessageId: input.selectedMessageId } : {}),
    ...(input.feedbackScope ? { feedbackScope: input.feedbackScope } : {}),
  };
}

export interface CompleteAnnotateFeedbackInput {
  blocks: Block[];
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
  linkedDocuments: Map<string, LinkedDocAnnotationEntry>;
  editorAnnotations: EditorAnnotation[];
  codeAnnotations: CodeAnnotation[];
  title: string;
  subject: string;
  sourceConverted: boolean;
  directEditsSection: string;
  savedFileChangesSection: string;
  messageEntries?: MessageAnnotationEntry[];
  /**
   * Positive-finish framing. Non-gated annotate has no approve channel —
   * every outcome is one feedback string — so this prefixes the zero-state
   * sentence before the annotation sections (idempotent when the text already
   * is the sentence). Since the empty-menu collapse (the maintainer merged
   * "Done with a note…" into the single unframed "Send a note…"), the only
   * caller is the non-gated discard path, which frames its positive finish
   * over any direct edits that still ride along.
   */
  approvalFraming?: boolean;
}

export function buildCompleteAnnotateFeedback(
  input: CompleteAnnotateFeedbackInput,
): string {
  let annotationsText: string;

  if (input.messageEntries) {
    annotationsText = exportMessageAnnotations(input.messageEntries);
    if (input.editorAnnotations.length > 0) {
      annotationsText += `\n\n${exportEditorAnnotations(input.editorAnnotations)}`;
    }
  } else {
    const hasLinkedAnnotations = Array.from(input.linkedDocuments.values()).some(
      (entry) => entry.annotations.length > 0 || entry.globalAttachments.length > 0,
    );
    const hasDocumentAnnotations =
      input.annotations.length > 0 || input.globalAttachments.length > 0;
    const hasEditorAnnotations = input.editorAnnotations.length > 0;
    const hasCodeAnnotations = input.codeAnnotations.length > 0;

    if (
      !hasDocumentAnnotations &&
      !hasLinkedAnnotations &&
      !hasEditorAnnotations &&
      !hasCodeAnnotations
    ) {
      annotationsText = ANNOTATE_NO_FEEDBACK_SENTENCE;
    } else {
      annotationsText = hasDocumentAnnotations
        ? exportAnnotations(
            input.blocks,
            input.annotations,
            input.globalAttachments,
            input.title,
            input.subject,
            { sourceConverted: input.sourceConverted },
          )
        : "";

      if (hasLinkedAnnotations) {
        const enriched = new Map<string, LinkedDocAnnotationEntry>();
        for (const [filepath, entry] of input.linkedDocuments) {
          // Parse each linked doc exactly the way it was rendered: plain-text
          // sources (.yaml/.json/.toml/…) keep a leading `---` as real content,
          // so stripping it here would shift every block id and mis-label the
          // exported line numbers.
          enriched.set(filepath, entry.markdown
            ? {
                ...entry,
                blocks: parseMarkdownToBlocks(entry.markdown, {
                  frontmatter: shouldStripFrontmatter(filepath),
                }),
              }
            : entry);
        }
        annotationsText += exportLinkedDocAnnotations(enriched);
      }
      if (hasEditorAnnotations) {
        annotationsText += exportEditorAnnotations(input.editorAnnotations);
      }
      if (hasCodeAnnotations) {
        annotationsText += exportCodeFileAnnotations(input.codeAnnotations);
      }
    }
  }

  if (input.approvalFraming && annotationsText !== ANNOTATE_NO_FEEDBACK_SENTENCE) {
    annotationsText = `${ANNOTATE_NO_FEEDBACK_SENTENCE}\n\n${annotationsText}`;
  }

  return composeFeedbackWithEditSections(
    annotationsText,
    input.directEditsSection,
    input.savedFileChangesSection,
  );
}
