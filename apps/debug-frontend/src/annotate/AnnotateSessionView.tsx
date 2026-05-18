import { apiGroupsForMode, sharedApiGroups } from "../sessions/session-api-groups";
import { ApiGroupList } from "../shared/ui/ApiGroupList";
import { SessionFacts } from "../shared/ui/SessionFacts";
import type { SessionViewComponentProps } from "../sessions/session-view-registry";

export function AnnotateSessionView({ bootstrap }: SessionViewComponentProps) {
  return (
    <section className="session-panel" aria-label="Annotate session">
      <header>
        <p className="eyebrow">Annotate</p>
        <h2>{bootstrap.session.label}</h2>
        <p>
          Skeleton for markdown, folder, last-message, raw HTML, URL annotation, review-gate
          approval, linked docs, image attachments, drafts, and external annotations.
        </p>
      </header>
      <SessionFacts bootstrap={bootstrap} />
      <ApiGroupList groups={[...apiGroupsForMode("annotate"), ...sharedApiGroups()]} />
    </section>
  );
}
