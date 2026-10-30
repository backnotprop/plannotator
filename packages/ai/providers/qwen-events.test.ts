import { describe, expect, test } from "bun:test";
import { mapQwenLine } from "./qwen-events.ts";

const SID = "plannotator-session";

describe("mapQwenLine", () => {
	test("text deltas stream; thinking and tool-input deltas do not", () => {
		const delta = (d: Record<string, unknown>) =>
			mapQwenLine({ type: "stream_event", event: { type: "content_block_delta", delta: d } }, SID);
		expect(delta({ type: "text_delta", text: "po" })).toEqual([{ type: "text_delta", delta: "po" }]);
		expect(delta({ type: "thinking_delta", thinking: "hmm" })).toEqual([]);
		expect(delta({ type: "input_json_delta", partial_json: "{" })).toEqual([]);
	});

	test("an assistant line keeps text and tool calls in order", () => {
		const out = mapQwenLine(
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hidden" },
						{ type: "text", text: "Reading " },
						{ type: "text", text: "the file." },
						{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
						{ type: "text", text: "Done." },
					],
				},
			},
			SID,
		);
		expect(out).toEqual([
			{ type: "text", text: "Reading the file." },
			{ type: "tool_use", toolName: "read_file", toolInput: { path: "a.ts" }, toolUseId: "t1" },
			{ type: "text", text: "Done." },
		]);
	});

	test("tool results read string and block content, and mark errors", () => {
		const out = mapQwenLine(
			{
				type: "user",
				message: {
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "t1", content: "file text" },
						{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] },
						{ type: "tool_result", tool_use_id: "t3", is_error: true, content: "" },
					],
				},
			},
			SID,
		);
		expect(out).toEqual([
			{ type: "tool_result", toolUseId: "t1", result: "file text" },
			{ type: "tool_result", toolUseId: "t2", result: "a\nb" },
			{ type: "tool_result", toolUseId: "t3", result: "[Error] Tool execution failed" },
		]);
	});

	test("a result line ends the answer under the Plannotator session id; an error result is not a success", () => {
		expect(mapQwenLine({ type: "result", subtype: "success", session_id: "qwen-id", is_error: false, result: "pong", num_turns: 2 }, SID)).toEqual([
			{ type: "result", sessionId: SID, success: true, result: "pong", turns: 2 },
		]);
		expect(mapQwenLine({ type: "result", subtype: "error_max_turns", is_error: false }, SID)[0]).toMatchObject({ success: false });
		expect(mapQwenLine({ type: "result", is_error: true }, SID)[0]).toMatchObject({ success: false });
	});

	test("subagent lines and unknown lines are dropped", () => {
		expect(
			mapQwenLine({ type: "assistant", parent_tool_use_id: "task-1", message: { role: "assistant", content: [{ type: "text", text: "inner" }] } }, SID),
		).toEqual([]);
		expect(mapQwenLine({ type: "system", subtype: "init" }, SID)).toEqual([]);
		expect(mapQwenLine({ type: "something-new" }, SID)).toEqual([]);
	});
});
