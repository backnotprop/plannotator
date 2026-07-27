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

export interface AnnotateApprovalPolicy {
  label: string;
  title: string;
  confirmation: {
    title: string;
    message: string;
    confirmText: string;
  } | null;
}

export function getAnnotateApprovalPolicy(input: {
  gate: boolean;
  approvalNotesSupported: boolean;
  hasFeedback: boolean;
}): AnnotateApprovalPolicy {
  if (input.gate && input.approvalNotesSupported && input.hasFeedback) {
    return {
      label: "Approve with Notes",
      title: "Approve with Notes — send notes as non-blocking guidance",
      confirmation: {
        title: "Approve with Notes?",
        message: "This approves the artifact, sends your notes as non-blocking guidance, and closes the gate. Unlike Send Feedback, it does not request changes.",
        confirmText: "Approve with Notes",
      },
    };
  }
  return {
    label: "Approve",
    title: "Approve — no changes requested",
    confirmation: null,
  };
}

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
      annotationsText = "User reviewed the document and has no feedback.";
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

  return composeFeedbackWithEditSections(
    annotationsText,
    input.directEditsSection,
    input.savedFileChangesSection,
  );
}
