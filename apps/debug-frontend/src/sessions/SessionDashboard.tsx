import { useEffect } from "react";
import type { DaemonApiResult } from "../daemon/api/errors";
import { EventLog } from "../debug/EventLog";
import { useDaemonDebugStore } from "../daemon/events/event-store";
import { useDaemonEvents } from "../daemon/events/use-daemon-events";
import { ResultNotice } from "../shared/ui/ResultNotice";
import type { ShellSessionListResponse, ShellSessionSummary } from "./types";

interface SessionDashboardProps {
  result: DaemonApiResult<ShellSessionListResponse>;
  debugStream?: boolean;
}

export function SessionDashboard({ result, debugStream = true }: SessionDashboardProps) {
  const replaceSessions = useDaemonDebugStore((state) => state.replaceSessions);
  const liveSessions = useDaemonDebugStore((state) => state.sessions);
  const status = useDaemonDebugStore((state) => state.status);

  useDaemonEvents(undefined, debugStream);

  useEffect(() => {
    if (result.ok) {
      replaceSessions(result.data.sessions);
    }
  }, [result, replaceSessions]);

  if (!result.ok && liveSessions.length === 0) {
    return (
      <>
        <ResultNotice tone="error" title="Daemon unavailable" error={result.error} />
        <EventLog />
      </>
    );
  }

  const sessions = liveSessions;

  return (
    <>
      <header className="page-heading">
        <div>
          <h2>Sessions</h2>
          {status ? (
            <p className="muted-line">
              pid {status.pid} &middot; {status.endpoint.baseUrl}
            </p>
          ) : null}
        </div>
      </header>

      {sessions.length === 0 ? (
        <div className="notice">
          <p>No active sessions. Start a plan, review, or annotate flow to see it here.</p>
        </div>
      ) : (
        <SessionList sessions={sessions} />
      )}

      <EventLog />
    </>
  );
}

function SessionList({ sessions }: { sessions: ShellSessionSummary[] }) {
  return (
    <ul className="session-list">
      {sessions.map((session) => (
        <li key={session.id} className="session-card">
          <div className="session-card-header">
            <span className={`status-pill status-${session.status}`}>{session.mode}</span>
            <span className="muted-line">{session.project}</span>
            <span className="muted-line">{formatTime(session.updatedAt)}</span>
          </div>
          <strong className="session-card-label">{session.label}</strong>
          <code className="session-card-id">{session.id}</code>
          <a className="session-card-open" href={`/s/${encodeURIComponent(session.id)}`}>
            Open session
          </a>
        </li>
      ))}
    </ul>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
