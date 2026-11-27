/**
 * A `:::secret` block's card: what the agent asks for and why, where to find it, and the field to save it on the
 * computer that owns the thread. Saved: its name, when and where, Replace and Remove; no part of the value. A name
 * programs read to start (PATH, NODE_OPTIONS…) gets no field: the card says why.
 */
import { useEffect, useRef, useState } from 'react';
import { inboxSecretRefusedWords, type ParsedInboxSecret } from '@plannotator/core/inbox-run-blocks';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { runApi, type RunStateWire } from '../../data/runApi';
import { refreshAllRunStates } from '../../data/runStore';
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

/** What Save does, under every secret field: "Saved to your Mac's Keychain. Claude never sees it." */
export function secretKeptWords(state: RunStateWire | null, agent: string): string {
  // An older Inbox (a linked machine not yet updated) sends no `kept`: its store words still say where.
  const kept = state?.kept ?? (state ? `Saved ${state.store}.` : 'Saved where only you can read it.');
  return `${kept} ${agent} never sees it.`;
}

export function SecretCard({ messageId, secret, state, agent, cardRef }: { messageId: string; secret: ParsedInboxSecret; state: RunStateWire | null; agent: string; cardRef?: (element: Element | null) => (() => void) | undefined }) {
  const saved = state?.secrets.find((s) => s.name === secret.name) ?? null;
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After Save the field goes: focus moves to Replace, the control that takes its place.
  const replaceRef = useRef<HTMLButtonElement>(null);
  const focusReplace = useRef(false);
  useEffect(() => {
    if (saved && !replacing && focusReplace.current) {
      focusReplace.current = false;
      replaceRef.current?.focus();
    }
  }, [saved, replacing]);
  const remove = async () => {
    setError(null);
    try {
      await refreshAllRunStates(() => runApi.removeSecret(messageId, secret.name));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <section ref={cardRef} className="ib-rb ib-sec" data-secret-card={secret.name} data-secret-state={secret.refused ? 'refused' : saved ? 'saved' : 'empty'} aria-label={`Secret ${secret.name}`}>
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
            {/* The head already says Saved: when, and where. */}
            {`${clockTime(saved.saved_at)} · ${state?.store ?? ''}`}
          </p>
          <div className="ib-rb-acts">
            <button ref={replaceRef} type="button" className="ib-btn" onClick={() => setReplacing(true)} data-secret-replace="">
              Replace
            </button>
            <button type="button" className="ib-btn ib-ghost" onClick={() => void remove()} data-secret-remove="">
              Remove
            </button>
          </div>
        </>
      ) : (
        <>
          <SecretField messageId={messageId} name={secret.name} autoFocus={replacing} onDone={() => {
              focusReplace.current = true;
              setReplacing(false);
            }} {...(replacing ? { onCancel: () => setReplacing(false) } : {})} />
          <p className="ib-rb-hint" data-secret-kept="">{secretKeptWords(state, agent)}</p>
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
