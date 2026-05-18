import type { SessionApiGroup } from "../../sessions/session-api-groups";

interface ApiGroupListProps {
  groups: SessionApiGroup[];
}

const STATUS_LABELS: Record<SessionApiGroup["status"], string> = {
  planned: "Planned",
  ready: "Ready",
};

export function ApiGroupList({ groups }: ApiGroupListProps) {
  return (
    <section className="api-groups" aria-label="Backend API contract">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Backend contract</p>
          <h2>Session API surface</h2>
        </div>
        <span className="status-pill">{groups.length} groups</span>
      </div>
      <div className="api-group-list">
        {groups.map((group) => (
          <article className="api-group" key={group.id}>
            <div className="api-group-heading">
              <h3>{group.title}</h3>
              <span className={`status-pill status-${group.status}`}>
                {STATUS_LABELS[group.status]}
              </span>
            </div>
            {group.reason ? <p>{group.reason}</p> : null}
            {group.endpoints.length > 0 ? (
              <ul>
                {group.endpoints.slice(0, 8).map((endpoint) => (
                  <li key={`${endpoint.method}:${endpoint.path}`}>
                    <code>{endpoint.method}</code> {endpoint.path}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No endpoint contract in this checkout yet.</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
