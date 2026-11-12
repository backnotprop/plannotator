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
  type LinkedDocAnnotationEntry,
  type LinkedDocExportHeading,
  type MessageAnnotationEntry,
} from "@plannotator/ui/utils/parser";
import { composeFeedbackWithEditSections } from "./directEdits";
import { blocksForDocument } from "./feedbackDocuments";

export interface AnnotateApprovalBodyInput {
  supported: boolean;
  draftGeneration: number;
  feedback: string;
  annotations: unknown[];
  codeAnnotations: unknown[];
  selectedMessageId?: string;
  feedbackScope?: "message" | "messages";
}

// CLI plain-mode output and strict-gate exit codes depend on these exact bytes.
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
  /** Documents OTHER than the one `annotations` describes — never the same
   *  document again (see resolveFeedbackSections). */
  linkedDocuments: Map<string, LinkedDocAnnotationEntry>;
  linkedDocumentsHeading?: LinkedDocExportHeading;
  editorAnnotations: EditorAnnotation[];
  codeAnnotations: CodeAnnotation[];
  title: string;
  subject: string;
  sourceConverted: boolean;
  directEditsSection: string;
  savedFileChangesSection: string;
  messageEntries?: MessageAnnotationEntry[];
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
          enriched.set(filepath, entry.markdown && !entry.blocks
            ? { ...entry, blocks: blocksForDocument(filepath, entry.markdown) }
            : entry);
        }
        annotationsText += exportLinkedDocAnnotations(enriched, input.linkedDocumentsHeading);
      }
      if (hasEditorAnnotations) {
        annotationsText += exportEditorAnnotations(input.editorAnnotations);
      }
      if (hasCodeAnnotations) {
        annotationsText += exportCodeFileAnnotations(input.codeAnnotations);
      }
      annotationsText = annotationsText.replace(/^\n+/, "");
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
