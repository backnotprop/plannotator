/**
 * Agent Jobs — Bun server handler.
 *
 * Manages background agent processes (spawn, monitor, kill) and exposes
 * HTTP routes + SSE broadcasting for job status updates.
 *
 * Mirrors packages/server/external-annotations.ts in structure.
 * Server-agnostic: takes a mode, server URL getter, and cwd getter.
 */

import { formatClaudeLogEvent } from "./claude-review";
import { formatCursorLogEvent, parseCursorModelsOutput, type CursorModel } from "./cursor-review";
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
} from "@plannotator/shared/agent-jobs";

export type { AgentJobInfo, AgentJobEvent, AgentCapabilities } from "@plannotator/shared/agent-jobs";

// ---------------------------------------------------------------------------
// Handler interface
// ---------------------------------------------------------------------------

export interface AgentJobHandler {
  handle: (
    req: Request,
    url: URL,
    options?: { disableIdleTimeout?: () => void },
  ) => Promise<Response | null>;
  /** Kill all running jobs — call on server shutdown. */
  killAll: () => void;
}

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
  "cursor",
]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface AgentJobHandlerOptions {
  /** Which server mode this handler is mounted in. */
  mode: "plan" | "review" | "annotate";
  /** Returns the server's base URL (e.g., "http://localhost:12345"). Late-bound. */
  getServerUrl: () => string;
  /** Returns the working directory for spawned processes. */
  getCwd: () => string;
  /**
   * Build the command server-side for a given provider.
   * Return an object with the command to spawn (and optional output path for result ingestion).
   * Return null to reject or fall through to frontend-supplied command.
   */
  buildCommand?: (provider: string, config?: Record<string, unknown>) => Promise<{
    command: string[];
    outputPath?: string;
    captureStdout?: boolean;
    stdinPrompt?: string;
    cwd?: string;
    label?: string;
    /** The full prompt text for display in the detail panel. */
    prompt?: string;
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
    /** PR URL at launch time — used to attribute findings to the correct PR. */
    prUrl?: string;
    /** PR diff scope at launch time — "layer" or "full-stack". */
    diffScope?: string;
    /** Diff context snapshot at launch (stored on AgentJobInfo for per-job "Copy All"). */
    diffContext?: AgentJobInfo["diffContext"];
  } | null>;
  /**
   * Called after a job process exits with exit code 0.
   * Use for result ingestion (e.g., reading an output file and pushing annotations).
   */
  onJobComplete?: (job: AgentJobInfo, meta: { outputPath?: string; stdout?: string; cwd?: string }) => void | Promise<void>;
}


/**
 * Best-effort Cursor model catalog from `agent models`, parsed once and cached.
 * Empty when discovery fails or the CLI is unauthenticated — the UI falls back
 * to an `auto`-only picker. Account-specific, so never hardcoded.
 */
function discoverCursorModels(): CursorModel[] {
  try {
    const res = Bun.spawnSync(["agent", "models"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    });
    if (!res.success) return [];
    return parseCursorModelsOutput(new TextDecoder().decode(res.stdout));
  } catch {
    return [];
  }
}

