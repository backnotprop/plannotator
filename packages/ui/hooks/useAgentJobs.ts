/**
 * Real-time agent job state via the daemon WebSocket hub.
 *
 * Uses the same daemon WebSocket + HTTP polling transport as external annotations.
 *
 * Gated by an `enabled` option — callers pass their API-mode signal
 * to avoid WebSocket/HTTP polling in static or demo contexts where there is no server.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AgentJobInfo, AgentJobEvent, AgentCapabilities, AgentJobLogs } from '../types';
import {
  type DaemonSessionTransportMessage,
  useDaemonSessionTransport,
} from './useDaemonSessionTransport';
import { useSessionFetch } from './useSessionFetch';

const JOBS_URL = '/api/agents/jobs';
const CAPABILITIES_URL = '/api/agents/capabilities';
const FALLBACK_POLL_MS = 2_000;

interface UseAgentJobsReturn {
  jobs: AgentJobInfo[];
  jobLogs: Map<string, string>;
  capabilities: AgentCapabilities | null;
  launchJob: (params: { provider?: string; command?: string[]; label?: string; engine?: string; model?: string; reasoningEffort?: string; effort?: string; fastMode?: boolean }) => Promise<AgentJobInfo | null>;
  killJob: (id: string) => Promise<void>;
  killAll: () => Promise<void>;
}

interface AgentJobsSnapshot {
  jobs: AgentJobInfo[];
  logs?: AgentJobLogs;
  version?: number;
}

function logsToMap(logs: AgentJobLogs | undefined): Map<string, string> {
  if (!logs) return new Map();
  return new Map(
    Object.entries(logs).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export function useAgentJobs(
  options?: { enabled?: boolean },
): UseAgentJobsReturn {
  const fetch = useSessionFetch();
  const enabled = options?.enabled ?? true;
  const [jobs, setJobs] = useState<AgentJobInfo[]>([]);
  const [jobLogs, setJobLogs] = useState<Map<string, string>>(new Map());
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const versionRef = useRef<number | null>(null);

  // Fetch capabilities once on mount
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    fetch(CAPABILITIES_URL)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data && Array.isArray(data.providers)) {
          setCapabilities(data as AgentCapabilities);
        }
      })
      .catch(() => {
        // Silent — capabilities unavailable
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const applyEvent = useCallback((parsed: AgentJobEvent) => {
    switch (parsed.type) {
      case 'snapshot':
        setJobs(parsed.jobs);
        setJobLogs(logsToMap(parsed.logs));
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
  }, []);

  const fetchSnapshot = useCallback(async (): Promise<AgentJobsSnapshot | null> => {
    const version = versionRef.current;
    const url = version === null ? JOBS_URL : `${JOBS_URL}?since=${version}`;
    const res = await fetch(url);
    if (res.status === 304 || !res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.jobs)) return null;
    return data as AgentJobsSnapshot;
  }, []);

  const applySnapshot = useCallback((snapshot: AgentJobsSnapshot) => {
    setJobs(snapshot.jobs);
    setJobLogs(logsToMap(snapshot.logs));
    if (typeof snapshot.version === 'number') versionRef.current = snapshot.version;
  }, []);

  const applyMessage = useCallback((message: DaemonSessionTransportMessage) => {
    const event = message.payload as AgentJobEvent;
    if (event.type === 'snapshot' && typeof event.version === 'number') {
      versionRef.current = event.version;
    }
    applyEvent(event);
  }, [applyEvent]);

  useDaemonSessionTransport({
    enabled,
    family: 'agent-jobs',
    pollMs: FALLBACK_POLL_MS,
    fetchSnapshot,
    applySnapshot,
    applyMessage,
  });

  const launchJob = useCallback(
    async (params: {
      provider?: string;
      command?: string[];
      label?: string;
      engine?: string;
      model?: string;
      reasoningEffort?: string;
      effort?: string;
      fastMode?: boolean;
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
      // Live updates or fallback snapshots will reconcile
    }
  }, []);

  const killAll = useCallback(async () => {
    try {
      await fetch(JOBS_URL, { method: 'DELETE' });
    } catch {
      // Live updates or fallback snapshots will reconcile
    }
  }, []);

  return { jobs, jobLogs, capabilities, launchJob, killJob, killAll };
}
