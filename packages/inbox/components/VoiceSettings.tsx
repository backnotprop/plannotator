/**
 * Settings → Voice. Off shows the switch and the plain line about the route, and starts nothing. On asks the Inbox
 * about this computer (`account/read` through a short-lived Codex: the sign-in type and plan, never a token).
 *
 * A key typed here goes to the Inbox and never comes back: the page holds at most its last 4. The owner sets it on the
 * computer or over the tailnet's HTTPS; a tailnet guest never gets this far (the note in `VoiceSettings`).
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { InboxVoiceEngine, InboxVoiceStatus } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { Icon } from '../icons';
import { adoptVoiceSettings, checkVoiceStatus, useVoiceSettings, useVoiceStatus, voiceWhere } from '../voice';

function Toggle({ on, labelledBy, onClick }: { on: boolean; labelledBy: string; onClick: () => void }) {
  return <button type="button" role="switch" className="ib-sw" aria-checked={on} aria-labelledby={labelledBy} onClick={onClick} />;
}

const ROUTE_LINE = 'Your audio goes to OpenAI through your ChatGPT login in Codex. This route isn’t an official OpenAI API, so it can stop working without notice.';
const TERMS_LINE = 'OpenAI’s terms for your ChatGPT account apply.';

const planName = (plan: string | null) => (plan ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan, through` : 'Through');

function CodexStatus({ where, status, checking }: { where: string; status: InboxVoiceStatus | null; checking: boolean }) {
  const line = (): { label: ReactNode; desc: ReactNode; ok?: boolean } => {
    if (checking || !status) return { label: 'Checking Codex', desc: `Asking Codex on ${where} who is signed in.` };
    switch (status.state) {
      case 'ready':
        return { ok: true, label: 'Signed in with ChatGPT', desc: `${planName(status.plan)} Codex on ${where}.` };
      case 'missing':
        return { label: 'Codex isn’t installed', desc: `Install Codex on ${where}, then check again. Or use an OpenAI API key.` };
      case 'signedout':
        return {
          label: 'Codex isn’t signed in',
          desc: (
            <>
              Run <code>codex login</code> on {where} and choose ChatGPT, then check again.
            </>
          ),
        };
      case 'apikey':
        return {
          label: 'Codex is using an API key',
          desc: (
            <>
              Voice through Codex needs a ChatGPT login. <code>codex login</code> changes the login Codex itself uses, so you may prefer an OpenAI API key here.
            </>
          ),
        };
      case 'other':
        return { label: 'Codex is signed in another way', desc: 'Voice through Codex needs a ChatGPT login. Or use an OpenAI API key.' };
      default:
        return { label: 'Codex didn’t answer', desc: `Check again, or see that Codex runs on ${where}. Or use an OpenAI API key.` };
    }
  };
  const state = line();
  return (
    <div className="ib-prow" data-voice-status={checking || !status ? 'checking' : status.state}>
      <span className="ib-txt">
        <span className="ib-l">
          {state.ok ? (
            <span className="ib-paired">
              <Icon name="check" size={14} />
              {state.label}
            </span>
          ) : (
            state.label
          )}
        </span>
        <span className="ib-desc">{state.desc}</span>
      </span>
      <span className="ib-ctl">
        {checking ? (
          <span className="ib-spin" />
        ) : (
          <button type="button" className="ib-btn" onClick={() => void checkVoiceStatus(true)} data-voice-check="">
            Check again
          </button>
        )}
      </span>
    </div>
  );
}

function ApiKey({ onError }: { onError: (message: string | null) => void }) {
  const voice = useVoiceSettings();
  const [replacing, setReplacing] = useState(false);
  const [typed, setTyped] = useState('');
  const [saving, setSaving] = useState(false);
  const key = voice?.key;
  const save = async (next: string | null) => {
    if (!voice) return;
    setSaving(true);
    onError(null);
    try {
      const saved = await inboxApi.saveVoiceKey(next);
      adoptVoiceSettings({ ...voice, key: saved.key });
      setReplacing(false);
      setTyped('');
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'The key was not saved.');
    } finally {
      setSaving(false);
    }
  };
  if (key?.source === 'env')
    return (
      <div className="ib-prow" data-voice-key="env">
        <span className="ib-txt">
          <span className="ib-l">Using OPENAI_API_KEY</span>
          <span className="ib-desc">It is set in this Inbox’s environment, so there is nothing to paste here.</span>
        </span>
      </div>
    );
  if (key?.source === 'saved' && !replacing)
    return (
      <div className="ib-prow" data-voice-key="saved">
        <span className="ib-txt">
          <span className="ib-l">
            <span className="ib-paired">
              <Icon name="check" size={14} />
              Key saved, ending in {key.last4}
            </span>
          </span>
          <span className="ib-desc">Kept on {voiceWhere(voice)}. It is never shown again or sent to any page.</span>
        </span>
        <span className="ib-ctl">
          <button type="button" className="ib-btn" onClick={() => setReplacing(true)} data-voice-key-replace="">
            Replace
          </button>
          <button type="button" className="ib-btn ib-ghost" disabled={saving} onClick={() => void save(null)} data-voice-key-remove="">
            Remove
          </button>
        </span>
      </div>
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (typed.trim()) void save(typed);
  };
  return (
    <form className="ib-prow ib-vkeyrow" onSubmit={submit} data-voice-key="empty">
      <span className="ib-txt">
        <label className="ib-l" htmlFor="ib-vkey">
          API key
        </label>
        <span className="ib-desc">Kept on {voiceWhere(voice)}. It is never shown again or sent to any page.</span>
      </span>
      <span className="ib-ctl ib-vkeyctl">
        <input id="ib-vkey" className="ib-vkey" type="password" autoComplete="new-password" spellCheck={false} placeholder="sk-…" value={typed} onChange={(event) => setTyped(event.target.value)} />
        <button type="submit" className="ib-btn" disabled={saving || !typed.trim()}>
          Save
        </button>
      </span>
    </form>
  );
}

export function VoiceSettings() {
  const voice = useVoiceSettings();
  const { status, checking } = useVoiceStatus();
  const [error, setError] = useState<string | null>(null);
  const on = voice?.on === true;
  const engine = voice?.engine ?? 'codex';
  const where = voiceWhere(voice);
  useEffect(() => {
    if (on && engine === 'codex') void checkVoiceStatus();
  }, [on, engine]);
  if (!voice) return null;
  const save = async (change: { on?: boolean; phones_only?: boolean; engine?: InboxVoiceEngine }) => {
    setError(null);
    adoptVoiceSettings({
      ...voice,
      on: change.on ?? voice.on,
      phones_only: change.phones_only ?? voice.phones_only,
      engine: change.engine ?? voice.engine,
    });
    try {
      adoptVoiceSettings((await inboxApi.saveVoice(change)).voice);
    } catch (cause) {
      adoptVoiceSettings(voice);
      setError(cause instanceof Error ? cause.message : 'The setting was not saved.');
    }
  };
  if (voice?.guest) {
    return (
      <section className="ib-sgroup ib-sgroup-first" data-settings-voice="guest" aria-label="Voice">
        <p className="ib-vpage-note">Voice uses the ChatGPT login or API key on {where}, so only its owner can use it from here.</p>
      </section>
    );
  }
  return (
    <>
      <section className="ib-sgroup ib-sgroup-first" data-settings-voice="" aria-label="Voice">
        <div className="ib-card">
          <div className="ib-prow">
            <span className="ib-txt">
              <span className="ib-l" id="ib-voice-label">
                Voice
              </span>
              <span className="ib-desc">Adds a microphone to the reply box. Hold it to talk, or tap it. Your words land in the box, and you press Send.</span>
            </span>
            <span className="ib-ctl">
              <Toggle on={on} labelledBy="ib-voice-label" onClick={() => void save({ on: !on })} />
            </span>
          </div>
          {on && (
            <div className="ib-prow">
              <span className="ib-txt">
                <span className="ib-l" id="ib-voice-phones-label">
                  Phones only
                </span>
                <span className="ib-desc">Hides the microphone on computers. The phone records, and {where} turns the audio into text.</span>
              </span>
              <span className="ib-ctl">
                <Toggle on={voice.phones_only} labelledBy="ib-voice-phones-label" onClick={() => void save({ phones_only: !voice.phones_only })} />
              </span>
            </div>
          )}
        </div>
        {!on && (
          <p className="ib-vpage-note">
            {ROUTE_LINE} {TERMS_LINE} Nothing runs while this is off.
          </p>
        )}
      </section>
      {on && (
        <section className="ib-sgroup" aria-labelledby="ib-g-voice-engine">
          <h2 id="ib-g-voice-engine">Transcription</h2>
          <p>{engine === 'codex' ? `${ROUTE_LINE} ${TERMS_LINE}` : 'Your audio goes to OpenAI’s public speech-to-text API under your own key. OpenAI bills your API account for each minute of audio.'}</p>
          <div className="ib-card">
            <div className="ib-prow">
              <span className="ib-txt">
                <span className="ib-l" id="ib-voice-engine-label">
                  Transcribed by
                </span>
              </span>
              <span className="ib-ctl">
                <span className="ib-seg" role="radiogroup" aria-labelledby="ib-voice-engine-label">
                  {(
                    [
                      ['codex', 'Codex login'],
                      ['api', 'OpenAI API key'],
                    ] as const
                  ).map(([id, label]) => (
                    <label key={id} className="ib-seg-o" data-on={engine === id ? '' : undefined}>
                      <input type="radio" name="ib-voice-engine" value={id} checked={engine === id} onChange={() => void save({ engine: id })} />
                      {label}
                    </label>
                  ))}
                </span>
              </span>
            </div>
            {engine === 'codex' ? <CodexStatus where={where} status={status} checking={checking} /> : <ApiKey onError={setError} />}
          </div>
        </section>
      )}
      {error && (
        <div className="ib-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
