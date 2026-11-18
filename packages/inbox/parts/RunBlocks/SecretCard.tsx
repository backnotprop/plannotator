/**
 * A `:::secret` block's card: what the agent asks for and why, where to find it, and the field to save it on the
 * computer that owns the thread. Saved: its name, when, the last 4 characters of a long value, Replace and Remove.
 */
import { useState } from 'react';
import type { ParsedInboxSecret } from '@plannotator/core/inbox-run-blocks';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { runApi, type RunStateWire } from '../../data/runApi';
import { refreshRunState } from '../../data/runStore';
import { clockTime } from '../../format';
import { Icon } from '../../icons';
import { SecretField } from './SecretField';

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** "Stays on your Mac, saved in your Keychain. Claude gets only the name." */
export function secretKeptWords(state: RunStateWire | null, agent: string): string {
  return `Stays on ${state?.computer ?? 'your computer'}, ${state?.store ?? 'saved where only you can read it'}. ${agent} gets only the name.`;
}

export function SecretCard({ messageId, secret, state, agent }: { messageId: string; secret: ParsedInboxSecret; state: RunStateWire | null; agent: string }) {
  const saved = state?.secrets.find((s) => s.name === secret.name) ?? null;
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setError(null);
    try {
      await runApi.removeSecret(messageId, secret.name);
      await refreshRunState(messageId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <section className="ib-run ib-sec" data-secret-card={secret.name} data-secret-state={saved ? 'saved' : 'empty'} aria-label={`Secret ${secret.name}`}>
      <div className="ib-run-head">
        <Icon name="lock" />
        <span className="ib-sec-name">{secret.name}</span>
        {saved && (
          <span className="ib-run-status ib-ok" data-secret-saved="">
            <Icon name="check" />
            Saved
          </span>
        )}
      </div>
      {secret.why && (
        <p className="ib-run-why">
          <InlineMarkdown text={secret.why} />
        </p>
      )}
      {secret.where_url ? (
        <a className="ib-run-link" href={secret.where_url} target="_blank" rel="noopener noreferrer" data-secret-where="">
          {`Find it on ${hostOf(secret.where_url)}`}
          <Icon name="external" />
        </a>
      ) : secret.where ? (
        <p className="ib-run-where" data-secret-where="">
          {`Where to find it: ${secret.where}`}
        </p>
      ) : null}
      {saved && !replacing ? (
        <>
          <p className="ib-run-where" data-secret-detail="">
            {`Saved ${clockTime(saved.saved_at)}${saved.last4 ? ` · ends in ${saved.last4}` : ''} · ${state?.store ?? ''}`}
          </p>
          <div className="ib-run-acts">
            <button type="button" className="ib-btn" onClick={() => setReplacing(true)} data-secret-replace="">
              Replace
            </button>
            <button type="button" className="ib-btn ib-ghost" onClick={() => void remove()} data-secret-remove="">
              Remove
            </button>
          </div>
        </>
      ) : (
        <>
          <SecretField messageId={messageId} name={secret.name} autoFocus={replacing} onDone={() => setReplacing(false)} {...(replacing ? { onCancel: () => setReplacing(false) } : {})} />
          <p className="ib-run-hint">{secretKeptWords(state, agent)}</p>
        </>
      )}
      {error && (
        <p className="ib-sec-err" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
