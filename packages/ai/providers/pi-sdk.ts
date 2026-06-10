/**
 * Pi SDK provider — bridges Plannotator's AI layer with Pi's coding agent.
 *
 * Spawns `pi --mode rpc` as a subprocess and communicates via JSONL over
 * stdio. No Pi SDK is imported — this is a thin protocol adapter.
 *
 * One subprocess per session. The user must have the `pi` CLI installed.
 */

import { BaseSession } from "../base-session.ts";
import { buildEffectivePrompt, buildSystemPrompt } from "../context.ts";
import type {
	AIMessage,
	AIProvider,
	AIProviderCapabilities,
	CreateSessionOptions,
	PiSDKConfig,
} from "../types.ts";
import {
	buildWindowsCommandScriptSpawnCommand,
	killWindowsProcessTree,
	resolveWindowsCommandShim,
} from "./command-path.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_NAME = "pi-sdk";

// ---------------------------------------------------------------------------
// JSONL subprocess wrapper
// ---------------------------------------------------------------------------

type EventListener = (event: Record<string, unknown>) => void;

class PiProcess {
	private proc: ReturnType<typeof Bun.spawn> | null = null;
	private listeners: EventListener[] = [];
	private pendingRequests = new Map<
		string,
		{
			resolve: (data: Record<string, unknown>) => void;
			reject: (err: Error) => void;
		}
	>();
	private nextId = 0;
	private buffer = "";
	private _alive = false;

