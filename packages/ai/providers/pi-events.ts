/**
 * Pi event mapping — shared between Bun and Node.js Pi providers.
 *
 * Pure function, no runtime-specific dependencies.
 */

import type { AIMessage } from "../types.ts";

/**
 * Map a Pi AgentEvent (received as JSONL) to AIMessage[].
 *
 * Pi event hierarchy:
 *   agent_start > turn_start > message_start > message_update* > message_end
 *     > tool_execution_start > tool_execution_end > turn_end > agent_end
 *
 * We extract:
 * - text_delta from message_update.assistantMessageEvent
 * - text from completed assistant messages when no stream deltas arrived
 * - tool_use from toolcall_end
 * - tool_result from tool_execution_end
 * - result from agent_end
 */
export function mapPiEvent(
	event: Record<string, unknown>,
	sessionId: string,
): AIMessage[] {
	const eventType = event.type as string;

	switch (eventType) {
		case "message_update": {
			const ame = event.assistantMessageEvent as
				| Record<string, unknown>
				| undefined;
			if (!ame) return [];

			const subType = ame.type as string;

			switch (subType) {
				case "text_delta":
					return [{ type: "text_delta", delta: ame.delta as string }];

				case "toolcall_end": {
					const tc = ame.toolCall as Record<string, unknown>;
					if (!tc) return [];
					return [
						{
							type: "tool_use",
							toolName: tc.name as string,
							toolInput: (tc.arguments as Record<string, unknown>) ?? {},
							toolUseId: tc.id as string,
						},
					];
				}

				case "error": {
					const partial = ame.error as Record<string, unknown> | undefined;
					const errorMessage =
						(partial?.errorMessage as string) ?? "Stream error";
					return [
						{ type: "error", error: errorMessage, code: "pi_stream_error" },
					];
				}

				default:
					return [];
			}
		}

		case "message_end": {
			const message = event.message as Record<string, unknown> | undefined;
			if (message?.role !== "assistant") return [];
			if (message.stopReason === "error") {
				return [{
					type: "error",
					error: typeof message.errorMessage === "string" ? message.errorMessage : "Pi request failed",
					code: "pi_request_error",
				}];
			}
			if (!Array.isArray(message.content)) return [];

			const text = message.content
				.filter((block): block is Record<string, unknown> =>
					typeof block === "object" && block !== null && block.type === "text",
				)
				.map((block) => (typeof block.text === "string" ? block.text : ""))
				.join("");
			return text ? [{ type: "text", text }] : [];
		}

		case "tool_execution_end": {
			const result = event.result;
			const isError = event.isError as boolean;
			const resultStr =
				result == null
					? ""
					: typeof result === "string"
						? result
						: JSON.stringify(result);

			return [
				{
					type: "tool_result",
					toolUseId: event.toolCallId as string,
					result: isError
						? `[Error] ${resultStr || "Tool execution failed"}`
						: resultStr,
				},
			];
		}

		case "agent_end":
			return [
				{
					type: "result",
					sessionId,
					success: true,
				},
			];

		case "process_exited":
			return [
				{
					type: "error",
					error: "Pi process exited unexpectedly.",
					code: "pi_process_exit",
				},
			];

		default:
			return [];
	}
}
