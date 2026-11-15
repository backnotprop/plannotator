import { useState } from 'react';
import { inboxApi, type InboxLaunchSettings } from '../api';
import { Row } from './AgentsSettings';
import { FileName } from './FileName';

export function LaunchSettingsFile({
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
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A linked machine on an older Inbox has no such setting.
  if (launch.settings_file === undefined) return null;
  const save = async (value: string | null) => {
    if (saving) return;
    setSaving(true);
    onError(null);
    try {
      onLaunch((await inboxApi.launchSettingsFile(value)).launch);
      setEditing(null);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const off = busy || saving;
  const label = 'Claude settings file';
  const id = 'ib-launch-settings_file';
  const shown = launch.settings_file ? (launch.settings_file_shown ?? launch.settings_file) : null;
  return (
    <Row
      k={label}
      v={
        <span className="ib-aglv">
          {editing === null ? (
            shown ? (
              <code className="ib-agval" data-launch-value="settings_file">
                <FileName name={shown} />
              </code>
            ) : (
              <span data-launch-value="settings_file">None</span>
            )
          ) : (
            <input
              className="ib-agpath"
              type="text"
              aria-label={label}
              placeholder="None"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={editing}
              readOnly={off}
              data-launch-input="settings_file"
              onChange={(event) => setEditing(event.target.value)}
              // Enter does not save (no new keys in the Inbox): only the Save button does.
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
            />
          )}
          {editing === null && (
            <span className="ib-aghint" id={`${id}-hint`}>
              Added to new sessions
            </span>
          )}
        </span>
      }
      data={{ 'data-launch-row': 'settings_file' }}
      r={
        editing === null ? (
          <button type="button" className="ib-btn ib-sm" aria-describedby={`${id}-hint`} data-launch-change="settings_file" onClick={() => setEditing(launch.settings_file ?? '')}>
            Change
          </button>
        ) : (
          <>
            <button type="button" className="ib-btn ib-sm ib-ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" className="ib-btn ib-sm ib-pri" disabled={off} data-launch-save="settings_file" onClick={() => void save(editing.trim() || null)}>
              Save
            </button>
          </>
        )
      }
    />
  );
}
