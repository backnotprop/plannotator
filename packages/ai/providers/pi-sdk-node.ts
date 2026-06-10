/**
 * Pi SDK provider — Node.js variant.
 *
 * Identical to pi-sdk.ts except PiProcess uses child_process.spawn()
 * instead of Bun.spawn(). Everything else (PiSDKProvider, PiSDKSession,
 * mapPiEvent) is re-exported from the Bun version unchanged.
 *
 * Used by the Pi extension which runs under jiti (Node.js).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { BaseSession } from "../base-session.ts";
import { buildEffectivePrompt, buildSystemPrompt } from "../context.ts";
import type {
	AIMessage,
	AIProvider,
	AIProviderCapabilities,
	CreateSessionOptions,
	PiSDKConfig,
} from "../types.ts";
import { registerProviderFactory } from "../provider.ts";
import {
	buildWindowsCommandScriptSpawnCommand,
	killWindowsProcessTree,
	resolveWindowsCommandShim,
} from "./command-path.ts";

// Re-export mapPiEvent from shared (runtime-agnostic)
export { mapPiEvent } from "./pi-events.ts";

const PROVIDER_NAME = "pi-sdk";

// ---------------------------------------------------------------------------
// JSONL subprocess wrapper (Node.js)
// ---------------------------------------------------------------------------

type EventListener = (event: Record<string, unknown>) => void;

class PiProcessNode {
	private proc: ChildProcess | null = null;
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
		let proc: ChildProcess;
		try {
			const [file, ...args] = command;
			proc = spawn(file, args, {
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.handleProcessEnd(error);
			throw error;
		}

		this.proc = proc;
		proc.once("exit", () => {
			this.handleProcessEnd(new Error("Pi process exited unexpectedly"));
		});

		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				proc.off("spawn", onSpawn);
				proc.off("error", onError);
			};
			const onSpawn = () => {
				cleanup();
				this._alive = true;
				this.readStream();
				resolve();
			};
			const onError = (err: Error) => {
				cleanup();
				this.handleProcessEnd(err);
				reject(err);
			};

			proc.once("spawn", onSpawn);
			proc.once("error", onError);
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
		for (const listener of this.listeners) {
			listener({ type: "process_exited" });
		}
	}

	private readStream(): void {
		if (!this.proc?.stdout) return;

		this.proc.stdout.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString();
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
		});
	}

	private routeMessage(msg: Record<string, unknown>): void {
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

		for (const listener of this.listeners) {
			listener(msg);
		}
	}

	send(command: Record<string, unknown>): void {
		if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
		this.proc.stdin.write(`${JSON.stringify(command)}\n`);
	}

	sendAndWait(
		command: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const id = `req_${++this.nextId}`;
		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.send({ ...command, id });
		});
	}

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
// Provider (identical to pi-sdk.ts, using PiProcessNode)
// ---------------------------------------------------------------------------

export class PiSDKNodeProvider implements AIProvider {
	readonly name = PROVIDER_NAME;
	readonly capabilities: AIProviderCapabilities = {
		fork: false,
		resume: false,
		streaming: true,
		tools: true,
	};
	models?: Array<{ id: string; label: string; default?: boolean }>;

	private config: PiSDKConfig;
	private sessions = new Map<string, PiSDKNodeSession>();

	constructor(config: PiSDKConfig) {
		this.config = config;
	}

	async createSession(options: CreateSessionOptions): Promise<PiSDKNodeSession> {
		const session = new PiSDKNodeSession({
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

	async fetchModels(): Promise<void> {
		const piPath = this.config.piExecutablePath ?? "pi";
		let proc: PiProcessNode | undefined;
		try {
			proc = new PiProcessNode();
			await proc.spawn(piPath, this.config.cwd ?? process.cwd());
			const data = await Promise.race([
				proc.sendAndWait({ type: "get_available_models" }),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Timeout")), 10_000),
				),
			]);
			const rawModels = (
				data as { models?: Array<{ provider: string; id: string; name?: string }> }
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
// Session (identical to pi-sdk.ts, using PiProcessNode)
// ---------------------------------------------------------------------------

interface SessionConfig {
	systemPrompt: string;
	cwd: string;
	parentSessionId: string | null;
	piExecutablePath: string;
	model?: string;
}

class PiSDKNodeSession extends BaseSession {
	private config: SessionConfig;
	private process: PiProcessNode | null = null;

	constructor(config: SessionConfig) {
		super({ parentSessionId: config.parentSessionId });
		this.config = config;
	}

	async *query(prompt: string): AsyncIterable<AIMessage> {
		const { mapPiEvent } = await import("./pi-events.ts");

		const started = this.startQuery();
		if (!started) {
			yield BaseSession.BUSY_ERROR;
			return;
		}
		const { gen } = started;

		try {
			if (!this.process || !this.process.alive) {
				this.process = new PiProcessNode();
				await this.process.spawn(this.config.piExecutablePath, this.config.cwd);

				if (this.config.model) {
					const [provider, ...rest] = this.config.model.split("/");
					const modelId = rest.join("/");
					if (provider && modelId) {
						try {
							await this.process.sendAndWait({ type: "set_model", provider, modelId });
						} catch { /* Continue with Pi's default model */ }
					}
				}

				try {
					const state = await this.process.sendAndWait({ type: "get_state" });
					if (typeof state.sessionId === "string") {
						this.resolveId(state.sessionId);
					}
				} catch { /* Continue with placeholder ID */ }

				if (!this.process.alive) {
					yield {
						type: "error",
						error: "Pi process exited during startup. Check that Pi is configured correctly (API keys, models).",
						code: "pi_startup_error",
					};
					return;
				}
			}

			const effectivePrompt = buildEffectivePrompt(
				prompt,
				this.config.systemPrompt,
				this._firstQuerySent,
			);

			const queue: AIMessage[] = [];
			let resolve: (() => void) | null = null;
			let done = false;

			const push = (msg: AIMessage) => { queue.push(msg); resolve?.(); };
			const finish = () => { done = true; resolve?.(); };

			const unsubscribe = this.process.onEvent((event) => {
				const mapped = mapPiEvent(event, this.id);
				for (const msg of mapped) {
					push(msg);
					if (
						msg.type === "result" ||
						(msg.type === "error" && (event.type === "agent_end" || event.type === "process_exited"))
					) {
						finish();
					}
				}
			});

			try {
				await this.process.sendAndWait({ type: "prompt", message: effectivePrompt });
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

			try {
				while (!done || queue.length > 0) {
					if (queue.length > 0) {
						yield queue.shift()!;
					} else {
						await new Promise<void>((r) => { resolve = r; });
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

	killProcess(): void {
		this.process?.kill();
		this.process = null;
	}
}

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

registerProviderFactory(
	PROVIDER_NAME,
	async (config) => new PiSDKNodeProvider(config as PiSDKConfig),
);