	async spawn(piPath: string, cwd: string): Promise<void> {
		const commandPath = resolveWindowsCommandShim(piPath);
		const command =
			buildWindowsCommandScriptSpawnCommand(commandPath, ["--mode", "rpc"]) ?? [
				commandPath,
				"--mode",
				"rpc",
			];
		try {
			this.proc = Bun.spawn(command, {
				cwd,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.handleProcessEnd(error);
			throw error;
		}
		this._alive = true;

		this.readStream();

		this.proc.exited.then(() => {
			this.handleProcessEnd(new Error("Pi process exited unexpectedly"));
		});
	}

	private handleProcessEnd(error: Error): void {
		if (!this.proc && this.pendingRequests.size === 0) return;

		this._alive = false;
		this.proc = null;
		for (const [, pending] of this.pendingRequests) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
		// Signal active query listeners so the drain loop exits with an error
		for (const listener of this.listeners) {
			listener({ type: "process_exited" });
		}
	}

	private async readStream(): Promise<void> {
		if (!this.proc?.stdout || typeof this.proc.stdout === "number") return;
		const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				this.buffer += decoder.decode(value, { stream: true });
				const lines = this.buffer.split("\n");
				this.buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.replace(/\r$/, "");
					if (!trimmed) continue;
					try {
						const parsed = JSON.parse(trimmed);
						this.routeMessage(parsed);
					} catch {
						// Ignore malformed lines
					}
				}
			}
		} catch {
			// Stream closed
		}
	}

	private routeMessage(msg: Record<string, unknown>): void {
		// Response to a command we sent
		if (msg.type === "response" && typeof msg.id === "string") {
			const pending = this.pendingRequests.get(msg.id);
			if (pending) {
				this.pendingRequests.delete(msg.id);
				if (msg.success === false) {
					pending.reject(new Error((msg.error as string) ?? "RPC error"));
				} else {
					pending.resolve((msg.data as Record<string, unknown>) ?? {});
				}
				return;
			}
		}

		// Agent event — forward to listeners
		for (const listener of this.listeners) {
			listener(msg);
		}
	}

	/** Send a command without waiting for a response. */
	send(command: Record<string, unknown>): void {
		if (!this.proc?.stdin || typeof this.proc.stdin === "number") return;
		// Bun.spawn stdin is a FileSink with .write(), not a WritableStream
		const sink = this.proc.stdin as { write(data: string): void; flush(): void };
		sink.write(`${JSON.stringify(command)}\n`);
		sink.flush();
	}

	/** Send a command and wait for the correlated response. */
	sendAndWait(
		command: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const id = `req_${++this.nextId}`;
		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.send({ ...command, id });
		});
	}

	/** Register a listener for agent events (non-response messages). */
	onEvent(listener: EventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	get alive(): boolean {
		return this._alive;
	}

	kill(): void {
		this._alive = false;
		const proc = this.proc;
		this.proc = null;
		if (proc) {
			if (!killWindowsProcessTree(proc.pid)) {
				proc.kill();
			}
		}
		this.listeners.length = 0;
		for (const [, pending] of this.pendingRequests) {
			pending.reject(new Error("Process killed"));
		}
		this.pendingRequests.clear();
	}
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class PiSDKProvider implements AIProvider {
	readonly name = PROVIDER_NAME;
	readonly capabilities: AIProviderCapabilities = {
		fork: false,
		resume: false,
		streaming: true,
		tools: true,
	};
	models?: Array<{ id: string; label: string; default?: boolean }>;

	private config: PiSDKConfig;
	private sessions = new Map<string, PiSDKSession>();

	constructor(config: PiSDKConfig) {
		this.config = config;
	}

	async createSession(options: CreateSessionOptions): Promise<PiSDKSession> {
		const session = new PiSDKSession({
			systemPrompt: buildSystemPrompt(options.context),
			cwd: options.cwd ?? this.config.cwd ?? process.cwd(),
			parentSessionId: null,
			piExecutablePath: this.config.piExecutablePath ?? "pi",
			model: options.model ?? this.config.model,
		});
		this.sessions.set(session.id, session);
		return session;
	}

	async forkSession(): Promise<never> {
		throw new Error(
			"Pi does not support session forking. " +
				"The endpoint layer should fall back to createSession().",
		);
	}

	async resumeSession(): Promise<never> {
		throw new Error("Pi does not support session resuming.");
	}

	dispose(): void {
		for (const session of this.sessions.values()) {
			session.killProcess();
		}
		this.sessions.clear();
	}

	/** Fetch available models from Pi. Call before registering the provider. */
	async fetchModels(): Promise<void> {
		const piPath = this.config.piExecutablePath ?? "pi";

		let proc: PiProcess | undefined;

		try {
			proc = new PiProcess();
			await proc.spawn(piPath, this.config.cwd ?? process.cwd());

			const data = await Promise.race([
				proc.sendAndWait({ type: "get_available_models" }),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Timeout")), 10_000),
				),
			]);

			const rawModels = (
				data as {
					models?: Array<{ provider: string; id: string; name?: string }>;
				}
			).models;
			if (rawModels && rawModels.length > 0) {
				this.models = rawModels.map((m, i) => ({
					id: `${m.provider}/${m.id}`,
					label: m.name ?? m.id,
					...(i === 0 && { default: true }),
				}));
			}
		} catch {
			// Pi not configured or no models available
		} finally {
			proc?.kill();
		}
	}
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface SessionConfig {
	systemPrompt: string;
	cwd: string;
	parentSessionId: string | null;
	piExecutablePath: string;
	/** Model in "provider/modelId" format, e.g. "anthropic/claude-haiku-4-5". */
	model?: string;
}

class PiSDKSession extends BaseSession {
	private config: SessionConfig;
	private process: PiProcess | null = null;

	constructor(config: SessionConfig) {
		super({ parentSessionId: config.parentSessionId });
		this.config = config;
	}

	async *query(prompt: string): AsyncIterable<AIMessage> {
		const started = this.startQuery();
		if (!started) {
			yield BaseSession.BUSY_ERROR;
			return;
		}
		const { gen } = started;

		try {
			// Lazy-spawn subprocess
			if (!this.process || !this.process.alive) {
				this.process = new PiProcess();
				await this.process.spawn(this.config.piExecutablePath, this.config.cwd);

				// Set model if specified (format: "provider/modelId")
				if (this.config.model) {
					const [provider, ...rest] = this.config.model.split("/");
					const modelId = rest.join("/");
					if (provider && modelId) {
						try {
							await this.process.sendAndWait({
								type: "set_model",
								provider,
								modelId,
							});
						} catch {
							// Continue with Pi's default model
						}
					}
				}

				// Get session ID
				try {
					const state = await this.process.sendAndWait({ type: "get_state" });
					if (typeof state.sessionId === "string") {
						this.resolveId(state.sessionId);
					}
				} catch {
					// Continue with placeholder ID
				}

				// If subprocess died during startup, surface the error immediately
				if (!this.process.alive) {
					yield {
						type: "error",
						error:
							"Pi process exited during startup. Check that Pi is configured correctly (API keys, models).",
						code: "pi_startup_error",
					};
					return;
				}
			}

			// Build effective prompt (prepend system prompt on first query)
			const effectivePrompt = buildEffectivePrompt(
				prompt,
				this.config.systemPrompt,
				this._firstQuerySent,
			);

			// Set up async queue to bridge callback events → async iterable
			const queue: AIMessage[] = [];
			let resolve: (() => void) | null = null;
			let done = false;

			const push = (msg: AIMessage) => {
				queue.push(msg);
				resolve?.();
			};

			const finish = () => {
				done = true;
				resolve?.();
			};

			const unsubscribe = this.process.onEvent((event) => {
				const mapped = mapPiEvent(event, this.id);
				for (const msg of mapped) {
					push(msg);
					if (
						msg.type === "result" ||
						(msg.type === "error" &&
							(event.type === "agent_end" || event.type === "process_exited"))
					) {
						finish();
					}
				}
			});

			// Send prompt — use sendAndWait to catch RPC-level rejections
			// (e.g. expired credentials, invalid session)
			try {
				await this.process.sendAndWait({
					type: "prompt",
					message: effectivePrompt,
				});
			} catch (err) {
				unsubscribe();
				yield {
					type: "error",
					error: `Pi rejected prompt: ${err instanceof Error ? err.message : String(err)}`,
					code: "pi_prompt_rejected",
				};
				return;
			}
			this._firstQuerySent = true;

			// Drain queue
			try {
				while (!done || queue.length > 0) {
					if (queue.length > 0) {
						yield queue.shift()!;
					} else {
						await new Promise<void>((r) => {
							resolve = r;
						});
						resolve = null;
					}
				}
			} finally {
				unsubscribe();
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
		if (this.process?.alive) {
			this.process.send({ type: "abort" });
		}
		super.abort();
	}

	/** Kill the subprocess. Called by the provider on dispose. */
	killProcess(): void {
		this.process?.kill();
		this.process = null;
	}
}

// ---------------------------------------------------------------------------
// Event mapping — shared with pi-sdk-node.ts
// ---------------------------------------------------------------------------

import { mapPiEvent } from "./pi-events.ts";
export { mapPiEvent } from "./pi-events.ts";

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

import { registerProviderFactory } from "../provider.ts";

registerProviderFactory(
	PROVIDER_NAME,
	async (config) => new PiSDKProvider(config as PiSDKConfig),
);
