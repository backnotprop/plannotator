import { apiGroupsForMode } from "../sessions/session-api-groups";
import { ApiGroupList } from "../shared/ui/ApiGroupList";
import { SessionFacts } from "../shared/ui/SessionFacts";
import type { SessionViewComponentProps } from "../sessions/session-view-registry";

export function SetupGoalSessionView({ bootstrap }: SessionViewComponentProps) {
  return (
    <section className="session-panel" aria-label="Setup-goal session">
      <header>
        <p className="eyebrow">Setup goal</p>
        <h2>{bootstrap.session.label}</h2>
        <p>
          Fixture-backed shell view for future setup-goal interviews, fact sheets, plan generation,
          and Plannotator review gates. The backend contract is planned until the source runtime
          exposes it.
        </p>
      </header>
      <SessionFacts bootstrap={bootstrap} />
      <ApiGroupList groups={apiGroupsForMode("setup-goal")} />
    </section>
  );
}
