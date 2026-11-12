export type AnnotateFeedbackTarget = {
  fileHeader: "File" | "Folder" | "Files";
  filePath: string;
};

export type AgentTerminalDeliveryRecord = {
  terminalSessionId: number;
  feedbackKey: string;
  targetPath: string | null;
};

export type TerminalAskPromptParams = {
  scopedQuestion: string;
  documentPath: string;
  draftAnnotations?: string;
  readableFilePath?: string | null;
  inlineDocument?: {
    label: string;
    content: string;
  } | null;
};

export function textKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildAgentTerminalDeliveryRecord(options: {
  terminalSessionId: number;
  feedback: string;
  targetPath?: string | null;
}): AgentTerminalDeliveryRecord {
  return {
    terminalSessionId: options.terminalSessionId,
    feedbackKey: textKey(options.feedback),
    targetPath: options.targetPath ?? null,
  };
}

export function isMatchingAgentTerminalDelivery(
  delivered: AgentTerminalDeliveryRecord | null,
  current: AgentTerminalDeliveryRecord | null,
): boolean {
  return !!delivered &&
    !!current &&
    delivered.terminalSessionId === current.terminalSessionId &&
    delivered.feedbackKey === current.feedbackKey &&
    delivered.targetPath === current.targetPath;
}

export function shouldSendAgentTerminalFeedback(
  delivered: AgentTerminalDeliveryRecord | null,
  current: AgentTerminalDeliveryRecord | null,
): boolean {
  return !isMatchingAgentTerminalDelivery(delivered, current);
}

export const ASK_DRAFTS_LABEL =
  "[Draft annotations the reviewer has not submitted yet. They are context for the question only. Do not act on them; the reviewer will send them when ready. This list replaces any draft list sent earlier.]";
export const ASK_DRAFTS_END = "[End of draft annotations]";
export const ASK_DRAFTS_CLEARED =
  "[The reviewer has no draft annotations now. Disregard any draft list sent earlier.]";

const ASK_DRAFTS_END_LOOKALIKE = /\[\s*end\s+of\s+(?:the\s+)?draft\s+annotations?\b[^\]\n]*\]/gi;

function terminalDraftBlock(draftAnnotations: string | undefined): string {
  if (draftAnnotations === undefined) return "";
  const list = draftAnnotations.replace(ASK_DRAFTS_END_LOOKALIKE, "(quoted: end of draft annotations)").trim();
  return list ? [ASK_DRAFTS_LABEL, list, ASK_DRAFTS_END].join("\n") : ASK_DRAFTS_CLEARED;
}

export function buildTerminalAskPrompt(params: TerminalAskPromptParams): string {
  const hasReadableFile = !!params.readableFilePath;
  const parts = [
    "# Plannotator Ask",
    hasReadableFile
      ? `Before answering, read this file from the current workspace: ${params.readableFilePath}. Use the selected/context text below to understand what the user is asking about.`
      : "No reliable workspace file is available for this question. Use the inline document/context below.",
    `Current document: ${params.documentPath}`,
    terminalDraftBlock(params.draftAnnotations),
    !hasReadableFile && params.inlineDocument?.content
      ? `${params.inlineDocument.label}:\n\`\`\`\n${params.inlineDocument.content}\n\`\`\``
      : "",
    `Question:\n${params.scopedQuestion}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}
