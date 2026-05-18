import { apiGroupsForMode, sharedApiGroups } from "../sessions/session-api-groups";
import { ApiGroupList } from "../shared/ui/ApiGroupList";
import { SessionFacts } from "../shared/ui/SessionFacts";
import type { SessionViewComponentProps } from "../sessions/session-view-registry";

export function PlanSessionView({ bootstrap }: SessionViewComponentProps) {
  return (
    <section className="session-panel" aria-label="Plan review session">
      <header>
        <p className="eyebrow">Plan review</p>
        <h2>{bootstrap.session.label}</h2>
        <p>
          Skeleton for plan approval, denial, annotations, version history, archive sidebar, linked
          docs, image attachments, and note export.
        </p>
      </header>
      <SessionFacts bootstrap={bootstrap} />
      <ApiGroupList groups={[...apiGroupsForMode("plan"), ...sharedApiGroups()]} />
    </section>
  );
}
