import { describe, expect, test } from "bun:test";
import { AnnotationType, type Annotation, type CodeAnnotation, type EditorAnnotation } from "@plannotator/ui/types";
import { parseMarkdownToBlocks, type LinkedDocAnnotationEntry } from "@plannotator/ui/utils/parser";
import {
  ANNOTATE_NO_FEEDBACK_SENTENCE,
  buildAnnotateApprovalBody,
  buildCompleteAnnotateFeedback,
} from "./annotateSubmission";

describe("annotate approval submission", () => {
  test("includes notes only when the transport supports approval notes", () => {
    const input = {
      draftGeneration: 4,
      feedback: "Keep the retry bounded.",
      annotations: [{ id: "a1" }],
      codeAnnotations: [{ id: "c1" }],
    };

    expect(buildAnnotateApprovalBody({ supported: true, ...input })).toEqual(input);
    expect(buildAnnotateApprovalBody({ supported: false, ...input })).toEqual({
      draftGeneration: 4,
    });
  });

  test("carries the message scope so approval notes anchor like feedback", () => {
    const input = {
      draftGeneration: 4,
      feedback: "Scope this to the picked message.",
      annotations: [],
      codeAnnotations: [],
    };

    expect(buildAnnotateApprovalBody({
      supported: true,
      ...input,
      selectedMessageId: "message-2",
      feedbackScope: "messages" as const,
    })).toEqual({
      ...input,
      selectedMessageId: "message-2",
      feedbackScope: "messages",
    });

    expect(buildAnnotateApprovalBody({ supported: true, ...input })).toEqual(input);

    expect(buildAnnotateApprovalBody({
      supported: false,
      ...input,
      selectedMessageId: "message-2",
    })).toEqual({ draftGeneration: 4 });
  });

  test("composes every annotate feedback source into approval notes", () => {
    const markdown = "# Retry\n\nRetry forever.";
    const blocks = parseMarkdownToBlocks(markdown);
    const paragraph = blocks.find((block) => block.type === "paragraph");
    if (!paragraph) throw new Error("expected paragraph block");

    const annotation: Annotation = {
      id: "a1",
      blockId: paragraph.id,
      startOffset: 0,
      endOffset: 5,
      type: AnnotationType.COMMENT,
      text: "Keep the retry bounded.",
      originalText: "Retry",
      createdA: 1,
      images: [{ path: "/tmp/retry.png", name: "retry-diagram" }],
    };
    const linkedAnnotation: Annotation = {
      ...annotation,
      id: "linked-1",
      text: "Update the linked runbook.",
      originalText: "Runbook",
      images: undefined,
    };
    const linkedDocuments = new Map<string, LinkedDocAnnotationEntry>([
      ["/docs/runbook.md", {
        annotations: [linkedAnnotation],
        globalAttachments: [],
        markdown: "# Runbook\n\nRunbook",
      }],
    ]);
    const codeAnnotation: CodeAnnotation = {
      id: "c1",
      type: "comment",
      filePath: "src/retry.ts",
      lineStart: 8,
      lineEnd: 8,
      side: "new",
      text: "Cap this loop.",
      originalCode: "while (true)",
      createdAt: 1,
    };
    const editorAnnotation: EditorAnnotation = {
      id: "e1",
      filePath: "src/config.ts",
      selectedText: "MAX_RETRIES",
      lineStart: 3,
      lineEnd: 3,
      comment: "Make the limit configurable.",
      createdAt: 1,
    };

    const feedback = buildCompleteAnnotateFeedback({
      blocks,
      annotations: [annotation],
      globalAttachments: [{ path: "/tmp/global.png", name: "global-reference" }],
      linkedDocuments,
      editorAnnotations: [editorAnnotation],
      codeAnnotations: [codeAnnotation],
      title: "File Feedback",
      subject: "file",
      sourceConverted: false,
      directEditsSection: "# Direct Edits\n\nBound the retry loop.",
      savedFileChangesSection: "# Saved File Changes\n\n## /docs/retry.md",
    });

    expect(feedback).toContain("retry-diagram");
    expect(feedback).toContain("global-reference");
    expect(feedback).toContain("# Code File Feedback");
    expect(feedback).toContain("# Direct Edits");
    expect(feedback).toContain("# Linked Document Feedback");
    expect(feedback).toContain("# Editor File Annotations");
    expect(feedback).toContain("# Saved File Changes");

    expect(buildAnnotateApprovalBody({
      supported: true,
      draftGeneration: 4,
      feedback,
      annotations: [annotation],
      codeAnnotations: [codeAnnotation],
    })).toMatchObject({
      draftGeneration: 4,
      feedback,
      annotations: [annotation],
      codeAnnotations: [codeAnnotation],
    });
  });

  test("keeps linked-doc line labels correct for config sources that open with ---", () => {
    const yaml = "---\napiVersion: v1\nkind: Service\n---\napiVersion: v1\nkind: ConfigMap\n";
    const comment = (id: string, quote: string, startOffset: number): Annotation => ({
      id,
      blockId: "block-0",
      startOffset,
      endOffset: startOffset + quote.length,
      type: AnnotationType.COMMENT,
      text: `Note ${id}.`,
      originalText: quote,
      createdA: 1,
    });
    const linkedAnnotations = [
      comment("yaml-1", "kind: ConfigMap", yaml.indexOf("kind: ConfigMap")),
      comment("yaml-2", "apiVersion: v1", yaml.lastIndexOf("apiVersion: v1")),
      comment("yaml-3", "kind: Service\n---", yaml.indexOf("kind: Service")),
    ];

    const feedback = buildCompleteAnnotateFeedback({
      blocks: [],
      annotations: [],
      globalAttachments: [],
      linkedDocuments: new Map<string, LinkedDocAnnotationEntry>([
        ["/infra/deploy.yaml", {
          annotations: linkedAnnotations,
          globalAttachments: [],
          markdown: yaml,
        }],
      ]),
      editorAnnotations: [],
      codeAnnotations: [],
      title: "File Feedback",
      subject: "file",
      sourceConverted: false,
      directEditsSection: "",
      savedFileChangesSection: "",
    });

    expect(feedback).toContain('(line 6) Feedback on: "kind: ConfigMap"');
    expect(feedback).toContain('(line 5) Feedback on: "apiVersion: v1"');
    expect(feedback).toContain("(lines 3–4) ");
    expect(feedback).not.toContain("lines 1–6");
  });

  test("still strips frontmatter for markdown linked docs", () => {
    const markdown = "---\ntitle: Runbook\n---\n\nRestart the worker.\n";
    const markdownBlocks = parseMarkdownToBlocks(markdown);
    const body = markdownBlocks.find((block) => block.type === "paragraph");
    if (!body) throw new Error("expected a body block");
    expect(body.startLine).toBe(5);

    const feedback = buildCompleteAnnotateFeedback({
      blocks: [],
      annotations: [],
      globalAttachments: [],
      linkedDocuments: new Map<string, LinkedDocAnnotationEntry>([
        ["/docs/runbook.md", {
          annotations: [{
            id: "md-1",
            blockId: body.id,
            startOffset: 0,
            endOffset: 7,
            type: AnnotationType.COMMENT,
            text: "Say which worker.",
            originalText: "Restart",
            createdA: 1,
          }],
          globalAttachments: [],
          markdown,
        }],
      ]),
      editorAnnotations: [],
      codeAnnotations: [],
      title: "File Feedback",
      subject: "file",
      sourceConverted: false,
      directEditsSection: "",
      savedFileChangesSection: "",
    });

    expect(feedback).toContain("(line 5) ");
  });

  test("approval framing prefixes the zero-state sentence before the note", () => {
    const note: Annotation = {
      id: "global-note-1",
      blockId: "",
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.GLOBAL_COMMENT,
      text: "watch the migration",
      originalText: "",
      createdA: 1,
    };
    const base = {
      blocks: [],
      annotations: [note],
      globalAttachments: [],
      linkedDocuments: new Map<string, LinkedDocAnnotationEntry>(),
      editorAnnotations: [] as EditorAnnotation[],
      codeAnnotations: [] as CodeAnnotation[],
      title: "File Feedback",
      subject: "file",
      sourceConverted: false,
      directEditsSection: "",
      savedFileChangesSection: "",
    };

    const changeRequest = buildCompleteAnnotateFeedback(base);
    const approval = buildCompleteAnnotateFeedback({ ...base, approvalFraming: true });

    expect(changeRequest).toContain("watch the migration");
    expect(changeRequest.startsWith(ANNOTATE_NO_FEEDBACK_SENTENCE)).toBe(false);
    expect(approval.startsWith(ANNOTATE_NO_FEEDBACK_SENTENCE)).toBe(true);
    expect(approval).toContain("watch the migration");

    const discard = buildCompleteAnnotateFeedback({
      ...base,
      annotations: [],
      approvalFraming: true,
    });
    expect(discard).toBe(ANNOTATE_NO_FEEDBACK_SENTENCE);
  });
});
