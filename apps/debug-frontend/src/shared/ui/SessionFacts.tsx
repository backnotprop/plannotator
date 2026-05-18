import type { ShellSessionBootstrap } from "../../sessions/types";

interface SessionFactsProps {
  bootstrap: ShellSessionBootstrap;
}

export function SessionFacts({ bootstrap }: SessionFactsProps) {
  const { session } = bootstrap;

  return (
    <dl className="session-facts" aria-label="Session facts">
      <div>
        <dt>Session</dt>
        <dd>{session.id}</dd>
      </div>
      <div>
        <dt>Mode</dt>
        <dd>{session.mode}</dd>
      </div>
      <div>
        <dt>Project</dt>
        <dd>{session.project}</dd>
      </div>
      <div>
        <dt>Origin</dt>
        <dd>{session.origin ?? "unknown"}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>{session.status}</dd>
      </div>
      <div>
        <dt>API base</dt>
        <dd>{bootstrap.apiBase}</dd>
      </div>
    </dl>
  );
}
