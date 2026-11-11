import { useState } from 'react';
import { inboxApi, type InboxLaunchSettings } from '../api';
import { Row } from './AgentsSettings';

/**
 * Settings → Agents, under Claude Code, while launch is on: the Model and Effort a new session starts with when New
 * message leaves them on Default (config.json `inboxLaunch.model`, `.effort`; docs/agent-guides/inbox-launch.md
 * "Model and effort"). Per machine. Model takes an alias the CLI lists (suggested) or any full model name; Effort is
 * one of the levels the CLI lists. Empty: Claude Code's own default, as before.
 */
export function LaunchDefaults({ launch, busy, onLaunch, onError }: { launch: InboxLaunchSettings; busy: boolean; onLaunch: (next: InboxLaunchSettings) => void; onError: (text: string | null) => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (launch.models === undefined || launch.efforts === undefined) return null;
  const save = async (field: 'model' | 'effort', value: string | null) => {
    if (saving) return;
    setSaving(true);
    onError(null);
    try {
      onLaunch((await inboxApi.launchDefault(field, value)).launch);
      if (field === 'model') setEdit(null);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const off = busy || saving;
  return (
    <>
      <Row
        k="Model"
        v={
          edit === null ? (
            launch.model ? <code data-launch-model="">{launch.model}</code> : <span data-launch-model="">Default</span>
          ) : (
            <>
              <input
                className="ib-agpath"
                type="text"
                list="ib-launch-models"
                aria-label="Model"
                placeholder="Default"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={edit}
                readOnly={off}
                data-launch-model-input=""
                onChange={(event) => setEdit(event.target.value)}
                // Enter does not save (no new keys in the Inbox): only the Save button does.
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.preventDefault();
                }}
              />
              <datalist id="ib-launch-models">
                {launch.models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </>
          )
        }
        sub="New Claude Code sessions start with this when New message leaves it on Default. An alias such as opus, or a model's full name."
        data={{ 'data-launch-model-row': '' }}
        r={
          edit === null ? (
            <button type="button" className="ib-btn ib-sm" data-launch-model-change="" onClick={() => setEdit(launch.model ?? '')}>
              Change
            </button>
          ) : (
            <>
              <button type="button" className="ib-btn ib-sm ib-ghost" onClick={() => setEdit(null)}>
                Cancel
              </button>
              <button type="button" className="ib-btn ib-sm ib-pri" disabled={off} data-launch-model-save="" onClick={() => void save('model', edit.trim() || null)}>
                Save
              </button>
            </>
          )
        }
      />
      <Row
        k="Effort"
        data={{ 'data-launch-effort-row': '' }}
        v={
          <select className="ib-agselect" aria-label="Effort" value={launch.effort ?? ''} disabled={off} data-launch-effort="" onChange={(event) => void save('effort', event.target.value || null)}>
            <option value="">Default</option>
            {launch.efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        }
      />
    </>
  );
}
