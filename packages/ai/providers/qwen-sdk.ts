import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { qwenCatalogFromSettings, type CatalogModel } from "@plannotator/core/model-catalog";
import { BaseSession } from "../base-session.ts";
import { buildEffectivePrompt, buildSystemPrompt } from "../context.ts";
import type {
	AIMessage,
	AIProvider,
	AIProviderCapabilities,
	CreateSessionOptions,
	QwenSDKConfig,
} from "../types.ts";
import { registerProviderFactory } from "../provider.ts";
import {
	buildWindowsCommandScriptSpawnCommand,
	killWindowsProcessTree,
	resolveWindowsCommandShim,
} from "./command-path.ts";
import { guardChildStreams, toChildError, writeChildLine } from "./child-io.ts";
import { askAiChildEnv } from "./ask-ai-env.ts";
import { mapQwenLine, newQwenAskAISessionId } from "./qwen-events.ts";

export { mapQwenLine, QWEN_ASK_AI_SESSION_PREFIX } from "./qwen-events.ts";

const PROVIDER_NAME = "qwen-sdk";
const QWEN_PROCESS_LABEL = "Qwen process";
export const QWEN_EXCLUDED_TOOLS = [
	"exit_plan_mode",
	"edit",
	"write_file",
	"notebook_edit",
	"save_memory",
	"manage_memory",
	"enter_worktree",
	"exit_worktree",
] as const;
const QWEN_NO_SAVED_SESSION_TEXT = "No saved session found";
const QWEN_MAX_WALL_TIME = "10m";
const QWEN_WALL_TIME_EXIT = 55;
const STDERR_TAIL_CHARS = 4000;
const PREVIOUS_RUN_GRACE_MS = 5_000;
const EXIT_WITHOUT_CLOSE_MS = 1_000;

export function qwenHomeDir(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
	cwd: string = process.cwd(),
): string {
	const configured = env.QWEN_HOME?.trim();
	if (!configured) return join(home, ".qwen");
	if (configured === "~") return home;
	if (configured.startsWith("~/") || configured.startsWith("~\\")) {
		return join(home, configured.slice(2));
	}
	return resolve(cwd, configured);
}

