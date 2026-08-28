import { describe, expect, test } from "bun:test";
import { splitSseChunks, mapAnthropicSseData } from "./orcarouter.ts";

describe("splitSseChunks", () => {
  test("splits a single data line", () => {
    expect(splitSseChunks("data: hello\n\n")).toEqual(["hello"]);
  });

  test("handles multiple events and CRLF", () => {
    const input =
      "event: message_start\r\ndata: {\"type\":\"message_start\"}\r\n\r\n" +
      "event: content_block_delta\r\ndata: {\"type\":\"content_block_delta\"}\r\n\r\n";
    expect(splitSseChunks(input)).toEqual([
      '{"type":"message_start"}',
      '{"type":"content_block_delta"}',
    ]);
  });

  test("ignores non-data lines like event and id", () => {
    const input = "event: message_stop\ndata: [DONE]\n\n";
    expect(splitSseChunks(input)).toEqual(["[DONE]"]);
  });

  test("trims a trailing carriage return", () => {
    const input = "data: {\"type\":\"x\"}\r\n\r\n";
    expect(splitSseChunks(input)).toEqual(['{"type":"x"}']);
  });
});

describe("mapAnthropicSseData", () => {
  test("maps text_delta deltas", () => {
    const messages = mapAnthropicSseData(
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}',
      "s1",
    );
    expect(messages).toEqual([{ type: "text_delta", delta: "Hel" }]);
  });

  test("ignores non-text deltas (thinking, input_json)", () => {
    const messages = mapAnthropicSseData(
      '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"..."}}',
      "s1",
    );
    expect(messages).toEqual([]);
  });

  test("surfaces the session id from message_start as an unknown marker", () => {
    const messages = mapAnthropicSseData(
      '{"type":"message_start","message":{"id":"msg_abc"}}',
      "s1",
    );
    expect(messages).toEqual([{ type: "unknown", raw: { sessionId: "msg_abc" } }]);
  });

  test("message_stop yields a successful result", () => {
    const messages = mapAnthropicSseData('{"type":"message_stop"}', "s1");
    expect(messages).toEqual([{ type: "result", sessionId: "s1", success: true }]);
  });

  test("maps the error event", () => {
    const messages = mapAnthropicSseData(
      '{"type":"error","error":{"message":"quota exhausted"}}',
      "s1",
    );
    expect(messages).toEqual([
      {
        type: "error",
        error: "quota exhausted",
        code: "orcarouter_error",
      },
    ]);
  });

  test("passes [DONE] through as an empty list", () => {
    expect(mapAnthropicSseData("[DONE]", "s1")).toEqual([]);
  });

  test("falls back to unknown for unparsable data", () => {
    const messages = mapAnthropicSseData("not json", "s1");
    expect(messages).toEqual([{ type: "unknown", raw: { raw: "not json" } }]);
  });
});
