/**
 * Agent Jobs — Pi (node:http) server handler.
 *
 * Manages background agent processes (spawn, monitor, kill) and exposes
 * HTTP routes + SSE broadcasting for job status updates.
 *
 * Mirrors packages/server/agent-jobs.ts but uses node:http primitives.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, execFileSync, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
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
import {
	MARKER_ENGINES,
	formatMarkerLogEvent,
	type MarkerEngine,
	type MarkerEngineId,
	type MarkerModel,
} from "../generated/marker-review.js";
import { json, parseBody } from "./helpers.js";

// ---------------------------------------------------------------------------
// Route prefixes
// ---------------------------------------------------------------------------

const BASE = "/api/agents";
const JOBS = `${BASE}/jobs`;
const JOBS_STREAM = `${JOBS}/stream`;
const CAPABILITIES = `${BASE}/capabilities`;

// Providers whose command is owned by the server. Client-supplied argv is never
// spawned for these — buildCommand must produce the command or the launch fails.
const SERVER_BUILT_PROVIDERS: ReadonlySet<string> = new Set([
	"claude",
	"codex",
	"tour",
	"guide",
	"cursor",
	"opencode",
	"pi",
	"copilot",
]);

// ---------------------------------------------------------------------------
// which() helper for Node.js
// ---------------------------------------------------------------------------

export function whichCmd(cmd: string): boolean {
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
	/** Build the command server-side for a given provider. */
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
		/** Pi's unified reasoning level (marker engines only). */
		thinking?: string;
		/** PR URL at launch time. */
		prUrl?: string;
		/** PR diff scope at launch time. */
		diffScope?: string;
		/** Diff context snapshot at launch (stored on AgentJobInfo for per-job "Copy All"). */
		diffContext?: AgentJobInfo["diffContext"];
		/** Resolved review profile id at launch time. Stored on AgentJobInfo. */
		reviewProfileId?: string;
		/** Resolved review profile label at launch time. Stored on AgentJobInfo. */
		reviewProfileLabel?: string;
		/** Changed-file paths as of launch time (guide provider only) — stored per
		 *  job so onJobComplete can validate refs against the SAME file set the
		 *  model planned section placement against, not whatever patch is on
		 *  screen when the job happens to finish. */
		changedFilesSnapshot?: string[];
	} | null>;
	/** Called when a job completes successfully — parse results and push annotations. */
	onJobComplete?: (job: AgentJobInfo, meta: { outputPath?: string; stdout?: string; cwd?: string; changedFilesSnapshot?: string[] }) => void | Promise<void>;
}

/**
 * Best-effort model catalog for a marker engine, spawned once. The spawn lives
 * HERE (per-runtime — child_process execFile) rather than in marker-review.ts,
 * which must stay Bun-free for the Pi vendor build. ASYNC so it never blocks the
 * event loop on the /capabilities request path (a slow/hanging CLI would otherwise
 * freeze every other in-flight request for up to the timeout). Empty when discovery
 * fails or the CLI is unauthenticated / has no providers configured — the UI falls
 * back to the engine's default picker. Account/config-specific, so never hardcoded.
 */
async function discoverMarkerModels(engine: MarkerEngine): Promise<MarkerModel[]> {
	try {
		const { stdout } = await execFileAsync(engine.binary, engine.modelsArgv, {
			timeout: 5000,
			encoding: "utf8",
		});
		return engine.parseModels(stdout);
	} catch {
		return [];
	}
}

