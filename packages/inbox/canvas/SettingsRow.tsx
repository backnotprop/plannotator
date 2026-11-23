import { Switch } from '../components/SoundRow';

/**
 * Settings → Capabilities → Canvas (config.json `inboxCanvas`, off by default; docs/agent-guides/inbox-canvas.md),
 * last in the main card. On: the pen in a thread's header and its reply box, and agents' `canvas` action.
 */
export function CanvasSettingsRow({ value, onToggle }: { value: { on: boolean }; onToggle: (next: boolean) => void }) {
  return (
    <div className="ib-prow" data-settings-canvas="">
      <span className="ib-txt">
        <span className="ib-l" id="ib-canvas-label">
          Canvas
        </span>
        <span className="ib-desc">
          A drawing board in every thread that you and your agents can both sketch on. Off, there is no pen and agents are not offered the canvas; every canvas is kept. Agents pick this up in their next session.
        </span>
      </span>
      <span className="ib-ctl">
        <Switch on={value.on} labelledBy="ib-canvas-label" onClick={() => onToggle(!value.on)} />
      </span>
    </div>
  );
}
