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

interface UseAgentJobsReturn {
  jobs: AgentJobInfo[];
  capabilities: AgentCapabilities | null;
  launchJob: (params: { provider?: string; command?: string[]; label?: string }) => Promise<AgentJobInfo | null>;
  killJob: (id: string) => Promise<void>;
  killAll: () => Promise<void>;
}

export function useAgentJobs(
  options?: { enabled?: boolean },
): UseAgentJobsReturn {
  const enabled = options?.enabled ?? true;
  const [jobs, setJobs] = useState<AgentJobInfo[]>([]);
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
            setJobs((prev) => [...prev, parsed.job]);
            break;
          case 'job:updated':
          case 'job:completed':
            setJobs((prev) =>
              prev.map((j) => (j.id === parsed.job.id ? parsed.job : j)),
            );
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
    async (params: {
      provider?: string;
      command?: string[];
      label?: string;
    }): Promise<AgentJobInfo | null> => {
      try {
        const res = await fetch(JOBS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.job ?? null;
      } catch {
        return null;
      }
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

  return { jobs, capabilities, launchJob, killJob, killAll };
}