export function createAgentJobHandler(options: AgentJobHandlerOptions) {
	const { mode, getServerUrl, getCwd } = options;

	// --- State ---
	const jobs = new Map<string, { info: AgentJobInfo; proc: ChildProcess | null }>();
	const jobOutputPaths = new Map<string, string>();
	const jobChangedFilesSnapshots = new Map<string, string[]>();
	const subscribers = new Set<ServerResponse>();
	let version = 0;

	// --- Capability detection (run once) ---
	const capabilities: AgentCapability[] = [
		{ id: "claude", name: "Claude Code", available: whichCmd("claude") },
		{ id: "codex", name: "Codex CLI", available: whichCmd("codex") },
		{ id: "tour", name: "Code Tour", available: whichCmd("claude") || whichCmd("codex") },
		{
			id: "guide",
			name: "Guided Review",
			// Guided Review also runs on the marker engines (Cursor, OpenCode, Pi) —
			// same review-mode + binary-on-PATH gating as their own capability
			// entries below (NOTE: cursor's binary is `agent`).
			available:
				whichCmd("claude") ||
				whichCmd("codex") ||
				(mode === "review" && Object.values(MARKER_ENGINES).some((engine) => whichCmd(engine.binary))),
		},
	];
	// Marker engines (Cursor, OpenCode, Pi) — same shape, one loop. Available
	// only in review mode when the binary is on PATH (NOTE: cursor's binary is `agent`).
	// Model catalogs are discovered LAZILY (see buildCapabilitiesResponse) so a
	// slow/unauthenticated `<binary> models` spawn never blocks startup.
	for (const engine of Object.values(MARKER_ENGINES)) {
		capabilities.push({
			id: engine.id,
			name: engine.name,
			available: mode === "review" && whichCmd(engine.binary),
		});
	}

	const markerModelsCache = new Map<string, MarkerModel[]>();
	async function buildCapabilitiesResponse(): Promise<AgentCapabilities> {
		const providers = await Promise.all(capabilities.map(async (c) => {
			const engine = MARKER_ENGINES[c.id as MarkerEngineId];
			if (!engine || !c.available) return c;
			let models = markerModelsCache.get(engine.id);
			if (!models) {
				models = await discoverMarkerModels(engine);
				markerModelsCache.set(engine.id, models);
			}
			return { ...c, models };
		}));
		return { mode, providers, available: providers.some((p) => p.available) };
	}

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
		id: string,
		provider: string,
		command: string[],
		label: string,
		outputPath?: string,
		spawnOptions?: { captureStdout?: boolean; stdinPrompt?: string; cwd?: string; prompt?: string; engine?: string; model?: string; effort?: string; reasoningEffort?: string; fastMode?: boolean; thinking?: string; prUrl?: string; diffScope?: string; diffContext?: AgentJobInfo["diffContext"]; reviewProfileId?: string; reviewProfileLabel?: string; changedFilesSnapshot?: string[] },
	): AgentJobInfo {
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
			...(spawnOptions?.thinking && { thinking: spawnOptions.thinking }),
			...(spawnOptions?.prUrl && { prUrl: spawnOptions.prUrl }),
			...(spawnOptions?.diffScope && { diffScope: spawnOptions.diffScope }),
			...(spawnOptions?.diffContext && { diffContext: spawnOptions.diffContext }),
			...(spawnOptions?.reviewProfileId && { reviewProfileId: spawnOptions.reviewProfileId }),
			...(spawnOptions?.reviewProfileLabel && { reviewProfileLabel: spawnOptions.reviewProfileLabel }),
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
			if (spawnOptions?.changedFilesSnapshot) jobChangedFilesSnapshots.set(id, spawnOptions.changedFilesSnapshot);
			broadcast({ type: "job:started", job: { ...info } });

			// --- Stdout capture (Claude/Cursor stream-json) ---
			let stdoutBuf = "";
			if (captureStdout && proc.stdout) {
				// Format one complete JSONL line into a live-log delta (skip result
				// events — handled in onJobComplete).
				const emitLogLine = (line: string) => {
					if (!line.trim()) return;
					// Tour jobs with the Claude engine also stream Claude JSONL.
					if (provider === "claude" || spawnOptions?.engine === "claude") {
						const formatted = formatClaudeLogEvent(line);
						if (formatted !== null) broadcast({ type: "job:log", jobId: id, delta: formatted + '\n' });
						return;
					}
					// Marker engines (Cursor, OpenCode, Pi): map their NDJSON stream events
					// into readable log deltas via the engine's own formatter (Cursor
					// applies the partial-output dedup rule; OpenCode reads text parts;
					// Pi reads message_end/tool_execution_start).
					// Guide jobs keep provider: "guide" and carry the marker engine on
					// spawnOptions.engine instead — fall back to that lookup so guide
					// logs get the same readable formatting as review jobs.
					const markerEngine = MARKER_ENGINES[provider as MarkerEngineId]
						?? (spawnOptions?.engine ? MARKER_ENGINES[spawnOptions.engine as MarkerEngineId] : undefined);
					if (markerEngine) {
						const formatted = formatMarkerLogEvent(line, markerEngine);
						if (formatted !== null) broadcast({ type: "job:log", jobId: id, delta: formatted + '\n' });
						return;
					}
					try {
						const event = JSON.parse(line);
						if (event.type === 'result') return;
					} catch { /* not JSON — forward as raw log */ }
					broadcast({ type: "job:log", jobId: id, delta: line + '\n' });
				};
				// stream-json output is NDJSON and chunk boundaries are arbitrary —
				// carry the trailing partial line until a later chunk completes it,
				// otherwise records split across chunks are dropped from live logs.
				let logLineCarry = "";
				proc.stdout.on("data", (chunk: Buffer) => {
					const text = chunk.toString();
					stdoutBuf += text;
					const lines = (logLineCarry + text).split('\n');
					logLineCarry = lines.pop() ?? "";
					for (const line of lines) emitLogLine(line);
				});
				proc.stdout.on("end", () => {
					if (logLineCarry) emitLogLine(logLineCarry);
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
				const changedFilesSnapshot = jobChangedFilesSnapshots.get(id);
				if (exitCode === 0 && options.onJobComplete) {
					try {
						await options.onJobComplete(entry.info, {
							outputPath: jobOutputPath,
							stdout: captureStdout ? stdoutBuf : undefined,
							cwd: jobCwd,
							changedFilesSnapshot,
						});
					} catch (err) {
						// Claude/Codex REVIEW jobs stay fail-open by design: annotations may
						// already be partially ingested by the time something throws, and
						// flipping the job to "failed" would hide a review the user can
						// otherwise still see/use. Cursor, OpenCode, and Pi are fail-closed —
						// an unexpected throw during prompt-enforced ingestion must fail the
						// job, not pass it. (Their handlers normally fail by mutation and
						// never throw; this guards future refactors.) Tour and guide widen
						// that fail-closed rule too: both are single-shot, all-or-nothing
						// outputs with nothing meaningful partially ingested, so an
						// unexpected throw means the whole result is unusable.
						if (MARKER_ENGINES[provider as MarkerEngineId]) {
							entry.info.status = "failed";
							entry.info.error = err instanceof Error ? err.message : `${provider} result ingestion failed`;
						} else if (provider === "tour" || provider === "guide") {
							entry.info.status = "failed";
							entry.info.error = `Result ingestion failed: ${err instanceof Error ? err.message : String(err)}`;
						}
					}
				}
				jobOutputPaths.delete(id);
				jobOutputPaths.delete(`${id}:cwd`);
				jobChangedFilesSnapshots.delete(id);
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
		jobChangedFilesSnapshots.delete(id);
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

	function getJob(id: string): AgentJobInfo | undefined {
		const entry = jobs.get(id);
		return entry ? { ...entry.info } : undefined;
	}

	function completeJobExternally(id: string, summary: AgentJobInfo["summary"]): boolean {
		const entry = jobs.get(id);
		if (!entry) return false;
		if (entry.info.status !== "failed" && entry.info.status !== "killed") return false;

		entry.info.status = "done";
		entry.info.error = undefined;
		entry.info.summary = summary;
		// The FAILED run's exit code would otherwise survive the manual repair —
		// the job detail UI keys its "Exit N" chip off it, so a successfully
		// repaired guide kept flagging Exit 1. The job's OUTCOME is now success;
		// the original process's exit lives on in the captured logs.
		entry.info.exitCode = 0;
		broadcast({ type: "job:completed", job: { ...entry.info } });
		return true;
	}

	// --- HTTP handler ---
	return {
		killAll,
		getJob,
		completeJobExternally,

		async handle(
			req: IncomingMessage,
			res: ServerResponse,
			url: URL,
		): Promise<boolean> {
			// --- GET /api/agents/capabilities ---
			if (url.pathname === CAPABILITIES && req.method === "GET") {
				json(res, await buildCapabilitiesResponse());
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

					// Reject unknown fields rather than silently ignoring them (per the
					// custom-reviews spec — a typo'd field should fail loud, not no-op).
					const KNOWN_JOB_FIELDS = new Set([
						"provider", "command", "label",
						"engine", "model", "reasoningEffort", "effort", "thinking", "fastMode",
						"reviewProfileId", "repairOf",
					]);
					if (body && typeof body === "object") {
						const unknown = Object.keys(body).filter((k) => !KNOWN_JOB_FIELDS.has(k));
						if (unknown.length > 0) {
							json(res, { error: `Unknown field(s): ${unknown.join(", ")}` }, 400);
							return true;
						}
					}

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

					// Fail-closed enforcement for server-owned providers: the command MUST
					// be built server-side. Client-supplied argv is never spawned for these
					// providers — a null/throwing builder becomes an error, not a fallback.
					if (SERVER_BUILT_PROVIDERS.has(provider)) {
						if (!options.buildCommand) {
							json(res, { error: `Provider ${provider} requires server-built command` }, 400);
							return true;
						}
						// Discard any client-supplied argv so a null build cleanly hits the
						// `command.length === 0` guard below instead of falling through.
						command = [];
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
					let jobThinking: string | undefined;
					let jobPrUrl: string | undefined;
					let jobDiffScope: string | undefined;
					let jobDiffContext: AgentJobInfo["diffContext"] | undefined;
					let jobReviewProfileId: string | undefined;
					let jobReviewProfileLabel: string | undefined;
					let jobChangedFilesSnapshot: string[] | undefined;
					const jobId = crypto.randomUUID();
					if (options.buildCommand) {
						// Thread config from POST body to buildCommand
						const config: Record<string, unknown> = {};
						if (typeof body.engine === "string") config.engine = body.engine;
						if (typeof body.model === "string") config.model = body.model;
						if (typeof body.reasoningEffort === "string") config.reasoningEffort = body.reasoningEffort;
						if (typeof body.effort === "string") config.effort = body.effort;
						if (typeof body.thinking === "string") config.thinking = body.thinking;
						if (body.fastMode === true) config.fastMode = true;
						if (typeof body.reviewProfileId === "string") config.reviewProfileId = body.reviewProfileId;
						if (typeof body.repairOf === "string") config.repairOf = body.repairOf;
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
							jobThinking = built.thinking;
							jobPrUrl = built.prUrl;
							jobDiffScope = built.diffScope;
							jobDiffContext = built.diffContext;
							jobReviewProfileId = built.reviewProfileId;
							jobReviewProfileLabel = built.reviewProfileLabel;
							jobChangedFilesSnapshot = built.changedFilesSnapshot;
						}
					}

					if (command.length === 0) {
						json(res, { error: 'Missing "command" array' }, 400);
						return true;
					}

					const job = spawnJob(jobId, provider, command, label, outputPath, {
						captureStdout,
						stdinPrompt,
						cwd: spawnCwd,
						prompt: promptText,
						engine: jobEngine,
						model: jobModel,
						effort: jobEffort,
						reasoningEffort: jobReasoningEffort,
						fastMode: jobFastMode,
						thinking: jobThinking,
						prUrl: jobPrUrl,
						diffScope: jobDiffScope,
						diffContext: jobDiffContext,
						reviewProfileId: jobReviewProfileId,
						reviewProfileLabel: jobReviewProfileLabel,
						changedFilesSnapshot: jobChangedFilesSnapshot,
					});
					json(res, { job }, 201);
				} catch (err) {
					// buildCommand can refuse a launch (e.g. PR checkout unavailable) —
					// surface its message instead of mislabeling it a JSON error.
					if (err instanceof SyntaxError) {
						json(res, { error: "Invalid JSON" }, 400);
					} else {
						json(res, { error: err instanceof Error ? err.message : "Failed to launch agent" }, 503);
					}
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
