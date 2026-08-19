import { describe, expect, test } from "bun:test";
import { AnnotationType, type Annotation, type CodeAnnotation, type EditorAnnotation } from "@plannotator/ui/types";
import { parseMarkdownToBlocks, type LinkedDocAnnotationEntry } from "@plannotator/ui/utils/parser";
import {
  buildAnnotateApprovalBody,
  buildCompleteAnnotateFeedback,
  getAnnotateApprovalPolicy,
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

  // The notes have to anchor to the same message Send Feedback would target.
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

    // Omitted entirely when there is no message scope (ordinary file annotate).
    expect(buildAnnotateApprovalBody({ supported: true, ...input })).toEqual(input);

    // Incapable transports still send nothing but the draft generation.
    expect(buildAnnotateApprovalBody({
      supported: false,
      ...input,
      selectedMessageId: "message-2",
    })).toEqual({ draftGeneration: 4 });
  });

  test("labels capable feedback approvals and requires a non-blocking confirmation", () => {
    expect(getAnnotateApprovalPolicy({
      gate: true,
      approvalNotesSupported: true,
      hasFeedback: true,
    })).toEqual({
      label: "Approve with Notes",
      title: "Approve with Notes — send notes as non-blocking guidance",
      confirmation: {
        title: "Approve with Notes?",
        message: "This approves the artifact, sends your notes as non-blocking guidance, and closes the gate. Unlike Send Feedback, it does not request changes.",
        confirmText: "Approve with Notes",
      },
    });
  });

  test("keeps ordinary approval presentation when notes are absent or unsupported", () => {
    expect(getAnnotateApprovalPolicy({
      gate: true,
      approvalNotesSupported: true,
      hasFeedback: false,
    })).toEqual({
      label: "Approve",
      title: "Approve — no changes requested",
      confirmation: null,
    });
    expect(getAnnotateApprovalPolicy({
      gate: true,
      approvalNotesSupported: false,
      hasFeedback: true,
    })).toEqual({
      label: "Approve",
      title: "Approve — no changes requested",
      confirmation: null,
    });
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

  // Regression: the export must parse each linked doc the same way the viewer
  // rendered it. A plain-text source (.yaml/.json/.toml/…) whose first line is
  // `---` is real content — a multi-document YAML, not frontmatter. Stripping
  // it here shifted every block id, so the line labels came out wrong (or the
  // annotation's block vanished and the label was dropped entirely).
  test("keeps linked-doc line labels correct for plain-text sources that open with ---", () => {
    const yaml = "---\napiVersion: v1\nkind: Service\n---\napiVersion: v1\nkind: ConfigMap\n";
    const yamlBlocks = parseMarkdownToBlocks(yaml, { frontmatter: false });
    const firstDocument = yamlBlocks.find(
      (block) => block.type === "paragraph" && block.content.startsWith("apiVersion: v1"),
    );
    if (!firstDocument) throw new Error("expected the first YAML document to parse as a block");
    expect(firstDocument.startLine).toBe(2);

    const linkedAnnotation: Annotation = {
      id: "yaml-1",
      blockId: firstDocument.id,
      startOffset: 0,
      endOffset: 14,
      type: AnnotationType.COMMENT,
      text: "Pin the API version.",
      originalText: "apiVersion: v1",
      createdA: 1,
    };

    const feedback = buildCompleteAnnotateFeedback({
      blocks: [],
      annotations: [],
      globalAttachments: [],
      linkedDocuments: new Map<string, LinkedDocAnnotationEntry>([
        ["/infra/deploy.yaml", {
          annotations: [linkedAnnotation],
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

    expect(feedback).toContain("(lines 2–3) ");
    expect(feedback).toContain('Feedback on: "apiVersion: v1"');
    // The frontmatter-stripping parse would have relabeled this block to line 5.
    expect(feedback).not.toContain("lines 5–6");
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
});
