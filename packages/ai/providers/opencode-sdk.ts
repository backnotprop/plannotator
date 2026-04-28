/**
 * OpenCode provider — bridges Plannotator's AI layer with OpenCode's agent server.
 *
 * Uses @opencode-ai/sdk to connect to an existing `opencode serve` first and
 * only spawns a new server when nothing is reachable. One server is shared
 * across all sessions. The user must have the `opencode` CLI installed and
 * authenticated.
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
	private lastAttachError: string | null = null;

	constructor(config: OpenCodeConfig) {
		this.config = config;
	}

	/** Attach to an existing OpenCode server or spawn one if needed. */
	async ensureServer(): Promise<void> {
		if (this.client) return;
		this.startPromise ??= this.doStart().catch((err) => {
			this.startPromise = null;
			throw err;
		});
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		this.lastAttachError = null;
		const { createOpencodeServer, createOpencodeClient } = await getSDK();
		const attachedClient = await this.tryAttachExistingServer(createOpencodeClient);
		if (attachedClient) {
			this.client = attachedClient;
			return;
		}

		try {
			this.server = await createOpencodeServer({
				hostname: this.config.hostname ?? "127.0.0.1",
				...(this.config.port != null && { port: this.config.port }),
				timeout: 15_000,
			});
		} catch (err) {
			const spawnMessage = err instanceof Error ? err.message : String(err);
			if (this.lastAttachError) {
				throw new Error(`${this.lastAttachError}\nFallback startup also failed: ${spawnMessage}`);
			}
			throw err;
		}

		this.client = createOpencodeClient({
			baseUrl: this.server!.url,
			directory: this.config.cwd ?? process.cwd(),
		});
	}

	private async tryAttachExistingServer(
		createOpencodeClient: (config?: { baseUrl?: string; directory?: string }) => OpencodeClient,
	): Promise<OpencodeClient | null> {
		const cwd = this.config.cwd ?? process.cwd();
		const baseUrl = `http://${this.config.hostname ?? "127.0.0.1"}:${this.config.port ?? 4096}`;
		const client = createOpencodeClient({
			baseUrl,
			directory: cwd,
		});

		try {
			await client.config.get({
				throwOnError: true,
				signal: AbortSignal.timeout(1_000),
			});
			return client;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.lastAttachError = `Failed to attach to existing OpenCode server at ${baseUrl}: ${message}`;
			return null;
		}
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
						label: model.name ?? model.id,
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
		const { gen } = started;

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

			// Subscribe to SSE events
			const { stream } = await this.config.client.event.subscribe();

			try {
				// Send prompt asynchronously
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

				// Drain SSE events filtered by session ID
				for await (const event of stream) {
					const eventType = event.type as string;
					const props = event.properties as Record<string, unknown> | undefined;
					if (!props) continue;

					// Filter: only events for our session
					const eventSessionId =
						(props.sessionID as string) ??
						((props.info as Record<string, unknown>)?.sessionID as string) ??
						((props.part as Record<string, unknown>)?.sessionID as string);
					if (eventSessionId && eventSessionId !== this.config.sessionId) continue;

					const mapped = mapOpenCodeEvent(eventType, props, this.id);
					for (const msg of mapped) {
						yield msg;
						if (msg.type === "result" || (msg.type === "error" && isTerminalEvent(eventType))) {
							return;
						}
					}
				}
			} finally {
				stream.return?.();
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
