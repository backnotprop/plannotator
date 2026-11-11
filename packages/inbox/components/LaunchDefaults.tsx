import { useState, type ReactNode } from 'react';
import { inboxApi, type InboxLaunchSettings } from '../api';
import { Row } from './AgentsSettings';
import { FileName } from './FileName';

type Field = 'model' | 'effort' | 'settings_file';

/**
 * Settings → Agents, under Claude Code, while launch is on, per machine (docs/agent-guides/inbox-launch.md):
 *  - Model and Effort: what a new session starts with when New message leaves them on Default (config.json
 *    `inboxLaunch.model`, `.effort`; "Model and effort"). Model takes an alias the CLI lists (suggested) or any full
 *    model name; Effort one of the CLI's levels. Empty: Claude Code's own default, as before.
 *  - Claude settings file: a settings file whose keys every new session gets, such as a gateway's profile
 *    (`inboxLaunch.settingsFile`; "Claude settings file"). Empty: none, as before.
 * Model and the file edit in place (Change, a field, Cancel and Save, as Scratch folders do); Effort is a menu on
 * Model's line. Each row is one line: the value, cut in the middle when long, and a short muted hint.
 */
export function LaunchDefaults({
  launch,
  busy,
  onLaunch,
  onError,
}: {
  launch: InboxLaunchSettings;
  busy: boolean;
  onLaunch: (next: InboxLaunchSettings) => void;
  onError: (text: string | null) => void;
}) {
  const [edit, setEdit] = useState<{ field: Field; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  if (launch.models === undefined || launch.efforts === undefined) return null;
  const save = async (field: Field, value: string | null) => {
    if (saving) return;
    setSaving(true);
    onError(null);
    try {
      onLaunch((await (field === 'settings_file' ? inboxApi.launchSettingsFile(value) : inboxApi.launchDefault(field, value))).launch);
      setEdit(null);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const off = busy || saving;
  /**
   * A row edited in place: its value (or, editing, a field with Cancel and Save), one short muted hint on the same
   * line, and `beside` after the value. Settings has no help popover that also opens on a tap, so the hint stays
   * short and visible; the Change button names it as its description for a screen reader.
   */
  const editable = (field: Field, label: string, shown: ReactNode, current: string, placeholder: string, hint: string, beside?: ReactNode, list?: string[]) => {
    const editing = edit?.field === field ? edit : null;
    const id = `ib-launch-${field}`;
    return (
      <Row
        k={label}
        v={
          <span className="ib-aglv">
            {editing === null ? (
              shown
            ) : (
              <>
                <input
                  className="ib-agpath"
                  type="text"
                  list={list ? `${id}-list` : undefined}
                  aria-label={label}
                  placeholder={placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  value={editing.value}
                  readOnly={off}
                  data-launch-input={field}
                  onChange={(event) => setEdit({ field, value: event.target.value })}
                  // Enter does not save (no new keys in the Inbox): only the Save button does.
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.preventDefault();
                  }}
                />
                {list && (
                  <datalist id={`${id}-list`}>
                    {list.map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                )}
              </>
            )}
            {beside}
            {editing === null && (
              <span className="ib-aghint" id={`${id}-hint`}>
                {hint}
              </span>
            )}
          </span>
        }
        data={{ 'data-launch-row': field }}
        r={
          editing === null ? (
            <button type="button" className="ib-btn ib-sm" aria-describedby={`${id}-hint`} data-launch-change={field} onClick={() => setEdit({ field, value: current })}>
              Change
            </button>
          ) : (
            <>
              <button type="button" className="ib-btn ib-sm ib-ghost" onClick={() => setEdit(null)}>
                Cancel
              </button>
              <button type="button" className="ib-btn ib-sm ib-pri" disabled={off} data-launch-save={field} onClick={() => void save(field, editing.value.trim() || null)}>
                Save
              </button>
            </>
          )
        }
      />
    );
  };
  /** A value cut in the middle when it runs long (FileName: the full value on hover, whole for a screen reader). */
  const value = (field: Field, text: string | undefined, empty: string) =>
    text ? (
      <code className="ib-agval" data-launch-value={field}>
        <FileName name={text} />
      </code>
    ) : (
      <span data-launch-value={field}>{empty}</span>
    );
  return (
    <>
      {editable(
        'model',
        'Model',
        value('model', launch.model ?? undefined, 'Default'),
        launch.model ?? '',
        'Default',
        "New message's Default",
        // Effort shares Model's line, after the value: the label is for a screen reader, the empty choice says which Default it is.
        <select className="ib-agselect" aria-label="Effort" value={launch.effort ?? ''} disabled={off} data-launch-effort="" onChange={(event) => void save('effort', event.target.value || null)}>
          <option value="">Default effort</option>
          {launch.efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>,
        launch.models,
      )}
      {editable(
        'settings_file',
        'Claude settings file',
        value('settings_file', launch.settings_file ? (launch.settings_file_shown ?? launch.settings_file) : undefined, 'None'),
        launch.settings_file ?? '',
        'None',
        'Added to new sessions',
      )}
    </>
  );
}
