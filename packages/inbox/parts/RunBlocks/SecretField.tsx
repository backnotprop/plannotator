/**
 * The field a secret's value is typed or pasted into, and its Save. The value lives in this field only until Save
 * sends it to the computer that keeps it; then the field is emptied. Never stored here, never logged.
 */
import { useId, useState } from 'react';
import { runApi } from '../../data/runApi';
import { refreshRunState } from '../../data/runStore';

export function SecretField({ messageId, name, onDone, onCancel, autoFocus }: { messageId: string; name: string; onDone?: () => void; onCancel?: () => void; autoFocus?: boolean }) {
  const id = useId();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (value === '' || saving) return;
    setSaving(true);
    setError(null);
    try {
      await runApi.saveSecret(messageId, name, value);
      setValue('');
      onDone?.();
      await refreshRunState(messageId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="ib-sec-form"
      data-secret-form={name}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="ib-sr" htmlFor={id}>{`Value of ${name}`}</label>
      <input
        id={id}
        className="ib-sec-input"
        type="password"
        name={name}
        autoComplete="current-password"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Paste the value"
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => setValue(event.target.value)}
        data-secret-input=""
      />
      <button type="submit" className="ib-btn ib-pri" disabled={value === '' || saving} data-secret-save="">
        {saving ? 'Saving…' : 'Save'}
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
    </form>
  );
}
