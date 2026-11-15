import { Switch } from '../components/SoundRow';

/**
 * Settings → Capabilities → Routines (CONTRACT.md section 3), after Checklist. Where the Inbox cannot start
 * itself at login (`login: 'unavailable'`), one plain line says so.
 */
export function ScheduledSettingsRow({ value, onToggle }: { value: { on: boolean; login?: 'added' | 'unavailable' }; onToggle: (next: boolean) => void }) {
  return (
    <div className="ib-prow" data-settings-scheduled="">
      <span className="ib-txt">
        <span className="ib-l" id="ib-scheduled-label">
          Routines
        </span>
        <span className="ib-desc">
          Runs saved prompts on a schedule, on this computer, while the Inbox is running.
          {value.on && value.login === 'unavailable' && <> It does not start the Inbox when you log in on this computer.</>}
        </span>
      </span>
      <span className="ib-ctl">
        <Switch on={value.on} labelledBy="ib-scheduled-label" onClick={() => onToggle(!value.on)} />
      </span>
    </div>
  );
}
