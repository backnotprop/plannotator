/**
 * The field a secret's value is typed or pasted into, and its Save. The value lives in this field only until Save
 * sends it to the computer that keeps it; then the field is emptied. Never stored here, never logged.
 *
 * Not a sign-in form: no `<form>`, no `name`, `autocomplete="off"` and the password managers' own "ignore" marks,
 * so the browser does not offer to save the value as this site's password (and sync it) after Save. The field
 * stays a password field, so a manager the person calls on can still fill it.
 */
import { useId, useState } from 'react';
import { runApi } from '../../data/runApi';
import { refreshAllRunStates } from '../../data/runStore';

export function SecretField({ messageId, name, onDone, onCancel, autoFocus, saveLabel = 'Save' }: { messageId: string; name: string; onDone?: () => void; onCancel?: () => void; autoFocus?: boolean; saveLabel?: string }) {
  const id = useId();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (value === '' || saving) return;
    setSaving(true);
    setError(null);
    try {
      // Every card that waits for this name (here, in other messages of the thread) sees it saved at once.
      await refreshAllRunStates(async () => {
        await runApi.saveSecret(messageId, name, value);
        setValue('');
        onDone?.();
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="ib-sec-form" data-secret-form={name}>
      <label className="ib-sr" htmlFor={id}>{`Value of ${name}`}</label>
      <input
        id={id}
        className="ib-sec-input"
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        data-bwignore=""
        data-form-type="other"
        placeholder="Paste the value"
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void save();
          }
        }}
        data-secret-input=""
      />
      <button type="button" className="ib-btn ib-pri" disabled={value === '' || saving} onClick={() => void save()} data-secret-save="">
        {saving ? 'Saving…' : saveLabel}
      </button>
      {onCancel && (
        <button type="button" className="ib-btn ib-ghost" onClick={onCancel} data-secret-cancel="">
          Cancel
        </button>
      )}
      {error && (
        <p className="ib-sec-err" role="alert" data-secret-error="">
          {error}
        </p>
      )}
    </div>
  );
}
