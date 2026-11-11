/**
 * Settings → Accounts → Linear: the key the Linear hover cards use (server `inbox-linear-key.ts`), one row built like
 * Voice's API key row (VoiceSettings.tsx `ApiKey`). A key typed here goes to the Inbox and never comes back: the page
 * holds at most its last 4. `LINEAR_API_KEY` in the Inbox's environment is the fallback, shown when no key is saved.
 * Not drawn for a tailnet guest (the settings answer has no `linear_key` for one).
 */
import { useState, type FormEvent } from 'react';
import type { InboxLinearKeyState } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { Icon } from '../icons';
import { refreshLinearCards } from '../linearCards';

const HINT = 'Shows Linear issues when you hover their links.';

export function LinearKeySettings({ initial, where }: { initial: InboxLinearKeyState; /** The computer that keeps it. */ where: string }) {
  const [key, setKey] = useState(initial);
  const [replacing, setReplacing] = useState(false);
  const [typed, setTyped] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (next: string | null) => {
    setSaving(true);
    setError(null);
    try {
      setKey((await inboxApi.saveLinearKey(next)).key);
      setReplacing(false);
      setTyped('');
      void refreshLinearCards();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The key was not saved.');
    } finally {
      setSaving(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (typed.trim()) void save(typed);
  };

  let row;
  if (key.source === 'env') {
    row = (
      <div className="ib-prow" data-linear-key="env">
        <span className="ib-txt">
          <span className="ib-l">Using LINEAR_API_KEY</span>
          <span className="ib-desc">{HINT} It is set in this Inbox’s environment.</span>
        </span>
      </div>
    );
  } else if (key.source === 'saved' && !replacing) {
    row = (
      <div className="ib-prow" data-linear-key="saved">
        <span className="ib-txt">
          <span className="ib-l">
            <span className="ib-paired">
              <Icon name="check" size={14} />
              Key saved, ending in {key.last4}
            </span>
          </span>
          <span className="ib-desc">{HINT}</span>
        </span>
        <span className="ib-ctl">
          <button type="button" className="ib-btn" onClick={() => setReplacing(true)} data-linear-key-replace="">
            Replace
          </button>
          <button type="button" className="ib-btn ib-ghost" disabled={saving} onClick={() => void save(null)} data-linear-key-remove="">
            Remove
          </button>
        </span>
      </div>
    );
  } else {
    row = (
      <form className="ib-prow ib-vkeyrow" onSubmit={submit} data-linear-key="empty">
        <span className="ib-txt">
          <label className="ib-l" htmlFor="ib-linear-key">
            API key
          </label>
          <span className="ib-desc">
            {HINT} Kept on {where}, never shown again.
          </span>
        </span>
        <span className="ib-ctl ib-vkeyctl">
          <input id="ib-linear-key" className="ib-vkey" type="password" autoComplete="new-password" spellCheck={false} placeholder="lin_api_…" value={typed} onChange={(event) => setTyped(event.target.value)} />
          <button type="submit" className="ib-btn" disabled={saving || !typed.trim()}>
            Save
          </button>
        </span>
      </form>
    );
  }
  return (
    <section className="ib-acct-m" aria-labelledby="ib-acct-linear" data-settings-linear="">
      <h2 className="ib-acct-mh" id="ib-acct-linear">
        Linear
      </h2>
      <div className="ib-acct-linear">{row}</div>
      {error && (
        <div className="ib-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
