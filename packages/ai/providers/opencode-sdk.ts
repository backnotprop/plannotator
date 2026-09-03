/**
 * OpenCode provider — bridges Plannotator's AI layer with OpenCode's agent server.
 *
 * Uses @opencode-ai/sdk to spawn a dedicated `opencode serve` on an
 * OS-assigned port. One server is shared across all sessions of this process,
 * closed on dispose and on process exit. This provider deliberately never
 * attaches to a server it did not spawn: an attached server cannot be cleaned
 * up by us, and opencode's per-directory instances accumulate in it without
 * eviction, so a shared long-lived server grows without bound. The user must
 * have the `opencode` CLI installed and authenticated.
 */

import type { OpencodeClient } from "@opencode-ai/sdk";
import { BaseSession } from "../base-session.ts";
import { buildSystemPrompt } from "../context.ts";
import type {
	AIMessage,
	AIProvider,
	AIProviderCapabilities,
	AISession,
	CreateSessionOptions,
	OpenCodeConfig,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_NAME = "opencode-sdk";

// ---------------------------------------------------------------------------
// SDK import cache — resolve once, reuse across all sessions
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: SDK types not available at compile time
let sdk: any = null;

async function getSDK() {
	if (!sdk) {
		sdk = await import("@opencode-ai/sdk");
	}
	return sdk;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OpenCodeProvider implements AIProvider {
	readonly name = PROVIDER_NAME;
	readonly capabilities: AIProviderCapabilities = {
		fork: true,
		resume: true,
		streaming: true,
		tools: true,
	};
	models?: Array<{ id: string; label: string; default?: boolean }>;

	private config: OpenCodeConfig;
	// biome-ignore lint/suspicious/noExplicitAny: SDK types not available at compile time
	private server: { url: string; close: () => void } | null = null;
	private client: OpencodeClient | null = null;
	private startPromise: Promise<void> | null = null;
	private exitHandler: (() => void) | null = null;
	/**
	 * Bumped by dispose() to invalidate an in-flight doStart: a spawn that
	 * completes after its epoch has passed reaps its own server instead of
	 * resurrecting a provider the runtime already considers disposed.
	 */
	private startEpoch = 0;

	constructor(config: OpenCodeConfig) {
		this.config = config;
	}

	/** Spawn this process's OpenCode server if it is not already running. */
	async ensureServer(): Promise<void> {
		if (this.client) return;
		this.startPromise ??= this.doStart().catch((err) => {
			this.startPromise = null;
			throw err;
		});
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		const epoch = this.startEpoch;
		const { createOpencodeServer, createOpencodeClient } = await getSDK();
		// port 0 asks opencode for an OS-assigned free port (the SDK reads the
		// real URL back from the child's "listening" line), so every Plannotator
		// process gets its own server instead of piling onto a shared default
		// port. An explicitly configured port is still honored verbatim.
		const server: { url: string; close: () => void } = await createOpencodeServer({
			hostname: this.config.hostname ?? "127.0.0.1",
			port: this.config.port ?? 0,
			timeout: 15_000,
		});
		// A SIGINT/SIGTERM death is routed through process.exit() by the CLI, so
		// an "exit" handler is what keeps Ctrl-C from orphaning the spawned
		// `opencode serve` child (server.close() kills it synchronously). The
		// closure captures ITS server — never `this.server`, which a failed
		// retry could have replaced, leaving the first child unreachable by any
		// cleanup. No SIGHUP listener: that would override the ignored
		// disposition `nohup` depends on.
		const exitHandler = () => {
			try {
				server.close();
			} catch {
				// Best effort — the process is exiting either way.
			}
		};
		process.once("exit", exitHandler);

		const reap = () => {
			process.removeListener("exit", exitHandler);
			try {
				server.close();
			} catch {
				// Best effort — the child may already be gone.
			}
		};

		if (epoch !== this.startEpoch) {
			// dispose() ran while the spawn was in flight: the runtime no longer
			// wants this provider, so reap the just-spawned server instead of
			// resurrecting a disposed provider with a live child.
			reap();
			throw new Error("OpenCode provider was disposed during startup.");
		}

		try {
			this.client = createOpencodeClient({
				baseUrl: server.url,
				directory: this.config.cwd ?? process.cwd(),
			});
		} catch (err) {
			// A post-spawn failure must not leak the child: close it and drop the
			// handler so a retry starts from a clean slate.
			reap();
			throw err;
		}
		this.server = server;
		this.exitHandler = exitHandler;
	}

	private getClient(): OpencodeClient {
		if (!this.client) {
			throw new Error("OpenCode client is not initialized.");
		}
		return this.client;
	}

	async createSession(options: CreateSessionOptions): Promise<AISession> {
		await this.ensureServer();
		const client = this.getClient();

		const result = await client.session.create({
			query: { directory: options.cwd ?? this.config.cwd ?? process.cwd() },
		});
		const sessionData = result.data;
		if (!sessionData) {
			throw new Error("OpenCode did not return session data.");
		}

		const session = new OpenCodeSession({
			sessionId: sessionData.id,
			systemPrompt: buildSystemPrompt(options.context),
			client,
			model: options.model,
			parentSessionId: null,
		});
		return session;
	}

	async forkSession(options: CreateSessionOptions): Promise<AISession> {
		await this.ensureServer();
		const client = this.getClient();

		const parentId = options.context.parent?.sessionId;
		if (!parentId) {
			throw new Error("Fork requires a parent session ID.");
		}

		const result = await client.session.fork({
			path: { id: parentId },
		});
		const sessionData = result.data;
		if (!sessionData) {
			throw new Error("OpenCode did not return forked session data.");
		}

		return new OpenCodeSession({
			sessionId: sessionData.id,
			systemPrompt: buildSystemPrompt(options.context),
			client,
			model: options.model,
			parentSessionId: parentId,
		});
	}

	async resumeSession(sessionId: string): Promise<AISession> {
		await this.ensureServer();
		const client = this.getClient();

		// Verify session exists
		await client.session.get({ path: { id: sessionId } });

		return new OpenCodeSession({
			sessionId,
			systemPrompt: null,
			client,
			model: undefined,
			parentSessionId: null,
		});
	}

	dispose(): void {
		// Invalidate any in-flight doStart so a spawn completing after this
		// point reaps itself instead of resurrecting the provider.
		this.startEpoch++;
		if (this.exitHandler) {
			process.removeListener("exit", this.exitHandler);
			this.exitHandler = null;
		}
		if (this.server) {
			this.server.close();
			this.server = null;
		}
		this.client = null;
		this.startPromise = null;
	}

	/** Fetch available models from OpenCode. Call before registering the provider. */
	async fetchModels(): Promise<void> {
		try {
			await this.ensureServer();
			const client = this.getClient();

			const result = await client.provider.list({
				query: { directory: this.config.cwd ?? process.cwd() },
			});
			const data = result.data;
			if (!data) {
				return;
			}
			const connected = new Set(data.connected ?? []);
			const allProviders = data.all ?? [];

			const models: Array<{ id: string; label: string; default?: boolean }> = [];
			for (const provider of allProviders) {
				if (!connected.has(provider.id)) continue;
				for (const model of Object.values(provider.models)) {
					models.push({
						id: `${provider.id}/${model.id}`,
						// include the provider name: different providers can expose
						// models with the same name (e.g. deepseek-v4-pro via
						// DeepSeek and via OpenRouter), which would otherwise be
						// indistinguishable in the dropdown
						label: `${model.name ?? model.id} (${provider.name})`,
					});
				}
			}

			if (models.length > 0) {
				// Mark first model as default
				models[0].default = true;
				this.models = models;
			}
		} catch {
			// OpenCode not configured or no models available
		}
	}
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface SessionConfig {
	sessionId: string;
	systemPrompt: string | null;
	// biome-ignore lint/suspicious/noExplicitAny: SDK types not available at compile time
	client: any;
	/** Model in "providerID/modelID" format. */
	model?: string;
	parentSessionId: string | null;
}

class OpenCodeSession extends BaseSession {
	private config: SessionConfig;

	constructor(config: SessionConfig) {
		super({
			parentSessionId: config.parentSessionId,
			initialId: config.sessionId,
		});
		this.config = config;
		this._resolvedId = config.sessionId;
	}

	async *query(prompt: string): AsyncIterable<AIMessage> {
		const started = this.startQuery();
		if (!started) {
			yield BaseSession.BUSY_ERROR;
			return;
		}
		const { gen, signal } = started;

		try {
			// Build model param if specified
			let modelParam: { providerID: string; modelID: string } | undefined;
			if (this.config.model) {
				const [providerID, ...rest] = this.config.model.split("/");
				const modelID = rest.join("/");
				if (providerID && modelID) {
					modelParam = { providerID, modelID };
				}
			}

			// Open the SSE stream and wait for the first frame *before* prompting.
			// OpenCode 1.18+ can finish a short turn before a late subscriber
			// connects; Ask AI then hangs until the browser reports Failed to fetch.
			const { stream } = await this.config.client.event.subscribe(
				undefined,
				{ signal },
			);
			const iterator = stream[Symbol.asyncIterator]();

			try {
				// First frame only proves the subscriber is live. Do not treat it as
				// this turn — it can be server.connected or leftover idle from a
				// previous query on the same session.
				const first = await iterator.next();
				if (first.done) {
					yield {
						type: "error",
						error: "OpenCode event stream closed before the prompt was sent.",
						code: "provider_error",
					};
					return;
				}

				try {
					await this.config.client.session.promptAsync({
						path: { id: this.config.sessionId },
						body: {
							...(!this._firstQuerySent &&
								this.config.systemPrompt && {
									system: this.config.systemPrompt,
								}),
							...(modelParam && { model: modelParam }),
							parts: [{ type: "text", text: prompt }],
						},
					});
				} catch (err) {
					yield {
						type: "error",
						error: `OpenCode rejected prompt: ${err instanceof Error ? err.message : String(err)}`,
						code: "opencode_prompt_rejected",
					};
					return;
				}
				this._firstQuerySent = true;

				const state = createOpenCodeQueryState();
				while (!signal.aborted) {
					const next = await iterator.next();
					if (next.done) break;
					const { messages, done } = consumeOpenCodeEvent(
						next.value,
						this.config.sessionId,
						state,
					);
					for (const msg of messages) yield msg;
					if (done) return;
				}

				yield {
					type: "error",
					error: signal.aborted
						? "OpenCode query aborted."
						: "OpenCode event stream ended without a result.",
					code: "provider_error",
				};
			} finally {
				await iterator.return?.();
			}
		} catch (err) {
			yield {
				type: "error",
				error: err instanceof Error ? err.message : String(err),
				code: "provider_error",
			};
		} finally {
			this.endQuery(gen);
		}
	}

	abort(): void {
		this.config.client.session
			.abort({ path: { id: this.config.sessionId } })
			.catch(() => {});
		super.abort();
	}

	respondToPermission(
		requestId: string,
		allow: boolean,
		_message?: string,
	): void {
		this.config.client
			.postSessionIdPermissionsPermissionId({
				path: { id: this.config.sessionId, permissionID: requestId },
				body: { response: allow ? "once" : "reject" },
			})
			.catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

/** Returns true for events that should terminate the query when mapped to an error. */
function isTerminalEvent(eventType: string): boolean {
	return eventType === "session.error" || eventType === "session.status";
}

export function openCodeEventSessionId(
	props: Record<string, unknown>,
): string | undefined {
	return (
		(props.sessionID as string | undefined) ??
		((props.info as Record<string, unknown> | undefined)?.sessionID as
			| string
			| undefined) ??
		((props.part as Record<string, unknown> | undefined)?.sessionID as
			| string
			| undefined)
	);
}

/**
 * OpenCode 1.18 still emits `message.part.delta` for streaming text, but some
 * turns only land a final `message.part.updated` snapshot (or a late
 * subscriber misses the deltas). Capture assistant text parts so Ask AI can
 * still render an answer. User-prompt snapshots have no `time` stamp.
 */
export function assistantTextFromPartUpdate(
	part: Record<string, unknown> | undefined,
): string | undefined {
	if (!part || part.type !== "text") return undefined;
	if (part.time == null) return undefined;
	const text = part.text;
	return typeof text === "string" && text.length > 0 ? text : undefined;
}

export interface OpenCodeQueryState {
	sawTextDelta: boolean;
	lastAssistantText: string;
}

export function createOpenCodeQueryState(): OpenCodeQueryState {
	return { sawTextDelta: false, lastAssistantText: "" };
}

/**
 * If this turn never streamed `message.part.delta` text, emit the last
 * assistant snapshot so Ask AI still has something to render (#514 / #907).
 */
export function fallbackAssistantText(state: OpenCodeQueryState): AIMessage[] {
	if (state.sawTextDelta || !state.lastAssistantText) return [];
	return [{ type: "text_delta", delta: state.lastAssistantText }];
}

/**
 * Consume one OpenCode SSE event after promptAsync. Returns mapped Ask AI
 * messages and whether the query should stop. Pre-prompt leftover idle is
 * ignored by only calling this after the prompt is sent.
 */
export function consumeOpenCodeEvent(
	event: { type?: string; properties?: Record<string, unknown> },
	sessionId: string,
	state: OpenCodeQueryState,
): { messages: AIMessage[]; done: boolean } {
	const eventType = event.type as string;
	const props = event.properties;
	if (props == null) return { messages: [], done: false };

	const eventSessionId = openCodeEventSessionId(props);
	if (eventSessionId && eventSessionId !== sessionId) {
		return { messages: [], done: false };
	}

	if (eventType === "message.part.updated") {
		const snapshot = assistantTextFromPartUpdate(
			props.part as Record<string, unknown> | undefined,
		);
		if (snapshot) state.lastAssistantText = snapshot;
	}

	const mapped = mapOpenCodeEvent(eventType, props, sessionId);
	const messages: AIMessage[] = [];
	let done = false;
	for (const msg of mapped) {
		if (msg.type === "text_delta") state.sawTextDelta = true;
		if (msg.type === "result") {
			messages.push(...fallbackAssistantText(state));
			done = true;
		}
		messages.push(msg);
		if (msg.type === "error" && isTerminalEvent(eventType)) done = true;
	}
	return { messages, done };
}

/**
 * Map an OpenCode SSE event to AIMessage[].
 *
 * Key events:
 *   message.part.delta  → text_delta (streaming text)
 *   message.part.updated → tool_use / tool_result (tool lifecycle)
 *   permission.updated   → permission_request
 *   session.status        → result (when idle)
 *   message.updated       → error (when message has error)
 */
export function mapOpenCodeEvent(
	eventType: string,
	props: Record<string, unknown>,
	sessionId: string,
): AIMessage[] {
	switch (eventType) {
		case "message.part.delta": {
			const field = props.field as string;
			const delta = props.delta as string;
			// Reasoning/thinking deltas share this event; Ask AI only renders
			// assistant answer text.
			if (field === "text" && delta) {
				return [{ type: "text_delta", delta }];
			}
			return [];
		}

		case "message.part.updated": {
			const part = props.part as Record<string, unknown>;
			if (!part) return [];

			const partType = part.type as string;

			if (partType === "tool") {
				const state = part.state as Record<string, unknown>;
				if (!state) return [];

				const status = state.status as string;
				const callID = (part.callID as string) ?? (part.id as string);
				const toolName = part.tool as string;

				switch (status) {
					case "running":
						return [
							{
								type: "tool_use",
								toolName: toolName ?? "unknown",
								toolInput: (state.input as Record<string, unknown>) ?? {},
								toolUseId: callID,
							},
						];

					case "completed": {
						const output = (state.output as string) ?? "";
						return [
							{
								type: "tool_result",
								toolUseId: callID,
								result: output,
							},
						];
					}

					case "error": {
						const error = (state.error as string) ?? "Tool execution failed";
						return [
							{
								type: "tool_result",
								toolUseId: callID,
								result: `[Error] ${error}`,
							},
						];
					}

					default:
						return [];
				}
			}

			return [];
		}

		case "permission.updated": {
			const id = props.id as string;
			const permType = props.type as string;
			const title = props.title as string;
			const callID = props.callID as string;
			const metadata = (props.metadata as Record<string, unknown>) ?? {};

			return [
				{
					type: "permission_request",
					requestId: id,
					toolName: permType ?? "unknown",
					toolInput: metadata,
					title: title ?? permType,
					toolUseId: callID ?? id,
				},
			];
		}

		case "session.status": {
			const status = props.status as Record<string, unknown>;
			if (status?.type === "idle") {
				return [
					{
						type: "result",
						sessionId,
						success: true,
					},
				];
			}
			return [];
		}

		case "session.error": {
			const error = props.error as Record<string, unknown>;
			const message =
				(error?.message as string) ?? (props.message as string) ?? "Session error";
			return [
				{
					type: "error",
					error: message,
					code: "opencode_session_error",
				},
			];
		}

		case "message.updated": {
			const info = props.info as Record<string, unknown>;
			if (!info) return [];

			const msgError = info.error as Record<string, unknown>;
			if (msgError) {
				const errorData = msgError.data as Record<string, unknown>;
				const message =
					(errorData?.message as string) ??
					(msgError.name as string) ??
					"Message error";
				return [
					{
						type: "error",
						error: message,
						code: "opencode_message_error",
					},
				];
			}
			return [];
		}

		default:
			return [];
	}
}

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

import { registerProviderFactory } from "../provider.ts";

registerProviderFactory(
	PROVIDER_NAME,
	async (config) => new OpenCodeProvider(config as OpenCodeConfig),
);
