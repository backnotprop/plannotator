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
}

export function createAgentJobHandler(options: AgentJobHandlerOptions) {
	const { mode, getServerUrl, getCwd } = options;

	// --- State ---
	const jobs = new Map<string, { info: AgentJobInfo; proc: ChildProcess | null }>();
	const subscribers = new Set<ServerResponse>();
	let version = 0;

	// --- Capability detection (run once) ---
	const capabilities: AgentCapability[] = [
		{ id: "claude", name: "Claude Code", available: whichCmd("claude") },
		{ id: "codex", name: "Codex CLI", available: whichCmd("codex") },
		{ id: "shell", name: "Shell Command", available: true },
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
		};

		let proc: ChildProcess | null = null;

		try {
			proc = spawn(command[0], command.slice(1), {
				cwd: getCwd(),
				stdio: ["ignore", "ignore", "pipe"],
				env: {
					...process.env,
					PLANNOTATOR_AGENT_SOURCE: source,
					PLANNOTATOR_API_URL: getServerUrl(),
				},
			});

			info.status = "running";
			jobs.set(id, { info, proc });
			broadcast({ type: "job:started", job: { ...info } });

			// Accumulate stderr continuously (must attach before exit fires)
			let stderrBuf = "";
			if (proc.stderr) {
				proc.stderr.on("data", (chunk: Buffer) => {
					stderrBuf = (stderrBuf + chunk.toString()).slice(-500);
				});
			}

			// Monitor process exit
			proc.on("exit", (exitCode) => {
				const entry = jobs.get(id);
				if (!entry || isTerminalStatus(entry.info.status)) return;

				entry.info.endedAt = Date.now();
				entry.info.exitCode = exitCode ?? undefined;
				entry.info.status = exitCode === 0 ? "done" : "failed";

				if (exitCode !== 0 && stderrBuf) {
					entry.info.error = stderrBuf;
				}

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
					const provider = typeof body.provider === "string" ? body.provider : "shell";
					const rawCommand = Array.isArray(body.command) ? body.command : [];
					const command = rawCommand.filter((c: unknown): c is string => typeof c === "string");
					const label = typeof body.label === "string" ? body.label : `${provider} agent`;

					// Validate provider is a known, available capability
					const cap = capabilities.find((c) => c.id === provider);
					if (!cap || !cap.available) {
						json(res, { error: `Unknown or unavailable provider: ${provider}` }, 400);
						return true;
					}

					if (command.length === 0) {
						json(res, { error: 'Missing "command" array' }, 400);
						return true;
					}

					const job = spawnJob(provider, command, label);
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
