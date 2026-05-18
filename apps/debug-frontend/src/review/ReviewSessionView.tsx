import { apiGroupsForMode, sharedApiGroups } from "../sessions/session-api-groups";
import { ApiGroupList } from "../shared/ui/ApiGroupList";
import { SessionFacts } from "../shared/ui/SessionFacts";
import type { SessionViewComponentProps } from "../sessions/session-view-registry";

export function ReviewSessionView({ bootstrap }: SessionViewComponentProps) {
  return (
    <section className="session-panel" aria-label="Code review session">
      <header>
        <p className="eyebrow">Code review</p>
        <h2>{bootstrap.session.label}</h2>
        <p>
          Skeleton for diff browsing, PR switching, AI chat, agent jobs, code navigation, staging,
          platform actions, drafts, and review feedback.
        </p>
      </header>
      <SessionFacts bootstrap={bootstrap} />
      <ApiGroupList groups={[...apiGroupsForMode("review"), ...sharedApiGroups()]} />
    </section>
  );
}
