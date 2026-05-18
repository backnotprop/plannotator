import { apiGroupsForMode } from "../sessions/session-api-groups";
import { ApiGroupList } from "../shared/ui/ApiGroupList";
import { SessionFacts } from "../shared/ui/SessionFacts";
import type { SessionViewComponentProps } from "../sessions/session-view-registry";

export function ArchiveSessionView({ bootstrap }: SessionViewComponentProps) {
  return (
    <section className="session-panel" aria-label="Archive session">
      <header>
        <p className="eyebrow">Archive</p>
        <h2>{bootstrap.session.label}</h2>
        <p>
          Skeleton for browsing saved plan decisions, inspecting approved and denied plans, and
          closing the read-only archive session.
        </p>
      </header>
      <SessionFacts bootstrap={bootstrap} />
      <ApiGroupList groups={apiGroupsForMode("archive")} />
    </section>
  );
}
