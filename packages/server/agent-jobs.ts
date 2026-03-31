/**
 * Agent Jobs — Bun server handler.
 *
 * Manages background agent processes (spawn, monitor, kill) and exposes
 * HTTP routes + SSE broadcasting for job status updates.
 *
 * Mirrors packages/server/external-annotations.ts in structure.
 * Server-agnostic: takes a mode, server URL getter, and cwd getter.
 */

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
}

export function createAgentJobHandler(options: AgentJobHandlerOptions): AgentJobHandler {
  const { mode, getServerUrl, getCwd } = options;

  // --- State ---
  const jobs = new Map<string, { info: AgentJobInfo; proc: ReturnType<typeof Bun.spawn> | null }>();
  const subscribers = new Set<ReadableStreamDefaultController>();
  const encoder = new TextEncoder();
  let version = 0;

  // --- Capability detection (run once) ---
  const capabilities: AgentCapability[] = [
    { id: "claude", name: "Claude Code", available: !!Bun.which("claude") },
    { id: "codex", name: "Codex CLI", available: !!Bun.which("codex") },
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

    let proc: ReturnType<typeof Bun.spawn> | null = null;

    try {
      proc = Bun.spawn(command, {
        cwd: getCwd(),
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...process.env,
          PLANNOTATOR_AGENT_SOURCE: source,
          PLANNOTATOR_API_URL: getServerUrl(),
        },
      });

      info.status = "running";
      jobs.set(id, { info, proc });
      broadcast({ type: "job:started", job: { ...info } });

      // Drain stderr continuously to prevent pipe-full deadlock
      let stderrBuf = "";
      if (proc.stderr && typeof proc.stderr !== "number") {
        (async () => {
          try {
            const reader = proc!.stderr as ReadableStream;
            for await (const chunk of reader) {
              const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
              stderrBuf = (stderrBuf + text).slice(-500);
            }
          } catch {
            // Stream closed or already consumed
          }
        })();
      }

      // Monitor process exit
      proc.exited.then((exitCode) => {
        const entry = jobs.get(id);
        if (!entry || isTerminalStatus(entry.info.status)) return;

        entry.info.endedAt = Date.now();
        entry.info.exitCode = exitCode;
        entry.info.status = exitCode === 0 ? "done" : "failed";

        if (exitCode !== 0 && stderrBuf) {
          entry.info.error = stderrBuf;
        }

        broadcast({ type: "job:completed", job: { ...entry.info } });
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
          const provider = typeof body.provider === "string" ? body.provider : "shell";
          const rawCommand = Array.isArray(body.command) ? body.command : [];
          const command = rawCommand.filter((c: unknown): c is string => typeof c === "string");
          const label = typeof body.label === "string" ? body.label : `${provider} agent`;

          // Validate provider is a known, available capability
          const cap = capabilities.find((c) => c.id === provider);
          if (!cap || !cap.available) {
            return Response.json(
              { error: `Unknown or unavailable provider: ${provider}` },
              { status: 400 },
            );
          }

          if (command.length === 0) {
            return Response.json(
              { error: 'Missing "command" array' },
              { status: 400 },
            );
          }

          const job = spawnJob(provider, command, label);
          return Response.json({ job }, { status: 201 });
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
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
