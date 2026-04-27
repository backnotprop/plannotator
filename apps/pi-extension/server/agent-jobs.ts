/**
 * Agent Jobs — Pi (node:http) server handler.
 *
 * Manages background agent processes (spawn, monitor, kill) and exposes
 * HTTP routes + SSE broadcasting for job status updates.
 *
 * Mirrors packages/server/agent-jobs.ts but uses node:http primitives.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
	type AgentJobInfo,
	type AgentJobEvent,
	type AgentCapability,
	type AgentCapabilities,
	isTerminalStatus,
	jobSource,
	serializeAgentSSEEvent,
	AGENT_HEARTBEAT_COMMENT,
	AGENT_HEARTBEAT_INTERVAL_MS,
} from "../generated/agent-jobs.js";
import { formatClaudeLogEvent } from "../generated/claude-review.js";
import { json, parseBody } from "./helpers.js";

// ---------------------------------------------------------------------------
// Route prefixes
// ---------------------------------------------------------------------------

const BASE = "/api/agents";
const JOBS = `${BASE}/jobs`;
const JOBS_STREAM = `${JOBS}/stream`;
const CAPABILITIES = `${BASE}/capabilities`;

// ---------------------------------------------------------------------------
// which() helper for Node.js
// ---------------------------------------------------------------------------

function whichCmd(cmd: string): boolean {
	try {
		const bin = process.platform === "win32" ? "where" : "which";
		execFileSync(bin, [cmd], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface AgentJobHandlerOptions {
	mode: "plan" | "review" | "annotate";
	getServerUrl: () => string;
	getCwd: () => string;
	/** Server-side command builder for known providers (codex, claude, tour). */
	buildCommand?: (provider: string, config?: Record<string, unknown>) => Promise<{
		command: string[];
		outputPath?: string;
		captureStdout?: boolean;
		stdinPrompt?: string;
		cwd?: string;
		prompt?: string;
		label?: string;
		/** Underlying engine used (e.g., "claude" or "codex"). Stored on AgentJobInfo for UI display. */
		engine?: string;
		/** Model used (e.g., "sonnet", "opus"). Stored on AgentJobInfo for UI display. */
		model?: string;
		/** Claude --effort level. */
		effort?: string;
		/** Codex reasoning effort level. */
		reasoningEffort?: string;
		/** Whether Codex fast mode was enabled. */
		fastMode?: boolean;
		/** PR URL at launch time. */
		prUrl?: string;
		/** PR diff scope at launch time. */
		diffScope?: string;
		/** Diff context snapshot at launch (stored on AgentJobInfo for per-job "Copy All"). */
		diffContext?: AgentJobInfo["diffContext"];
	} | null>;
	/** Called when a job completes successfully — parse results and push annotations. */
	onJobComplete?: (job: AgentJobInfo, meta: { outputPath?: string; stdout?: string; cwd?: string }) => void | Promise<void>;
}

