import { describe, expect, test } from "bun:test";
import { consumeOpenCodeV2Event, createOpenCodeV2QueryState, detectOpenCodeV2, OpenCodeV2Client } from "./opencode-v2.ts";

describe("OpenCode 2 event mapping", () => {
	test("terminal frames need this session's execution start; reasoning and other sessions stay invisible", () => {
		const state = createOpenCodeV2QueryState();
		const consume = (type: string, data: Record<string, unknown> = {}) => consumeOpenCodeV2Event({ type, data: { sessionID: "s", ...data } }, "s", state);
		expect(consume("session.execution.succeeded")).toEqual({ messages: [], done: false });
		consume("session.execution.started", { sessionID: "other" });
		expect(consume("session.execution.failed", { error: { message: "stale" } }).done).toBe(false);
		consume("session.execution.started");
		expect(consume("session.reasoning.delta", { delta: "private" }).messages).toEqual([]);
		expect(consume("session.text.delta", { sessionID: "other", delta: "wrong" }).messages).toEqual([]);
		expect(consume("session.execution.succeeded")).toEqual({ messages: [{ type: "result", sessionId: "s", success: true }], done: true });
	});

	test("text-ended supplies fallback only when this turn streamed no deltas", () => {
		const state = createOpenCodeV2QueryState();
		const consume = (type: string, data = {}) => consumeOpenCodeV2Event({ type, data: { sessionID: "s", ...data } }, "s", state).messages;
		consume("session.execution.started");
		expect(consume("session.text.ended", { text: "fallback" })).toEqual([{ type: "text_delta", delta: "fallback" }]);
		expect(consume("session.text.delta", { delta: "streamed" })).toEqual([{ type: "text_delta", delta: "streamed" }]);
		expect(consume("session.text.ended", { text: "streamed" })).toEqual([]);
	});

	test("tool names correlate by id, only text results join, and errors and interruption terminate correctly", () => {
		const state = createOpenCodeV2QueryState();
		const consume = (type: string, data = {}) => consumeOpenCodeV2Event({ type, data: { sessionID: "s", ...data } }, "s", state);
		consume("session.execution.started");
		consume("session.tool.input.started", { id: "a", name: "shell" });
		consume("session.tool.input.started", { id: "b", name: "read" });
		expect(consume("session.tool.called", { id: "a", input: { command: "ls" } }).messages).toEqual([{ type: "tool_use", toolName: "shell", toolInput: { command: "ls" }, toolUseId: "a" }]);
		expect(consume("session.tool.success", { id: "a", content: [{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }] }).messages).toEqual([{ type: "tool_result", toolUseId: "a", result: "one\ntwo" }]);
		expect(consume("session.tool.success", { id: "b", content: [] }).messages).toEqual([{ type: "tool_result", toolUseId: "b", result: "" }]);
		expect(consume("session.tool.failed", { id: "b", error: { message: "Denied" } })).toEqual({ messages: [{ type: "tool_result", toolUseId: "b", result: "[Error] Denied" }], done: false });
		expect(consume("permission.asked", { id: "p", action: "shell", metadata: { command: "ls" } }).messages).toEqual([{ type: "permission_request", requestId: "p", toolUseId: "p", toolName: "shell", toolInput: { command: "ls" }, title: "shell" }]);
		expect(consume("session.execution.failed", { error: { message: "No model" } })).toEqual({ messages: [{ type: "error", error: "No model", code: "opencode_session_error" }], done: true });
		expect(consume("session.execution.interrupted")).toEqual({ messages: [{ type: "error", error: "OpenCode query aborted.", code: "provider_error" }], done: true });
	});
});

describe("OpenCode 2 transport", () => {
	test("SSE handles comments, CRLF, multiline data and split UTF-8, and closes on abort", async () => {
		const encoder = new TextEncoder();
		let cancelled = false;
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(new ReadableStream({
			start(controller) {
				const bytes = encoder.encode(': heartbeat\r\n\r\nevent: ignored\r\ndata: {"type":"session.text.delta",\r\ndata: "data":{"delta":"héllo"}}\r\n\r\n');
				for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
			},
			cancel() { cancelled = true; },
		}), { headers: { "Content-Type": "text/event-stream" } }) });
		const abort = new AbortController();
		try {
			const events = new OpenCodeV2Client(server.url.origin, "Basic x").events(abort.signal);
			expect((await events.next()).value).toEqual({ type: "session.text.delta", data: { delta: "héllo" } });
			const pending = events.next();
			abort.abort();
			expect((await pending).done).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(cancelled).toBe(true);
		} finally { abort.abort(); server.stop(true); }
	});

	test("malformed frames are skipped without losing the next event", async () => {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('data: not-json\n\ndata: {"type":"server.connected","data":{}}\n\n') });
		try {
			const events = new OpenCodeV2Client(server.url.origin, "Basic x").events(new AbortController().signal);
			expect((await events.next()).value).toEqual({ type: "server.connected", data: {} });
			expect((await events.next()).done).toBe(true);
		} finally { server.stop(true); }
	});

	test("HTTP errors retain status/tag/message, successful envelopes unwrap, and a non-2.x answer keeps 1.x", async () => {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/error") return Response.json({ _tag: "InvalidRequestError", message: "Expected object" }, { status: 400 });
			if (path === "/plain") return new Response("unavailable", { status: 503 });
			if (path === "/data") return Response.json({ data: [] });
			if (path === "/api/info") return Response.json({ version: "1.19.6" });
			return new Response("<!doctype html>");
		} });
		try {
			const client = new OpenCodeV2Client(server.url.origin, "Basic x");
			await expect(client.request("/error", {})).rejects.toThrow("OpenCode HTTP 400: InvalidRequestError: Expected object");
			await expect(client.request("/plain")).rejects.toThrow("OpenCode HTTP 503: unavailable");
			expect(await client.request("/data")).toEqual([]);
			// A 1.x answer that happens to be JSON (a 1.x /api/info, or its catch-all) is not 2.x.
			expect(await detectOpenCodeV2(server.url.origin, "Basic x")).toBe(false);
			expect(await detectOpenCodeV2(`${server.url.origin}/html`, "Basic x")).toBe(false);
		} finally { server.stop(true); }
	});

	for (const status of [401, 403]) {
		test(`HTTP ${status} during detection is a startup error, not v1`, async () => {
			const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("denied", { status }) });
			try {
				await expect(detectOpenCodeV2(server.url.origin, "Basic x")).rejects.toThrow(`OpenCode startup failed: HTTP ${status} (server password not accepted)`);
			} finally { server.stop(true); }
		});
	}

	// OpenCode 1 has no /api/info; its catch-all answers it, and offline that is an error.
	for (const status of [404, 500, 502]) {
		test(`HTTP ${status} during detection keeps the 1.x client`, async () => {
			const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Internal Server Error", { status }) });
			try {
				expect(await detectOpenCodeV2(server.url.origin, "Basic x")).toBe(false);
			} finally { server.stop(true); }
		});
	}
});
