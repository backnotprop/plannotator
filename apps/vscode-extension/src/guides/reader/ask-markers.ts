/**
 * Answers about lines of a file, as the diff's own Ask AI markers (the
 * sparkle at the last line the question was about; clicking it opens the
 * answer beside). The answer itself is a page in its own tab, so the entry
 * carries only the question and whether it is done.
 */

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
