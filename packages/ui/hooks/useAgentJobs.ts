/**
 * Real-time agent job state via SSE with polling fallback.
 *
 * Primary transport: EventSource on /api/agents/jobs/stream.
 * Fallback: version-gated GET polling if SSE fails.
 *
 * Mirrors packages/ui/hooks/useExternalAnnotations.ts in structure.
 *
 * Gated by an `enabled` option — callers pass their API-mode signal
 * to avoid SSE/polling in static or demo contexts where there is no server.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AgentJobInfo, AgentJobEvent, AgentCapabilities } from '../types';

const POLL_INTERVAL_MS = 500;
const STREAM_URL = '/api/agents/jobs/stream';
const JOBS_URL = '/api/agents/jobs';
const CAPABILITIES_URL = '/api/agents/capabilities';
const DEFAULT_LAUNCH_ERROR = 'Could not start agent job.';
const AGENT_JOB_STATUSES = new Set(['starting', 'running', 'done', 'failed', 'killed']);

export type AgentLaunchParams = {
  provider?: string;
  command?: string[];
  label?: string;
  engine?: string;
  model?: string;
  reasoningEffort?: string;
  effort?: string;
  /** Pi's unified reasoning level (`--thinking off|minimal|low|medium|high|xhigh`). */
  thinking?: string;
  fastMode?: boolean;
  reviewProfileId?: string;
  /** Launches a guide-repair job against a failed guide job's captured output
   *  (see GuideEmptyState's failure-recovery panel). The server resolves a
   *  schema-capable engine and starts a new, normal guide job rather than
   *  mutating the failed one in place. */
  repairOf?: string;
};

/** Does a job belong to the given review context? Jobs launched against a PR
 *  are stamped with that PR's url; local-diff jobs carry none. Used to scope
 *  guide/tour auto-opens, the guide takeover, and "Open guide" affordances so
 *  an artifact from PR A never opens (or offers to open) while reviewing PR B.
 *  `currentPrUrl` undefined ⇒ local-diff mode.
 *
 *  prUrl + worktreePath define WHERE the review is (the context — matched
 *  strictly below); mode/base/scope define WHAT VIEW of that context is on
 *  screen. In PR mode only prUrl is compared (a PR checkout has no separate
 *  worktree axis). In local-diff mode, `currentWorktreePath` distinguishes a
 *  review retargeted at a git worktree (`worktree:<path>:<subType>` diff
 *  types — see parseWorktreeDiffType) from the main tree, so a guide/tour
 *  launched against worktree A never opens while reviewing worktree B. Jobs
 *  launched before this field existed, and jobs from providers that never set
 *  `diffContext`, coalesce to the main tree (`null`) — deliberate, so old jobs
 *  keep matching the common case instead of going permanently unmatchable.
 *
 *  DELIBERATELY matches by prUrl/worktreePath only — NOT diffScope/mode/base,
 *  even though jobs carry them. Annotations scope by diffScope because they
 *  pin exact line positions in a specific patch; guides/tours reference FILES
 *  and degrade per-file ("no longer in the current diff") when the diff
 *  shifts underneath them. Layer→full-stack is a superset (the artifact
 *  fully resolves — hiding it would be hostile); full-stack→layer and local
 *  base/mode switches degrade honestly. Scope-strict matching here would
 *  vaporize a useful guide because the reviewer toggled since-base →
 *  uncommitted. Do not "tighten" this without a UX decision. */
export function jobMatchesReviewContext(
  job: Pick<AgentJobInfo, 'prUrl' | 'diffContext'>,
  currentPrUrl: string | undefined,
  currentWorktreePath?: string | null,
): boolean {
  if (currentPrUrl) return job.prUrl === currentPrUrl;
  if (job.prUrl) return false;
  return (job.diffContext?.worktreePath ?? null) === (currentWorktreePath ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isAgentJobInfo(value: unknown): value is AgentJobInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.source === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.label === 'string' &&
    typeof value.status === 'string' &&
    AGENT_JOB_STATUSES.has(value.status) &&
    typeof value.startedAt === 'number' &&
    isStringArray(value.command)
  );
}

function upsertJob(jobs: AgentJobInfo[], job: AgentJobInfo): AgentJobInfo[] {
  const existing = jobs.findIndex((current) => current.id === job.id);
  if (existing === -1) return [...jobs, job];
  const next = [...jobs];
  next[existing] = job;
  return next;
}

async function readResponseError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const error = (body as { readonly error?: unknown }).error;
      if (typeof error === 'string' && error.trim()) return error;
    }
  } catch {
    // Fall through to the generic launch message.
  }
  return DEFAULT_LAUNCH_ERROR;
}