export function createAgentJobHandler(options: AgentJobHandlerOptions) {
	const { mode, getServerUrl, getCwd } = options;

	// --- State ---
	const jobs = new Map<string, { info: AgentJobInfo; proc: ChildProcess | null }>();
	const jobOutputPaths = new Map<string, string>();
	const subscribers = new Set<ServerResponse>();
	let version = 0;

	// --- Capability detection (run once) ---
	const capabilities: AgentCapability[] = [
		{ id: "claude", name: "Claude Code", available: whichCmd("claude") },
		{ id: "codex", name: "Codex CLI", available: whichCmd("codex") },
		{ id: "tour", name: "Code Tour", available: whichCmd("claude") || whichCmd("codex") },
	];
	const capabilitiesResponse: AgentCapabilities = {
		mode,
		providers: capabilities,
		available: capabilities.some((c) => c.available),
	};

	// --- SSE broadcasting ---
	function broadcast(event: AgentJobEvent): void {
		version++;
		const data = serializeAgentSSEEvent(event);
		for (const res of subscribers) {
			try {
				res.write(data);
			} catch {
				subscribers.delete(res);
			}
		}
	}

	// --- Process lifecycle ---
	function spawnJob(
		provider: string,
		command: string[],
		label: string,
		outputPath?: string,
		spawnOptions?: { captureStdout?: boolean; stdinPrompt?: string; cwd?: string; prompt?: string; engine?: string; model?: string; effort?: string; reasoningEffort?: string; fastMode?: boolean; prUrl?: string; diffScope?: string; diffContext?: AgentJobInfo["diffContext"] },
	): AgentJobInfo {
		const id = crypto.randomUUID();
		const source = jobSource(id);

		const info: AgentJobInfo = {
			id,
			source,
			provider,
			label,
			status: "starting",
			startedAt: Date.now(),
			command,
			cwd: getCwd(),
			...(spawnOptions?.engine && { engine: spawnOptions.engine }),
			...(spawnOptions?.model && { model: spawnOptions.model }),
			...(spawnOptions?.effort && { effort: spawnOptions.effort }),
			...(spawnOptions?.reasoningEffort && { reasoningEffort: spawnOptions.reasoningEffort }),
			...(spawnOptions?.fastMode && { fastMode: spawnOptions.fastMode }),
			...(spawnOptions?.prUrl && { prUrl: spawnOptions.prUrl }),
			...(spawnOptions?.diffScope && { diffScope: spawnOptions.diffScope }),
			...(spawnOptions?.diffContext && { diffContext: spawnOptions.diffContext }),
		};

		let proc: ChildProcess | null = null;

		try {
			const spawnCwd = spawnOptions?.cwd ?? getCwd();
			const captureStdout = spawnOptions?.captureStdout ?? false;
			const hasStdinPrompt = !!spawnOptions?.stdinPrompt;

			proc = spawn(command[0], command.slice(1), {
				cwd: spawnCwd,
				stdio: [
					hasStdinPrompt ? "pipe" : "ignore",
					captureStdout ? "pipe" : "ignore",
					"pipe",
				],
				env: {
					...process.env,
					PLANNOTATOR_AGENT_SOURCE: source,
					PLANNOTATOR_API_URL: getServerUrl(),
				},
			});

			// Write prompt to stdin and close (for providers that read prompt from stdin)
			if (hasStdinPrompt && proc.stdin) {
				proc.stdin.write(spawnOptions!.stdinPrompt!);
				proc.stdin.end();
			}

			info.status = "running";
			info.cwd = spawnCwd;
			if (spawnOptions?.prompt) info.prompt = spawnOptions.prompt;
			jobs.set(id, { info, proc });
			if (outputPath) jobOutputPaths.set(id, outputPath);
			if (spawnOptions?.cwd) jobOutputPaths.set(`${id}:cwd`, spawnOptions.cwd);
			broadcast({ type: "job:started", job: { ...info } });

			// --- Stdout capture (Claude JSONL streaming) ---
			let stdoutBuf = "";
			if (captureStdout && proc.stdout) {
				proc.stdout.on("data", (chunk: Buffer) => {
					const text = chunk.toString();
					stdoutBuf += text;

					// Forward JSONL lines as log events
					const lines = text.split('\n');
					for (const line of lines) {
						if (!line.trim()) continue;
						// Tour jobs with the Claude engine also stream Claude JSONL.
						if (provider === "claude" || spawnOptions?.engine === "claude") {
							const formatted = formatClaudeLogEvent(line);
							if (formatted !== null) {
								broadcast({ type: "job:log", jobId: id, delta: formatted + '\n' });
							}
							continue;
						}
						try {
							const event = JSON.parse(line);
							if (event.type === 'result') continue;
						} catch { /* not JSON — forward as raw log */ }
						broadcast({ type: "job:log", jobId: id, delta: line + '\n' });
					}
				});
			}

			// --- Stderr: buffer tail for errors + live log streaming ---
			let stderrBuf = "";
			let logPending = "";
			let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

			if (proc.stderr) {
				proc.stderr.on("data", (chunk: Buffer) => {
					const text = chunk.toString();
					stderrBuf = (stderrBuf + text).slice(-500);
					logPending += text;

					if (!logFlushTimer) {
						logFlushTimer = setTimeout(() => {
							if (logPending) {
								broadcast({ type: "job:log", jobId: id, delta: logPending });
								logPending = "";
							}
							logFlushTimer = null;
						}, 200);
					}
				});
			}

			// Monitor process close (fires after stdio streams are fully drained,
			// unlike 'exit' which fires before — critical for stdout capture)
			proc.on("close", async (exitCode) => {
				// Flush remaining stderr
				if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
				if (logPending) {
					broadcast({ type: "job:log", jobId: id, delta: logPending });
					logPending = "";
				}

				const entry = jobs.get(id);
				if (!entry || isTerminalStatus(entry.info.status)) return;

				entry.info.endedAt = Date.now();
				entry.info.exitCode = exitCode ?? undefined;
				entry.info.status = exitCode === 0 ? "done" : "failed";

				if (exitCode !== 0 && stderrBuf) {
					entry.info.error = stderrBuf;
				}

				// Ingest results before broadcasting completion
				const jobOutputPath = jobOutputPaths.get(id);
				const jobCwd = jobOutputPaths.get(`${id}:cwd`);
				if (exitCode === 0 && options.onJobComplete) {
					try {
						await options.onJobComplete(entry.info, {
							outputPath: jobOutputPath,
							stdout: captureStdout ? stdoutBuf : undefined,
							cwd: jobCwd,
						});
					} catch {
						// Result ingestion failure shouldn't prevent job completion broadcast
					}
				}
				jobOutputPaths.delete(id);
				jobOutputPaths.delete(`${id}:cwd`);

				broadcast({ type: "job:completed", job: { ...entry.info } });
			});

			// Handle spawn errors after process starts
			proc.on("error", (err) => {
				const entry = jobs.get(id);
				if (!entry || isTerminalStatus(entry.info.status)) return;

				entry.info.status = "failed";
				entry.info.endedAt = Date.now();
				entry.info.error = err.message;
				broadcast({ type: "job:completed", job: { ...entry.info } });
			});
		} catch (err) {
			jobs.set(id, { info, proc: null });
			broadcast({ type: "job:started", job: { ...info } });

			info.status = "failed";
			info.endedAt = Date.now();
			info.error = err instanceof Error ? err.message : String(err);
			broadcast({ type: "job:completed", job: { ...info } });
		}

		return { ...info };
	}

	function killJob(id: string): boolean {
		const entry = jobs.get(id);
		if (!entry || isTerminalStatus(entry.info.status)) return false;

		if (entry.proc) {
			try {
				entry.proc.kill();
			} catch {
				// Process may have already exited
			}
		}

		entry.info.status = "killed";
		entry.info.endedAt = Date.now();
		jobOutputPaths.delete(id);
		jobOutputPaths.delete(`${id}:cwd`);
		broadcast({ type: "job:completed", job: { ...entry.info } });
		return true;
	}

	function killAll(): number {
		let count = 0;
		for (const [id, entry] of jobs) {
			if (!isTerminalStatus(entry.info.status)) {
				killJob(id);
				count++;
			}
		}
		return count;
	}

	function getAllJobs(): AgentJobInfo[] {
		return Array.from(jobs.values()).map((e) => ({ ...e.info }));
	}

	// --- HTTP handler ---
	return {
		killAll,

		async handle(
			req: IncomingMessage,
			res: ServerResponse,
			url: URL,
		): Promise<boolean> {
			// --- GET /api/agents/capabilities ---
			if (url.pathname === CAPABILITIES && req.method === "GET") {
				json(res, capabilitiesResponse);
				return true;
			}

			// --- SSE stream ---
			if (url.pathname === JOBS_STREAM && req.method === "GET") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});

				res.setTimeout(0);

				// Send current state as snapshot
				const snapshot: AgentJobEvent = {
					type: "snapshot",
					jobs: getAllJobs(),
				};
				res.write(serializeAgentSSEEvent(snapshot));

				subscribers.add(res);

				// Heartbeat to keep connection alive
				const heartbeatTimer = setInterval(() => {
					try {
						res.write(AGENT_HEARTBEAT_COMMENT);
					} catch {
						clearInterval(heartbeatTimer);
						subscribers.delete(res);
					}
				}, AGENT_HEARTBEAT_INTERVAL_MS);

				// Clean up on disconnect
				res.on("close", () => {
					clearInterval(heartbeatTimer);
					subscribers.delete(res);
				});

				return true;
			}

			// --- GET /api/agents/jobs (snapshot / polling fallback) ---
			if (url.pathname === JOBS && req.method === "GET") {
				const since = url.searchParams.get("since");
				if (since !== null) {
					const sinceVersion = parseInt(since, 10);
					if (!isNaN(sinceVersion) && sinceVersion === version) {
						res.writeHead(304);
						res.end();
						return true;
					}
				}
				json(res, { jobs: getAllJobs(), version });
				return true;
			}

			// --- POST /api/agents/jobs (launch) ---
			if (url.pathname === JOBS && req.method === "POST") {
				try {
					const body = await parseBody(req);
					const provider = typeof body.provider === "string" ? body.provider : "";
					let rawCommand = Array.isArray(body.command) ? body.command : [];
					let command = rawCommand.filter((c: unknown): c is string => typeof c === "string");
					let label = typeof body.label === "string" ? body.label : `${provider} agent`;
					let outputPath: string | undefined;

					// Validate provider is a known, available capability
					const cap = capabilities.find((c) => c.id === provider);
					if (!cap || !cap.available) {
						json(res, { error: `Unknown or unavailable provider: ${provider}` }, 400);
						return true;
					}

					// Try server-side command building for known providers
					let captureStdout = false;
					let stdinPrompt: string | undefined;
					let spawnCwd: string | undefined;
					let promptText: string | undefined;
					let jobEngine: string | undefined;
					let jobModel: string | undefined;
					let jobEffort: string | undefined;
					let jobReasoningEffort: string | undefined;
					let jobFastMode: boolean | undefined;
					let jobPrUrl: string | undefined;
					let jobDiffScope: string | undefined;
					let jobDiffContext: AgentJobInfo["diffContext"] | undefined;
					if (options.buildCommand) {
						// Thread config from POST body to buildCommand
						const config: Record<string, unknown> = {};
						if (typeof body.engine === "string") config.engine = body.engine;
						if (typeof body.model === "string") config.model = body.model;
						if (typeof body.reasoningEffort === "string") config.reasoningEffort = body.reasoningEffort;
						if (typeof body.effort === "string") config.effort = body.effort;
						if (body.fastMode === true) config.fastMode = true;
						const built = await options.buildCommand(provider, Object.keys(config).length > 0 ? config : undefined);
						if (built) {
							command = built.command;
							outputPath = built.outputPath;
							captureStdout = built.captureStdout ?? false;
							stdinPrompt = built.stdinPrompt;
							spawnCwd = built.cwd;
							promptText = built.prompt;
							if (built.label) label = built.label;
							jobEngine = built.engine;
							jobModel = built.model;
							jobEffort = built.effort;
							jobReasoningEffort = built.reasoningEffort;
							jobFastMode = built.fastMode;
							jobPrUrl = built.prUrl;
							jobDiffScope = built.diffScope;
							jobDiffContext = built.diffContext;
						}
					}

					if (command.length === 0) {
						json(res, { error: 'Missing "command" array' }, 400);
						return true;
					}

					const job = spawnJob(provider, command, label, outputPath, {
						captureStdout,
						stdinPrompt,
						cwd: spawnCwd,
						prompt: promptText,
						engine: jobEngine,
						model: jobModel,
						effort: jobEffort,
						reasoningEffort: jobReasoningEffort,
						fastMode: jobFastMode,
						prUrl: jobPrUrl,
						diffScope: jobDiffScope,
						diffContext: jobDiffContext,
					});
					json(res, { job }, 201);
				} catch {
					json(res, { error: "Invalid JSON" }, 400);
				}
				return true;
			}

			// --- DELETE /api/agents/jobs/:id (kill one) ---
			if (url.pathname.startsWith(JOBS + "/") && url.pathname !== JOBS_STREAM && req.method === "DELETE") {
				const id = url.pathname.slice(JOBS.length + 1);
				if (!id) {
					json(res, { error: "Missing job ID" }, 400);
					return true;
				}
				const found = killJob(id);
				if (!found) {
					json(res, { error: "Job not found or already terminal" }, 404);
					return true;
				}
				json(res, { ok: true });
				return true;
			}

			// --- DELETE /api/agents/jobs (kill all) ---
			if (url.pathname === JOBS && req.method === "DELETE") {
				const count = killAll();
				json(res, { ok: true, killed: count });
				return true;
			}

			// Not handled
			return false;
		},
	};
}