function stripJsonComments(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

export async function readQwenCatalog(qwenHome: string): Promise<CatalogModel[]> {
	try {
		const text = (await readFile(join(qwenHome, "settings.json"), "utf8")).replace(/^﻿/, "");
		return qwenCatalogFromSettings(JSON.parse(stripJsonComments(text)));
	} catch {
		return [];
	}
}

export function qwenExitError(code: number | null, failure?: Error, stderrTail?: string): string {
	let message: string;
	if (code === QWEN_WALL_TIME_EXIT) {
		message = `Qwen Code stopped the run: it took longer than ${QWEN_MAX_WALL_TIME} (exit code ${QWEN_WALL_TIME_EXIT}).`;
	} else if (failure) {
		message = `Qwen Code could not run: ${failure.message}`;
	} else if (code == null) {
		message = "Qwen Code ended without an answer.";
	} else {
		message = `Qwen Code exited with code ${code} without an answer.`;
	}
	const tail = stderrTail?.trim();
	if (tail) message += ` Stderr: ${tail.slice(-500)}`;
	return message;
}

type LineListener = (line: Record<string, unknown>) => void;
type EndListener = (code: number | null, failure?: Error) => void;

export class QwenProcess {
	private proc: ChildProcess | null = null;
	private buffer = "";
	private stderrTail = "";
	private ended = false;
	private endWaiters: Array<() => void> = [];
	private lineListener: LineListener | null = null;
	private endListener: EndListener | null = null;

	get stderr(): string {
		return this.stderrTail;
	}

	get hasEnded(): boolean {
		return this.ended;
	}

	start(
		qwenPath: string,
		args: string[],
		cwd: string,
		prompt: string,
		onLine: LineListener,
		onEnd: EndListener,
	): void {
		this.lineListener = onLine;
		this.endListener = onEnd;
		const commandPath = resolveWindowsCommandShim(qwenPath);
		const [file, ...rest] =
			buildWindowsCommandScriptSpawnCommand(commandPath, args) ?? [commandPath, ...args];
		let proc: ChildProcess;
		try {
			proc = spawn(file!, rest, {
				cwd,
				env: askAiChildEnv(),
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (err) {
			this.end(null, toChildError(err));
			return;
		}
		this.proc = proc;
		guardChildStreams(proc, QWEN_PROCESS_LABEL, (error) => this.fail(error));
		proc.stdout?.on("data", (chunk: Buffer) => this.readChunk(chunk.toString()));
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
		});
		proc.once("close", (code) => this.end(code));
		proc.once("exit", (code) => {
			setTimeout(() => this.end(code), EXIT_WITHOUT_CLOSE_MS).unref?.();
		});

		const writeError = writeChildLine(proc, prompt, QWEN_PROCESS_LABEL, (error) => this.fail(error));
		if (writeError) {
			this.fail(writeError);
			return;
		}
		try {
			proc.stdin?.end();
		} catch (err) {
			this.fail(toChildError(err));
		}
	}

	private readChunk(text: string): void {
		this.buffer += text;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.emitLine(line);
	}

	private emitLine(raw: string): void {
		const line = raw.replace(/\r$/, "");
		if (!line) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (parsed && typeof parsed === "object") this.lineListener?.(parsed as Record<string, unknown>);
	}

	private fail(error: Error): void {
		this.end(null, error);
		this.kill();
	}

	private end(code: number | null, failure?: Error): void {
		if (this.ended) return;
		this.ended = true;
		if (this.buffer) {
			const tail = this.buffer;
			this.buffer = "";
			this.emitLine(tail);
		}
		const listener = this.endListener;
		this.lineListener = null;
		this.endListener = null;
		listener?.(code, failure);
		for (const wake of this.endWaiters.splice(0)) wake();
	}

	async settle(ms: number, signal?: AbortSignal): Promise<void> {
		if (this.ended || signal?.aborted) return;
		await new Promise<void>((done) => {
			const finish = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", finish);
				done();
			};
			const timer = setTimeout(finish, ms);
			this.endWaiters.push(finish);
			signal?.addEventListener("abort", finish, { once: true });
		});
		if (!this.ended && !signal?.aborted) this.kill();
	}

	kill(): void {
		const proc = this.proc;
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
		try {
			if (!killWindowsProcessTree(proc.pid)) proc.kill();
		} catch {
		}
	}
}

export class QwenSDKProvider implements AIProvider {
	readonly name = PROVIDER_NAME;
	readonly capabilities: AIProviderCapabilities = {
		fork: false,
		resume: true,
		streaming: true,
		tools: true,
	};
	models?: CatalogModel[];

	private config: QwenSDKConfig;
	private sessions = new Map<string, QwenSDKSession>();

	constructor(config: QwenSDKConfig) {
		this.config = config;
	}

	private sessionConfig(cwd: string): Pick<SessionConfig, "cwd" | "qwenExecutablePath"> {
		return { cwd, qwenExecutablePath: this.config.qwenExecutablePath ?? "qwen" };
	}

	async createSession(options: CreateSessionOptions): Promise<QwenSDKSession> {
		const session = new QwenSDKSession({
			...this.sessionConfig(options.cwd ?? this.config.cwd ?? process.cwd()),
			systemPrompt: buildSystemPrompt(options.context),
			model: options.model ?? this.config.model,
			maxTurns: options.maxTurns,
			resume: false,
		});
		this.sessions.set(session.id, session);
		return session;
	}

	async forkSession(): Promise<never> {
		throw new Error(
			"Qwen Code does not support session forking. " +
				"The endpoint layer should fall back to createSession().",
		);
	}

	async resumeSession(sessionId: string): Promise<QwenSDKSession> {
		const session = new QwenSDKSession(
			{
				...this.sessionConfig(this.config.cwd ?? process.cwd()),
				systemPrompt: "",
				model: this.config.model,
				resume: true,
			},
			sessionId,
		);
		this.sessions.set(session.id, session);
		return session;
	}

	dispose(): void {
		for (const session of this.sessions.values()) session.killProcess();
		this.sessions.clear();
	}

	async fetchModels(): Promise<void> {
		const cwd = this.config.cwd ?? process.cwd();
		const models = await readQwenCatalog(qwenHomeDir(process.env, homedir(), cwd));
		if (models.length > 0) this.models = models;
	}
}

interface SessionConfig {
	systemPrompt: string;
	cwd: string;
	qwenExecutablePath: string;
	model?: string;
	maxTurns?: number;
	resume: boolean;
}

class QwenSDKSession extends BaseSession {
	private config: SessionConfig;
	private child: QwenProcess | null = null;
	private qwenSessionId: string;
	private conversationStarted: boolean;

	constructor(config: SessionConfig, initialId?: string) {
		super({ parentSessionId: null, ...(initialId ? { initialId } : {}) });
		this.config = config;
		this.qwenSessionId = config.resume && initialId ? initialId : newQwenAskAISessionId();
		this.conversationStarted = config.resume;
		this._firstQuerySent = config.resume;
	}

	private buildArgs(): string[] {
		const args = [
			this.conversationStarted ? "--resume" : "--session-id",
			this.qwenSessionId,
			"--output-format",
			"stream-json",
			"--include-partial-messages",
			"--approval-mode",
			"plan",
			`--exclude-tools=${QWEN_EXCLUDED_TOOLS.join(",")}`,
			"--max-wall-time",
			QWEN_MAX_WALL_TIME,
		];
		if (this.config.model) args.push("--model", this.config.model);
		if (this.config.maxTurns && this.config.maxTurns > 0) {
			args.push("--max-session-turns", String(this.config.maxTurns));
		}
		return args;
	}

	private async *run(prompt: string, signal: AbortSignal): AsyncGenerator<AIMessage, RunOutcome> {
		const resumed = this.conversationStarted;
		const queue: AIMessage[] = [];
		let wake: (() => void) | null = null;
		let done = false;
		let answered = false;
		let error: AIMessage | null = null;
		let exitCode: number | null = null;
		let startFailed = false;
		const push = (msg: AIMessage) => {
			queue.push(msg);
			wake?.();
		};
		const finish = () => {
			done = true;
			wake?.();
		};

		const child = new QwenProcess();
		this.child = child;
		const onAbort = () => {
			child.kill();
			finish();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		child.start(
			this.config.qwenExecutablePath,
			this.buildArgs(),
			this.config.cwd,
			buildEffectivePrompt(prompt, this.config.systemPrompt, this.conversationStarted),
			(line) => {
				if (line.type === "system") return;
				answered = true;
				for (const msg of mapQwenLine(line, this.id)) {
					push(msg);
					if (msg.type === "result") finish();
				}
			},
			(code, failure) => {
				if (!done && !signal.aborted) {
					exitCode = code;
					startFailed = failure !== undefined;
					error = { type: "error", error: qwenExitError(code, failure, child.stderr), code: "qwen_process_exit" };
				}
				finish();
			},
		);

		try {
			while (!done || queue.length > 0) {
				if (queue.length > 0) {
					yield queue.shift()!;
				} else {
					await new Promise<void>((r) => {
						wake = r;
					});
					wake = null;
				}
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
			if (answered) {
				this.conversationStarted = true;
				this._firstQuerySent = true;
			} else if (!this.conversationStarted) {
				this.qwenSessionId = newQwenAskAISessionId();
			}
		}
		const noSavedSession =
			resumed &&
			!answered &&
			!startFailed &&
			exitCode !== null &&
			exitCode !== 0 &&
			exitCode !== QWEN_WALL_TIME_EXIT &&
			child.stderr.includes(QWEN_NO_SAVED_SESSION_TEXT);
		return { error, noSavedSession };
	}

	async *query(prompt: string): AsyncIterable<AIMessage> {
		const started = this.startQuery();
		if (!started) {
			yield BaseSession.BUSY_ERROR;
			return;
		}
		const { gen, signal } = started;

		try {
			await this.child?.settle(PREVIOUS_RUN_GRACE_MS, signal);
			if (signal.aborted) return;

			let outcome = yield* this.run(prompt, signal);
			if (outcome.noSavedSession && !signal.aborted) {
				this.conversationStarted = false;
				this._firstQuerySent = false;
				this.qwenSessionId = newQwenAskAISessionId();
				outcome = yield* this.run(prompt, signal);
			}
			if (outcome.error) yield outcome.error;
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

	killProcess(): void {
		this.child?.kill();
	}
}

interface RunOutcome {
	error: AIMessage | null;
	noSavedSession: boolean;
}

registerProviderFactory(PROVIDER_NAME, async (config) => new QwenSDKProvider(config as QwenSDKConfig));