function parseLaunchJob(body: unknown): AgentJobInfo | null {
  if (!isRecord(body)) return null;
  const job = body.job;
  return isAgentJobInfo(job) ? job : null;
}

interface UseAgentJobsReturn {
  jobs: AgentJobInfo[];
  jobLogs: Map<string, string>;
  capabilities: AgentCapabilities | null;
  /** Rejects with a user-facing message when the server refuses the launch. */
  launchJob: (params: AgentLaunchParams) => Promise<AgentJobInfo | null>;
  killJob: (id: string) => Promise<void>;
  killAll: () => Promise<void>;
}

export function useAgentJobs(
  options?: { enabled?: boolean },
): UseAgentJobsReturn {
  const enabled = options?.enabled ?? true;
  const [jobs, setJobs] = useState<AgentJobInfo[]>([]);
  const [jobLogs, setJobLogs] = useState<Map<string, string>>(new Map());
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const versionRef = useRef(0);
  const fallbackRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const receivedSnapshotRef = useRef(false);

  // Fetch capabilities once on mount
  useEffect(() => {
    if (!enabled) return;

    fetch(CAPABILITIES_URL)
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.providers)) {
          setCapabilities(data as AgentCapabilities);
        }
      })
      .catch(() => {
        // Silent — capabilities unavailable
      });
  }, [enabled]);

  // SSE + polling for job state
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    receivedSnapshotRef.current = false;
    fallbackRef.current = false;

    // --- SSE primary transport ---
    const es = new EventSource(STREAM_URL);

    es.onmessage = (event) => {
      if (cancelled) return;

      try {
        const parsed: AgentJobEvent = JSON.parse(event.data);

        switch (parsed.type) {
          case 'snapshot':
            receivedSnapshotRef.current = true;
            setJobs(parsed.jobs);
            break;
          case 'job:started':
            setJobs((prev) => upsertJob(prev, parsed.job));
            break;
          case 'job:updated':
          case 'job:completed':
            setJobs((prev) =>
              prev.map((j) => (j.id === parsed.job.id ? parsed.job : j)),
            );
            break;
          case 'job:log':
            setJobLogs((prev) => {
              const next = new Map(prev);
              next.set(parsed.jobId, (prev.get(parsed.jobId) ?? '') + parsed.delta);
              return next;
            });
            break;
          case 'jobs:cleared':
            // No-op: killAll() already broadcasts individual job:completed events
            // for each killed job, so the UI updates incrementally.
            break;
        }
      } catch {
        // Ignore malformed events (e.g., heartbeat comments)
      }
    };

    es.onerror = () => {
      // If we never received a snapshot, SSE isn't working — fall back to polling
      if (!receivedSnapshotRef.current && !fallbackRef.current) {
        fallbackRef.current = true;
        es.close();
        startPolling();
      }
      // Otherwise, EventSource will auto-reconnect and we'll get a fresh snapshot
    };

    // --- Polling fallback ---
    function startPolling() {
      if (cancelled) return;

      fetchSnapshot();

      pollTimerRef.current = setInterval(() => {
        if (cancelled) return;
        fetchSnapshot();
      }, POLL_INTERVAL_MS);
    }

    async function fetchSnapshot() {
      try {
        const url =
          versionRef.current > 0
            ? `${JOBS_URL}?since=${versionRef.current}`
            : JOBS_URL;

        const res = await fetch(url);

        if (res.status === 304) return;
        if (!res.ok) return;

        const data = await res.json();
        if (Array.isArray(data.jobs)) {
          setJobs(data.jobs);
        }
        if (typeof data.version === 'number') {
          versionRef.current = data.version;
        }
      } catch {
        // Silent — next poll will retry
      }
    }

    return () => {
      cancelled = true;
      es.close();
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [enabled]);

  const launchJob = useCallback(
    async (params: AgentLaunchParams): Promise<AgentJobInfo | null> => {
      const res = await fetch(JOBS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        throw new Error(await readResponseError(res));
      }

      const data: unknown = await res.json();
      const job = parseLaunchJob(data);
      if (job) setJobs((prev) => upsertJob(prev, job));
      return job;
    },
    [],
  );

  const killJob = useCallback(async (id: string) => {
    try {
      await fetch(`${JOBS_URL}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    } catch {
      // SSE will reconcile
    }
  }, []);

  const killAll = useCallback(async () => {
    try {
      await fetch(JOBS_URL, { method: 'DELETE' });
    } catch {
      // SSE will reconcile
    }
  }, []);

  return { jobs, jobLogs, capabilities, launchJob, killJob, killAll };
}
