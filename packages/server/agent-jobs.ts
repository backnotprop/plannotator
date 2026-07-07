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
import {
  MARKER_ENGINES,
  formatMarkerLogEvent,
  type MarkerEngine,
  type MarkerEngineId,
  type MarkerModel,
} from "./marker-review";
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
  /** Look up a job by id, or undefined if unknown. */
  getJob: (id: string) => AgentJobInfo | undefined;
  /**
   * Flip a terminal failed/killed job to "done" with the given summary — used
   * when a manual repair (e.g. guide submitManualOutput) succeeds after the
   * automatic job failed, so the job's status reflects the now-valid result
   * instead of staying "failed" forever. Returns false when the job is
   * unknown or not in a terminal failed/killed state.
   */
  completeJobExternally: (id: string, summary: AgentJobInfo["summary"]) => boolean;
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
  "guide",
  "cursor",
  "opencode",
  "pi",
  "copilot",
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
    /** Pi's unified reasoning level (marker engines only). */
    thinking?: string;
    /** PR URL at launch time — used to attribute findings to the correct PR. */
    prUrl?: string;
    /** PR diff scope at launch time — "layer" or "full-stack". */
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
  /**
   * Called after a job process exits with exit code 0.
   * Use for result ingestion (e.g., reading an output file and pushing annotations).
   */
  onJobComplete?: (job: AgentJobInfo, meta: { outputPath?: string; stdout?: string; cwd?: string; changedFilesSnapshot?: string[] }) => void | Promise<void>;
}


/**
 * Best-effort model catalog for a marker engine, spawned once. The spawn lives
 * HERE (per-runtime — Bun.spawn) rather than in marker-review.ts, which must stay
 * Bun-free for the Pi vendor build. ASYNC so it never blocks the event loop on
 * the /capabilities request path (a slow/hanging CLI would otherwise freeze every
 * other in-flight request for up to the timeout). Empty when discovery fails or
 * the CLI is unauthenticated / has no providers configured — the UI falls back to
 * the engine's default picker. Account/config-specific, so never hardcoded.
 */
async function discoverMarkerModels(engine: MarkerEngine): Promise<MarkerModel[]> {
  try {
    const proc = Bun.spawn([engine.binary, ...engine.modelsArgv], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return [];
    return engine.parseModels(stdout);
  } catch {
    return [];
  }
}

export function createAgentJobHandler(options: AgentJobHandlerOptions): AgentJobHandler {
  const { mode, getServerUrl, getCwd } = options;

  // --- State ---
  const jobs = new Map<string, { info: AgentJobInfo; proc: ReturnType<typeof Bun.spawn> | null }>();
  const jobOutputPaths = new Map<string, string>();
  const jobChangedFilesSnapshots = new Map<string, string[]>();
  const subscribers = new Set<ReadableStreamDefaultController>();
  const encoder = new TextEncoder();
  let version = 0;

  // --- Capability detection: binaries are probed once at construction; marker
  // model catalogs are discovered LAZILY (see buildCapabilitiesResponse) so a
  // slow/unauthenticated `<binary> models` spawn never blocks review-server
  // startup — it runs at most once, on the first /capabilities request. ---
  const capabilities: AgentCapability[] = [
    { id: "claude", name: "Claude Code", available: !!Bun.which("claude") },
    { id: "codex", name: "Codex CLI", available: !!Bun.which("codex") },
    { id: "tour", name: "Code Tour", available: !!Bun.which("claude") || !!Bun.which("codex") },
    {
      id: "guide",
      name: "Guided Review",
      // Guided Review also runs on the marker engines (Cursor, OpenCode, Pi) —
      // same review-mode + binary-on-PATH gating as their own capability
      // entries below (NOTE: cursor's binary is `agent`).
      available:
        !!Bun.which("claude") ||
        !!Bun.which("codex") ||
        (mode === "review" && Object.values(MARKER_ENGINES).some((engine) => !!Bun.which(engine.binary))),
    },
  ];
  // Marker engines (Cursor, OpenCode, Pi) — same shape, one loop. Available only
  // in review mode when the binary is on PATH (NOTE: cursor's binary is `agent`).
  for (const engine of Object.values(MARKER_ENGINES)) {
    capabilities.push({
      id: engine.id,
      name: engine.name,
      available: mode === "review" && !!Bun.which(engine.binary),
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
      if (spawnOptions?.changedFilesSnapshot) jobChangedFilesSnapshots.set(id, spawnOptions.changedFilesSnapshot);
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
        const changedFilesSnapshot = jobChangedFilesSnapshots.get(id);
        if (exitCode === 0 && options.onJobComplete) {
          try {
            await options.onJobComplete(entry.info, {
              outputPath,
              stdout: captureStdout ? stdoutBuf : undefined,
              cwd: jobCwd,
              changedFilesSnapshot,
            });
          } catch (err) {
            // Claude/Codex REVIEW jobs stay fail-open by design: annotations
            // may already be partially ingested by the time something throws,
            // and flipping the job to "failed" would hide a review the user
            // can otherwise still see/use. Cursor, OpenCode, and Pi are
            // fail-closed — their findings are prompt-enforced, so an unexpected
            // throw here must surface as a failed job rather than a green one.
            // (Their handlers normally fail by mutation and never throw; this
            // guards future refactors.) Tour and guide widen that fail-closed
            // rule too: both are single-shot, all-or-nothing outputs (a tour's
            // stops/checklist, a guide's sections) with nothing meaningful
            // partially ingested, so an unexpected throw here means the whole
            // result is unusable — it must not sit at "done" with no content.
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
      req: Request,
      url: URL,
      handlerOptions?: { disableIdleTimeout?: () => void },
    ): Promise<Response | null> {
      // --- GET /api/agents/capabilities ---
      if (url.pathname === CAPABILITIES && req.method === "GET") {
        return Response.json(await buildCapabilitiesResponse());
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
              return Response.json(
                { error: `Unknown field(s): ${unknown.join(", ")}` },
                { status: 400 },
              );
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
            return Response.json(
              { error: 'Missing "command" array' },
              { status: 400 },
            );
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
