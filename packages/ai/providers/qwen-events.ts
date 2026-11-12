import type { AIMessage } from "../types.ts";

export const QWEN_ASK_AI_SESSION_PREFIX = "a5ca1000";

export function newQwenAskAISessionId(): string {
	return QWEN_ASK_AI_SESSION_PREFIX + crypto.randomUUID().slice(QWEN_ASK_AI_SESSION_PREFIX.length);
}

export function mapQwenLine(line: Record<string, unknown>, sessionId: string): AIMessage[] {
	if (line.parent_tool_use_id != null) return [];

	switch (line.type) {
		case "stream_event": {
			const event = line.event as Record<string, unknown> | undefined;
			if (event?.type !== "content_block_delta") return [];
			const delta = event.delta as Record<string, unknown> | undefined;
			if (delta?.type !== "text_delta" || typeof delta.text !== "string") return [];
			return [{ type: "text_delta", delta: delta.text }];
		}

		case "assistant": {
			const message = line.message as Record<string, unknown> | undefined;
			if (!Array.isArray(message?.content)) return [];
			const out: AIMessage[] = [];
			const text: string[] = [];
			const flushText = () => {
				if (text.length > 0) out.push({ type: "text", text: text.join("") });
				text.length = 0;
			};
			for (const block of message.content as Array<Record<string, unknown> | null>) {
				if (block?.type === "text" && typeof block.text === "string") {
					text.push(block.text);
				} else if (block?.type === "tool_use") {
					flushText();
					out.push({
						type: "tool_use",
						toolName: typeof block.name === "string" ? block.name : "",
						toolInput:
							block.input && typeof block.input === "object"
								? (block.input as Record<string, unknown>)
								: {},
						toolUseId: typeof block.id === "string" ? block.id : "",
					});
				}
			}
			flushText();
			return out;
		}

		case "user": {
			const message = line.message as Record<string, unknown> | undefined;
			if (!Array.isArray(message?.content)) return [];
			const out: AIMessage[] = [];
			for (const block of message.content as Array<Record<string, unknown> | null>) {
				if (block?.type !== "tool_result") continue;
				const resultText = toolResultText(block.content);
				out.push({
					type: "tool_result",
					...(typeof block.tool_use_id === "string" ? { toolUseId: block.tool_use_id } : {}),
					result:
						block.is_error === true
							? `[Error] ${resultText || "Tool execution failed"}`
							: resultText,
				});
			}
			return out;
		}

		case "result":
			return [
				{
					type: "result",
					sessionId,
					success: line.is_error !== true && (line.subtype === undefined || line.subtype === "success"),
					...(typeof line.result === "string" ? { result: line.result } : {}),
					...(typeof line.num_turns === "number" ? { turns: line.num_turns } : {}),
					...(typeof line.total_cost_usd === "number" ? { costUsd: line.total_cost_usd } : {}),
				},
			];

		default:
			return [];
	}
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) =>
				block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
					? block.text
					: "",
			)
			.filter((text) => text !== "")
			.join("\n");
	}
	if (content == null) return "";
	return JSON.stringify(content);
}
