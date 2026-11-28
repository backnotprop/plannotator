import { expect, test } from "bun:test";
import { questionWords } from "./inbox-mcp-read";

test("read_thread names a question answered in the person's reply with the reply and the quote", () => {
  const line = questionWords({ q: 2, key: "q-1", state: "answered_in_reply", answer: null, answered_in_reply: { reply: "msg_r", quote: "keep Jenkins for a week" } } as never);
  expect(line).toBe('Q2 q-1 answered in the person\'s reply msg_r: "keep Jenkins for a week"');
});
