import type { OpencodeClient } from "@opencode-ai/sdk";
import { BaseSession } from "../base-session.ts";
import { buildSystemPrompt } from "../context.ts";
import { withAskAiChildEnv } from "./ask-ai-env.ts";
import type {
	AIMessage,
	AIProvider,
	AIProviderCapabilities,
	AISession,
	CreateSessionOptions,
	OpenCodeConfig,
} from "../types.ts";

const PROVIDER_NAME = "opencode-sdk";

let sdk: any = null;

async function getSDK() {
	if (!sdk) {
		sdk = await import("@opencode-ai/sdk");
	}
	return sdk;
}

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
	private server: { url: string; close: () => void } | null = null;
	private client: OpencodeClient | null = null;
	private startPromise: Promise<void> | null = null;
	private exitHandler: (() => void) | null = null;
	private startEpoch = 0;

	constructor(config: OpenCodeConfig) {
		this.config = config;
	}

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
		let server: { url: string; close: () => void };
		try {
			server = await withAskAiChildEnv(() =>
				createOpencodeServer({
					hostname: this.config.hostname ?? "127.0.0.1",
					port: this.config.port ?? 0,
					timeout: 15_000,
				}),
			);
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
				throw new Error(
					"OpenCode CLI (`opencode`) was not found on PATH. Install it (https://opencode.ai) or choose a different AI provider.",
					{ cause: err },
				);
			}
			throw err;
		}
		const exitHandler = () => {
			try {
				server.close();
			} catch {
			}
		};
		process.once("exit", exitHandler);

		const reap = () => {
			process.removeListener("exit", exitHandler);
			try {
				server.close();
			} catch {
			}
		};

		if (epoch !== this.startEpoch) {
			reap();
			throw new Error("OpenCode provider was disposed during startup.");
		}

		try {
			this.client = createOpencodeClient({
				baseUrl: server.url,
				directory: this.config.cwd ?? process.cwd(),
			});
		} catch (err) {
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
			systemPrompt: options.oneShot?.systemPrompt ?? buildSystemPrompt(options.context),
			client,
			model: options.model,
			parentSessionId: null,
			firstEventTimeoutMs: this.config.firstEventTimeoutMs,
			noTools: !!options.oneShot,
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
			firstEventTimeoutMs: this.config.firstEventTimeoutMs,
		});
	}

	async resumeSession(sessionId: string): Promise<AISession> {
		await this.ensureServer();
		const client = this.getClient();

		await client.session.get({ path: { id: sessionId } });

		return new OpenCodeSession({
			sessionId,
			systemPrompt: null,
			client,
			model: undefined,
			parentSessionId: null,
			firstEventTimeoutMs: this.config.firstEventTimeoutMs,
		});
	}

	dispose(): void {
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
						label: `${model.name ?? model.id} (${provider.name})`,
					});
				}
			}

			if (models.length > 0) {
				models[0].default = true;
				this.models = models;
			}
		} catch {
		}
	}
}

interface SessionConfig {
	sessionId: string;
	systemPrompt: string | null;
	client: any;
	model?: string;
	parentSessionId: string | null;
	firstEventTimeoutMs?: number;
	noTools?: boolean;
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
			let modelParam: { providerID: string; modelID: string } | undefined;
			if (this.config.model) {
				const [providerID, ...rest] = this.config.model.split("/");
				const modelID = rest.join("/");
				if (providerID && modelID) {
					modelParam = { providerID, modelID };
				}
			}

			const subscription = new AbortController();
			const abortSubscription = () => subscription.abort();
			signal.addEventListener("abort", abortSubscription, { once: true });
			if (signal.aborted) subscription.abort();
			let iterator: AsyncIterator<{ type?: string; properties?: Record<string, unknown> }> | null = null;

			try {
				const { stream } = await this.config.client.event.subscribe({
					signal: subscription.signal,
				});
				const events: AsyncIterator<{ type?: string; properties?: Record<string, unknown> }> =
					stream[Symbol.asyncIterator]();
				iterator = events;
				const first = await nextEventWithin(
					events,
					this.config.firstEventTimeoutMs ?? OPENCODE_FIRST_EVENT_TIMEOUT_MS,
					signal,
				);
				if (first === "aborted") {
					yield { type: "error", error: "OpenCode query aborted.", code: "provider_error" };
					return;
				}
				if (first === "timeout") {
					yield {
						type: "error",
						error: "OpenCode's event stream did not connect, so the question was not sent.",
						code: "provider_error",
					};
					return;
				}
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
							...(this.config.noTools && { tools: { "*": false }, variant: "low" }),
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
					const next = await nextEventWithin(events, null, signal);
					if (next === "aborted" || next === "timeout" || next.done) break;
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
				signal.removeEventListener("abort", abortSubscription);
				subscription.abort();
				void Promise.resolve(iterator?.return?.()).catch(() => {});
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

function isTerminalEvent(eventType: string): boolean {
	return eventType === "session.error" || eventType === "session.status";
}

export const OPENCODE_FIRST_EVENT_TIMEOUT_MS = 10_000;

export async function nextEventWithin<T>(
	iterator: AsyncIterator<T>,
	timeoutMs: number | null,
	signal: AbortSignal,
): Promise<IteratorResult<T> | "timeout" | "aborted"> {
	if (signal.aborted) return "aborted";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const stop = new Promise<"timeout" | "aborted">((resolve) => {
		if (timeoutMs !== null) timer = setTimeout(() => resolve("timeout"), timeoutMs);
		onAbort = () => resolve("aborted");
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([iterator.next(), stop]);
	} finally {
		clearTimeout(timer);
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
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

export function fallbackAssistantText(state: OpenCodeQueryState): AIMessage[] {
	if (state.sawTextDelta || !state.lastAssistantText) return [];
	return [{ type: "text_delta", delta: state.lastAssistantText }];
}

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

import { registerProviderFactory } from "../provider.ts";

registerProviderFactory(
	PROVIDER_NAME,
	async (config) => new OpenCodeProvider(config as OpenCodeConfig),
);
