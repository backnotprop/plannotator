import { describe, expect, test } from "bun:test";
import {
  buildAgentTerminalDeliveryRecord,
  buildTerminalAskPrompt,
  isMatchingAgentTerminalDelivery,
  shouldSendAgentTerminalFeedback,
} from "./agentTerminalIntegration";

describe("agent terminal integration helpers", () => {
  test("delivery records match only for the same session, feedback body, and target", () => {
    const delivered = buildAgentTerminalDeliveryRecord({
      terminalSessionId: 1,
      feedback: "Fix this section",
      targetPath: "/repo/a.md",
    });

    expect(isMatchingAgentTerminalDelivery(delivered, buildAgentTerminalDeliveryRecord({
      terminalSessionId: 1,
      feedback: "Fix this section",
      targetPath: "/repo/a.md",
    }))).toBe(true);
    expect(isMatchingAgentTerminalDelivery(delivered, buildAgentTerminalDeliveryRecord({
      terminalSessionId: 2,
      feedback: "Fix this section",
      targetPath: "/repo/a.md",
    }))).toBe(false);
    expect(isMatchingAgentTerminalDelivery(delivered, buildAgentTerminalDeliveryRecord({
      terminalSessionId: 1,
      feedback: "Fix this other section",
      targetPath: "/repo/a.md",
    }))).toBe(false);
    expect(isMatchingAgentTerminalDelivery(delivered, buildAgentTerminalDeliveryRecord({
      terminalSessionId: 1,
      feedback: "Fix this section",
      targetPath: "/repo/b.md",
    }))).toBe(false);
  });

  test("duplicate terminal feedback sends are blocked for an already delivered record", () => {
    const delivered = buildAgentTerminalDeliveryRecord({
      terminalSessionId: 1,
      feedback: "Fix this section",
      targetPath: "/repo/a.md",
    });

    expect(shouldSendAgentTerminalFeedback(delivered, buildAgentTerminalDeliveryRecord({
      terminalSessionId: 1,
      feedback: "Fix this section",
      targetPath: "/repo/a.md",
    }))).toBe(false);
    expect(shouldSendAgentTerminalFeedback(delivered, buildAgentTerminalDeliveryRecord({
      terminalSessionId: 1,
      feedback: "Fix this section",
      targetPath: "/repo/b.md",
    }))).toBe(true);
  });

  test("file-backed Ask AI prompts force the terminal agent to read the file and keep selected context", () => {
    const prompt = buildTerminalAskPrompt({
      documentPath: "/repo/README.md",
      readableFilePath: "/repo/README.md",
      annotationsContext: "Comment on intro",
      inlineDocument: { label: "Current document text", content: "# Should not be inlined" },
      scopedQuestion: "Re: Intro\nSource: /repo/README.md\n\nSelected text:\n```\nold intro\n```\n\nWhat should change?",
    });

    expect(prompt).toContain("read this file from the current workspace: /repo/README.md");
    expect(prompt).toContain("Selected text:");
    expect(prompt).toContain("old intro");
    expect(prompt).toContain("Current annotations:");
    expect(prompt).not.toContain("# Should not be inlined");
  });

  test("non-file Ask AI prompts include inline document content", () => {
    const prompt = buildTerminalAskPrompt({
      documentPath: "agent message",
      scopedQuestion: "Why is this wrong?",
      inlineDocument: { label: "Current document text", content: "assistant message body" },
    });

    expect(prompt).toContain("No reliable workspace file is available");
    expect(prompt).toContain("Current document text:");
    expect(prompt).toContain("assistant message body");
  });
});
