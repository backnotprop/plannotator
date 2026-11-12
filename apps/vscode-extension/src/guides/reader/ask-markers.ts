import type { AIChatEntry } from "@plannotator/ui/hooks/useAIChat";
import type { AnswerMarker } from "../reader-protocol";

export function answerChatEntries(markers: readonly AnswerMarker[]): AIChatEntry[] {
  return markers.map((m) => ({
    question: { id: m.id, prompt: m.question, filePath: m.path, lineStart: m.start, lineEnd: m.end, side: m.side, createdAt: 0 },
    response: {
      questionId: m.id,
      text: m.status === "answered" || m.status === "text" ? "Answer opened beside the guide" : "",
      isStreaming: m.status === "answering",
      ...(m.status === "failed" || m.status === "stopped" ? { error: m.status === "failed" ? "No answer" : "Stopped" } : {}),
      createdAt: 0,
    },
  }));
}
