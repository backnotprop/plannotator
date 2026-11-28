import type { AIMessage } from "../types.ts";

export interface OpenCodeV2Event {
	type?: string;
	data?: Record<string, unknown>;
}

export function parseOpenCodeModel(model?: string): { providerID: string; id: string } | undefined {
	const slash = model?.indexOf("/") ?? -1;
	return model && slash > 0 && slash < model.length - 1
		? { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
		: undefined;
}

export async function detectOpenCodeV2(url: string, authorization: string, signal?: AbortSignal): Promise<boolean> {
	const response = await fetch(`${url}/api/info`, {
		headers: { Authorization: authorization },
		signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
	});
	if (!response.ok) {
		await response.body?.cancel();
		if (response.status === 401 || response.status === 403) {
			throw new Error(`OpenCode startup failed: HTTP ${response.status} (server password not accepted)`);
		}
		// 1.x has no /api/info: its catch-all route answers, and that can fail (offline, say).
		// Only 2.x serves /api/info itself, so any other error keeps the 1.x client.
		return false;
	}
	// 1.x serves its HTML application here, even with a 200 status.
	const text = await response.text();
	let info: { version?: unknown } | null;
	try {
		info = JSON.parse(text);
	} catch {
		return false;
	}
	// Any other answer is not 2.x: on 1.x it comes from the catch-all, so it must not fail startup.
	return typeof info?.version === "string" && Number.parseInt(info.version.split(".")[0], 10) >= 2;
}

export class OpenCodeV2Client {
	constructor(private url: string, private authorization: string) {}

	private async fetch(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
		const response = await fetch(`${this.url}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { Authorization: this.authorization, "Content-Type": "application/json" },
			...(body !== undefined && { body: JSON.stringify(body) }),
			signal,
		});
		if (!response.ok) {
			const text = await response.text();
			let detail = text;
			try {
				const error = JSON.parse(text);
				detail = [error._tag, error.message].filter(Boolean).join(": ") || text;
			} catch {}
			throw new Error(`OpenCode HTTP ${response.status}: ${detail}`);
		}
		return response;
	}

	async request<T>(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		const response = await this.fetch(path, body, signal);
		if (response.status === 204) return undefined as T;
		const value = await response.json();
		return value && typeof value === "object" && "data" in value ? value.data : value;
	}

	async *events(signal: AbortSignal): AsyncGenerator<OpenCodeV2Event> {
		const response = await this.fetch("/api/event", undefined, signal);
		if (!response.body) throw new Error("OpenCode event stream has no body.");
		const reader = response.body.getReader();
		// Bun >=1.4 can reject cancel() after fetch has already aborted the body.
		const cancel = () => {
			void reader.cancel().catch(() => {});
		};
		signal.addEventListener("abort", cancel, { once: true });
		if (signal.aborted) cancel();
		const decoder = new TextDecoder();
		let pending = "";
		let data: string[] = [];
		try {
			while (!signal.aborted) {
				const chunk = await reader.read();
				if (chunk.done) break;
				pending += decoder.decode(chunk.value, { stream: true });
				let end: number;
				while ((end = pending.indexOf("\n")) !== -1) {
					const line = pending.slice(0, end).replace(/\r$/, "");
					pending = pending.slice(end + 1);
					if (line === "") {
						let event: OpenCodeV2Event | undefined;
						try {
							if (data.length) event = JSON.parse(data.join("\n"));
						} catch {}
						data = [];
						if (event) yield event;
					} else if (line.startsWith("data:")) {
						data.push(line.slice(5).replace(/^ /, ""));
					}
				}
			}
		} catch (err) {
			if (!signal.aborted) throw err;
		} finally {
			signal.removeEventListener("abort", cancel);
			cancel();
		}
	}
}

export interface OpenCodeV2QueryState {
	started: boolean;
	sawTextDelta: boolean;
	toolNames: Map<string, string>;
}

export function createOpenCodeV2QueryState(): OpenCodeV2QueryState {
	return { started: false, sawTextDelta: false, toolNames: new Map() };
}

export function consumeOpenCodeV2Event(
	event: OpenCodeV2Event,
	sessionId: string,
	state: OpenCodeV2QueryState,
): { messages: AIMessage[]; done: boolean } {
	const data = event.data;
	if (!data || data.sessionID !== sessionId) return { messages: [], done: false };
	const messages: AIMessage[] = [];
	let done = false;
	if (event.type === "session.execution.started") state.started = true;
	if (!state.started) return { messages, done };
	const id = data.id as string;
	switch (event.type) {
		case "session.text.delta":
			state.sawTextDelta = true;
			messages.push({ type: "text_delta", delta: data.delta as string });
			break;
		case "session.text.ended":
			if (!state.sawTextDelta && data.text) messages.push({ type: "text_delta", delta: data.text as string });
			break;
		case "session.tool.input.started":
			state.toolNames.set(id, data.name as string);
			break;
		case "session.tool.called":
			messages.push({
				type: "tool_use",
				toolUseId: id,
				toolName: state.toolNames.get(id) ?? "tool",
				toolInput: data.input as Record<string, unknown>,
			});
			break;
		case "session.tool.success":
			messages.push({
				type: "tool_result",
				toolUseId: id,
				result: ((data.content ?? []) as Array<{ type: string; text?: string }>)
					.filter((item) => item.type === "text")
					.map((item) => item.text ?? "").join("\n"),
			});
			break;
		case "session.tool.failed":
			messages.push({ type: "tool_result", toolUseId: id, result: `[Error] ${(data.error as { message?: string })?.message ?? "Tool failed"}` });
			break;
		case "permission.asked":
			messages.push({
				type: "permission_request",
				requestId: id,
				toolUseId: id,
				toolName: data.action as string,
				toolInput: (data.metadata ?? {}) as Record<string, unknown>,
				title: (data.message ?? data.action) as string,
			});
			break;
		case "session.execution.succeeded":
			messages.push({ type: "result", sessionId, success: true });
			done = true;
			break;
		case "session.execution.failed":
		case "session.execution.interrupted":
			messages.push({
				type: "error",
				error: event.type === "session.execution.interrupted"
					? "OpenCode query aborted."
					: (data.error as { message?: string })?.message ?? "OpenCode execution failed.",
				code: event.type === "session.execution.failed" ? "opencode_session_error" : "provider_error",
			});
			done = true;
			break;
	}
	return { messages, done };
}
