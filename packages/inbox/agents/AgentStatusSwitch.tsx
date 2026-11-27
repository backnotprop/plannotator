/**
 * The "Agent status" setting's two switches (owner, 2026-11-18: "it can be in the settings panel, but probably also
 * the inbox triple dot drop downs"): this row in Settings → General → Appearance, under Sidebar, and a checkbox in the
 * list's ⋮ menu, under Rows after its four row options (Tidy.tsx `AgentStatusMenuItem`). Both read and write one store
 * (agentStatus.ts), so they never disagree, in this window or any other. Off by default.
 */
import { Switch } from '../components/SoundRow';
import { AGENT_STATUS_DESC, AGENT_STATUS_LABEL, setAgentStatus, useAgentStatusOn } from './agentStatus';

/** Settings → General → Appearance: the row, in the page's own row look. */
export function AgentStatusRow() {
  const on = useAgentStatusOn();
  return (
    <div className="ib-prow" data-settings-agent-status={on ? 'on' : 'off'}>
      <span className="ib-txt">
        <span className="ib-l" id="ib-agent-status-label">
          {AGENT_STATUS_LABEL}
        </span>
        <span className="ib-desc">{AGENT_STATUS_DESC}</span>
      </span>
      <span className="ib-ctl">
        <Switch on={on} labelledBy="ib-agent-status-label" onClick={() => void setAgentStatus(!on)} />
      </span>
    </div>
  );
}
