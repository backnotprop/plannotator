/**
 * A `:::secret` block's card: what the agent asks for and why, where to find it, and the field to save it on the
 * computer that owns the thread. Saved: its name, when and where, Replace and Remove; no part of the value. A name
 * programs read to start (PATH, NODE_OPTIONS…) gets no field: the card says why.
 */
import { useState } from 'react';
import { inboxSecretRefusedWords, type ParsedInboxSecret } from '@plannotator/core/inbox-run-blocks';
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
    <section className="ib-rb ib-sec" data-secret-card={secret.name} data-secret-state={secret.refused ? 'refused' : saved ? 'saved' : 'empty'} aria-label={`Secret ${secret.name}`}>
      <div className="ib-rb-head">
        <Icon name="lock" />
        <span className="ib-sec-name">{secret.name}</span>
        {saved && !secret.refused && (
          <span className="ib-rb-status ib-ok" data-secret-saved="">
            <Icon name="check" />
            Saved
          </span>
        )}
      </div>
      {secret.why && (
        <p className="ib-rb-why">
          <InlineMarkdown text={secret.why} />
        </p>
      )}
      {secret.where_url ? (
        <a className="ib-rb-link" href={secret.where_url} target="_blank" rel="noopener noreferrer" data-secret-where="">
          {`Find it on ${hostOf(secret.where_url)}`}
          <Icon name="external" />
        </a>
      ) : secret.where ? (
        <p className="ib-rb-where" data-secret-where="">
          {`Where to find it: ${secret.where}`}
        </p>
      ) : null}
      {secret.refused ? (
        <p className="ib-rb-warn" data-secret-refused="">
          <Icon name="warn" />
          <span>{`${inboxSecretRefusedWords(secret.name)} Ask ${agent} for another name.`}</span>
        </p>
      ) : saved && !replacing ? (
        <>
          <p className="ib-rb-where" data-secret-detail="">
            {`Saved ${clockTime(saved.saved_at)} · ${state?.store ?? ''}`}
          </p>
          <div className="ib-rb-acts">
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
          <p className="ib-rb-hint">{secretKeptWords(state, agent)}</p>
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