export function createAgentJobHandler(options: AgentJobHandlerOptions): AgentJobHandler {
  const { mode, getServerUrl, getCwd } = options;

  // --- State ---
  const jobs = new Map<string, { info: AgentJobInfo; proc: ReturnType<typeof Bun.spawn> | null }>();
  const jobOutputPaths = new Map<string, string>();
  const subscribers = new Set<ReadableStreamDefaultController>();
  const encoder = new TextEncoder();
  let version = 0;

  // --- Capability detection (run once) ---
  // Cursor CLI's binary is literally named `agent` (NOT `cursor`). When present,
  // discover its account-specific model catalog so the UI doesn't hardcode ids.
  const cursorAvailable = mode === "review" && !!Bun.which("agent");
  const capabilities: AgentCapability[] = [
    { id: "claude", name: "Claude Code", available: !!Bun.which("claude") },
    { id: "codex", name: "Codex CLI", available: !!Bun.which("codex") },
    { id: "tour", name: "Code Tour", available: !!Bun.which("claude") || !!Bun.which("codex") },
    {
      id: "cursor",
      name: "Cursor CLI",
      available: cursorAvailable,
      ...(cursorAvailable ? { models: discoverCursorModels() } : {}),
    },
  ];
  const capabilitiesResponse: AgentCapabilities = {
    mode,
    providers: capabilities,
    available: capabilities.some((c) => c.available),
  };

  // --- SSE broadcasting ---
  function broadcast(event: AgentJobEvent): void {
    version++;
    const data = encoder.encode(serializeAgentSSEEvent(event));
    for (const controller of subscribers) {
      try {
        controller.enqueue(data);
      } catch {
        subscribers.delete(controller);
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

    let proc: ReturnType<typeof Bun.spawn> | null = null;

    try {
      const spawnCwd = spawnOptions?.cwd ?? getCwd();
      const captureStdout = spawnOptions?.captureStdout ?? false;

      const hasStdinPrompt = !!spawnOptions?.stdinPrompt;

      proc = Bun.spawn(command, {
        cwd: spawnCwd,
        stdin: hasStdinPrompt ? "pipe" : undefined,
        stdout: captureStdout ? "pipe" : "ignore",
        stderr: "pipe",
        env: {
          ...process.env,
          PLANNOTATOR_AGENT_SOURCE: source,
          PLANNOTATOR_API_URL: getServerUrl(),
        },
      });

      // Write prompt to stdin and close (for providers that read prompt from stdin)
      if (hasStdinPrompt && proc.stdin) {
        const sink = proc.stdin as import("bun").FileSink;
        sink.write(spawnOptions!.stdinPrompt!);
        sink.end();
      }

      info.status = "running";
      info.cwd = spawnCwd;
      if (spawnOptions?.prompt) info.prompt = spawnOptions.prompt;
      jobs.set(id, { info, proc });
      if (outputPath) jobOutputPaths.set(id, outputPath);
      if (spawnOptions?.cwd) jobOutputPaths.set(`${id}:cwd`, spawnOptions.cwd);
      broadcast({ type: "job:started", job: { ...info } });

      // Drain stderr: capture tail for error reporting + broadcast live log deltas
      let stderrBuf = "";
      let logPending = "";
      let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

      if (proc.stderr && typeof proc.stderr !== "number") {
        (async () => {
          try {
            const reader = proc!.stderr as unknown as AsyncIterable<Uint8Array>;
            for await (const chunk of reader) {
              const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
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
            }
            // Flush remaining on stream close
            if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
            if (logPending) {
              broadcast({ type: "job:log", jobId: id, delta: logPending });
              logPending = "";
            }
          } catch {
            // Stream closed or already consumed
          }
        })();
      }

      // Drain stdout when capturing (for providers that return results on stdout)
      let stdoutBuf = "";
      const stdoutDone = (captureStdout && proc.stdout && typeof proc.stdout !== "number")
        ? (async () => {
            // Format one complete JSONL line into a live-log delta (skip result
            // events — those are handled in onJobComplete).
            const emitLogLine = (line: string) => {
              if (!line.trim()) return;
              // Claude: format JSONL into readable text. Tour jobs with the
              // Claude engine also stream Claude JSONL, so key off engine too.
              if (provider === "claude" || spawnOptions?.engine === "claude") {
                const formatted = formatClaudeLogEvent(line);
                if (formatted !== null) broadcast({ type: "job:log", jobId: id, delta: formatted + '\n' });
                return;
              }
              // Cursor: map stream-json events (init/assistant/tool_call/result)
              // into readable log deltas, applying the partial-output dedup rule.
              if (provider === "cursor") {
                const formatted = formatCursorLogEvent(line);
                if (formatted !== null) broadcast({ type: "job:log", jobId: id, delta: formatted + '\n' });
                return;
              }
              try {
                const event = JSON.parse(line);
                if (event.type === 'result') return;
              } catch { /* not JSON — forward as raw log */ }
              broadcast({ type: "job:log", jobId: id, delta: line + '\n' });
            };
            try {
              const reader = proc!.stdout as unknown as AsyncIterable<Uint8Array>;
              // stream-json output is NDJSON and chunk boundaries are arbitrary —
              // carry the trailing partial line until a later chunk completes it,
              // otherwise records split across chunks are dropped from live logs.
              let logLineCarry = "";
              for await (const chunk of reader) {
                const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
                stdoutBuf += text;
                const lines = (logLineCarry + text).split('\n');
                logLineCarry = lines.pop() ?? "";
                for (const line of lines) emitLogLine(line);
              }
              if (logLineCarry) emitLogLine(logLineCarry);
            } catch {
              // Stream closed
            }
          })()
        : Promise.resolve();

      // Monitor process exit
      proc.exited.then(async (exitCode) => {
        // Wait for stdout to drain — grace period in case the pipe doesn't close cleanly.
        // The process is dead; if the stream hasn't flushed in 2s, the runtime has a bug.
        await Promise.race([stdoutDone, new Promise(r => setTimeout(r, 2000))]);
        const entry = jobs.get(id);
        if (!entry || isTerminalStatus(entry.info.status)) return;

        entry.info.endedAt = Date.now();
        entry.info.exitCode = exitCode;
        entry.info.status = exitCode === 0 ? "done" : "failed";

        if (exitCode !== 0 && stderrBuf) {
          entry.info.error = stderrBuf;
        }

        // Ingest results before broadcasting completion so annotations arrive first
        const outputPath = jobOutputPaths.get(id);
        const jobCwd = jobOutputPaths.get(`${id}:cwd`);
        if (exitCode === 0 && options.onJobComplete) {
          try {
            await options.onJobComplete(entry.info, {
              outputPath,
              stdout: captureStdout ? stdoutBuf : undefined,
              cwd: jobCwd,
            });
          } catch (err) {
            // Claude/Codex are fail-open: an ingestion error is logged but does
            // not change the terminal state. Cursor is fail-closed — its findings
            // are prompt-enforced, so an unexpected throw here must surface as a
            // failed job rather than a green one. (The Cursor handler normally
            // fails by mutation and never throws; this guards future refactors.)
            if (provider === "cursor") {
              entry.info.status = "failed";
              entry.info.error = err instanceof Error ? err.message : "Cursor result ingestion failed";
            }
          }
        }
        jobOutputPaths.delete(id);
        jobOutputPaths.delete(`${id}:cwd`);

        broadcast({ type: "job:completed", job: { ...entry.info } });
      }).catch(() => {
        // Guard against unhandled rejection from unexpected runtime errors
      });
    } catch (err) {
      // Spawn itself failed (e.g., command not found).
      // Broadcast started (so hook adds the job), then completed (so it updates to failed).
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
      req: Request,
      url: URL,
      handlerOptions?: { disableIdleTimeout?: () => void },
    ): Promise<Response | null> {
      // --- GET /api/agents/capabilities ---
      if (url.pathname === CAPABILITIES && req.method === "GET") {
        return Response.json(capabilitiesResponse);
      }

      // --- SSE stream ---
      if (url.pathname === JOBS_STREAM && req.method === "GET") {
        handlerOptions?.disableIdleTimeout?.();

        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        let ctrl: ReadableStreamDefaultController;

        const stream = new ReadableStream({
          start(controller) {
            ctrl = controller;

            // Send current state as snapshot
            const snapshot: AgentJobEvent = {
              type: "snapshot",
              jobs: getAllJobs(),
            };
            controller.enqueue(encoder.encode(serializeAgentSSEEvent(snapshot)));

            subscribers.add(controller);

            // Heartbeat to keep connection alive
            heartbeatTimer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(AGENT_HEARTBEAT_COMMENT));
              } catch {
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                subscribers.delete(controller);
              }
            }, AGENT_HEARTBEAT_INTERVAL_MS);
          },
          cancel() {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            subscribers.delete(ctrl);
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // --- GET /api/agents/jobs (snapshot / polling fallback) ---
      if (url.pathname === JOBS && req.method === "GET") {
        const since = url.searchParams.get("since");
        if (since !== null) {
          const sinceVersion = parseInt(since, 10);
          if (!isNaN(sinceVersion) && sinceVersion === version) {
            return new Response(null, { status: 304 });
          }
        }
        return Response.json({ jobs: getAllJobs(), version });
      }

      // --- POST /api/agents/jobs (launch) ---
      if (url.pathname === JOBS && req.method === "POST") {
        try {
          const body = await req.json();
          const provider = typeof body.provider === "string" ? body.provider : "";
          let rawCommand = Array.isArray(body.command) ? body.command : [];
          let command = rawCommand.filter((c: unknown): c is string => typeof c === "string");
          let label = typeof body.label === "string" ? body.label : `${provider} agent`;
          let outputPath: string | undefined;

          // Validate provider is a known, available capability
          const cap = capabilities.find((c) => c.id === provider);
          if (!cap || !cap.available) {
            return Response.json(
              { error: `Unknown or unavailable provider: ${provider}` },
              { status: 400 },
            );
          }

          // Fail-closed enforcement for server-owned providers: the command MUST
          // be built server-side. Client-supplied argv is never spawned for these
          // providers — a null/throwing builder becomes an error, not a fallback.
          const isServerBuiltProvider = SERVER_BUILT_PROVIDERS.has(provider);
          if (isServerBuiltProvider) {
            if (!options.buildCommand) {
              return Response.json(
                { error: `Provider ${provider} requires server-built command` },
                { status: 400 },
              );
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
            return Response.json(
              { error: 'Missing "command" array' },
              { status: 400 },
            );
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
          return Response.json({ job }, { status: 201 });
        } catch (err) {
          // buildCommand can refuse a launch (e.g. PR checkout unavailable) —
          // surface its message instead of mislabeling it a JSON error.
          if (err instanceof SyntaxError) {
            return Response.json({ error: "Invalid JSON" }, { status: 400 });
          }
          const message = err instanceof Error ? err.message : "Failed to launch agent";
          return Response.json({ error: message }, { status: 503 });
        }
      }

      // --- DELETE /api/agents/jobs/:id (kill one) ---
      if (url.pathname.startsWith(JOBS + "/") && url.pathname !== JOBS_STREAM && req.method === "DELETE") {
        const id = url.pathname.slice(JOBS.length + 1);
        if (!id) {
          return Response.json({ error: "Missing job ID" }, { status: 400 });
        }
        const found = killJob(id);
        if (!found) {
          return Response.json({ error: "Job not found or already terminal" }, { status: 404 });
        }
        return Response.json({ ok: true });
      }

      // --- DELETE /api/agents/jobs (kill all) ---
      if (url.pathname === JOBS && req.method === "DELETE") {
        const count = killAll();
        return Response.json({ ok: true, killed: count });
      }

      // Not handled
      return null;
    },
  };
}
