import { describe, expect, test } from "bun:test";
import type { CommentAskAIHandler } from "@plannotator/ui/components/CommentPopover";
import { buildContextualAIHandlers } from "./ReviewStateContext";

describe("buildContextualAIHandlers", () => {
  const onAskAIForDescription: CommentAskAIHandler = () => {};
  const onAskAIForComment: CommentAskAIHandler = () => {};
  const handlers = { onAskAIForDescription, onAskAIForComment };

  test("omits contextual Ask AI actions when AI is unavailable", () => {
    expect(buildContextualAIHandlers(false, handlers)).toEqual({});
  });

  test("provides contextual Ask AI actions when AI is available", () => {
    expect(buildContextualAIHandlers(true, handlers)).toEqual(handlers);
  });
});
