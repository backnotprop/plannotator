import { useState, type FormEvent } from 'react';
import type { InboxForgejoCheckVerdict, InboxForgejoHostsState } from '@plannotator/core/inbox-types';
import { post } from '../api';
import { Icon } from '../icons';
import { inboxUrl } from '../inboxUrl';

declare module '../api' {
  interface SettingsModel {
    /** Settings → Accounts → Forgejo and Gitea: hosts and where each token comes from, never a token. */
    forgejo_hosts?: InboxForgejoHostsState;
  }
}

const send = <T,>(body: Record<string, unknown>) => post<T>(inboxUrl('/forgejo/hosts'), body);

const HINT = 'Shows Forgejo and Gitea links as cards and reads their pull requests. codeberg.org needs no setup.';

const VERDICT: Record<InboxForgejoCheckVerdict, string> = {
  accepted: 'The host accepted it.',
  refused: 'The host refused it. Replace it with a working token.',
  unreachable: 'This computer could not reach the host.',
};

/** The last answer and the read it replaced: the settings model is not reread after a save (as for the Linear key). */
let lastSave: { over: InboxForgejoHostsState; state: InboxForgejoHostsState } | null = null;

export function ForgejoHostsSettings({ initial, where }: { initial: InboxForgejoHostsState; /** The computer that keeps them. */ where: string }) {
  const [state, setStateRaw] = useState(() => (lastSave?.over === initial ? lastSave.state : initial));
  const setState = (next: InboxForgejoHostsState) => {
    lastSave = { over: initial, state: next };
    setStateRaw(next);
  };
  const [origin, setOrigin] = useState('');
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState<string | null>(null);
  const [replacement, setReplacement] = useState('');
  const [verdicts, setVerdicts] = useState<Record<string, InboxForgejoCheckVerdict>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That was not saved.');
    } finally {
      setBusy(false);
    }
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!origin.trim()) return;
    void run(async () => {
      setState(await send<InboxForgejoHostsState>({ op: 'save', origin, ...(token.trim() ? { token } : {}) }));
      setOrigin('');
      setToken('');
    });
  };
  const replace = (host: string) => {
    if (!replacement.trim()) return;
    void run(async () => {
      setState(await send<InboxForgejoHostsState>({ op: 'save', origin: host, token: replacement }));
      setReplacing(null);
      setReplacement('');
      setVerdicts(({ [host]: _gone, ...rest }) => rest);
    });
  };
  const remove = (host: string) =>
    void run(async () => {
      setState(await send<InboxForgejoHostsState>({ op: 'remove', origin: host }));
    });
  const check = (host: string) =>
    void run(async () => {
      const answer = await send<{ verdict: InboxForgejoCheckVerdict }>({ op: 'check', origin: host });
      setVerdicts((all) => ({ ...all, [host]: answer.verdict }));
    });

  return (
    <section className="ib-acct-m" aria-labelledby="ib-acct-forgejo" data-settings-forgejo="">
      <h2 className="ib-acct-mh" id="ib-acct-forgejo">
        Forgejo and Gitea
      </h2>
      <div className="ib-acct-linear">
        <div className="ib-prow" data-forgejo-host="codeberg.org">
          <span className="ib-txt">
            <span className="ib-l">codeberg.org</span>
            <span className="ib-desc">Built in. {HINT}</span>
          </span>
        </div>
        {state.hosts.map((host) => {
          const verdict = verdicts[host.origin];
          const own = host.hostSource === 'saved';
          return (
            <div className="ib-prow" key={host.origin} data-forgejo-host={host.origin}>
              <span className="ib-txt">
                <span className="ib-l">
                  <span className="ib-paired">
                    {host.token.source && verdict !== 'refused' && <Icon name="check" size={14} />}
                    {host.origin}
                  </span>
                </span>
                <span className="ib-desc" data-forgejo-verdict={verdict ?? undefined}>
                  {verdict ? `${VERDICT[verdict]} ` : ''}
                  {host.token.source === 'saved'
                    ? `Token saved, ending in ${host.token.last4}. Kept on ${where}.`
                    : host.token.source === 'env'
                      ? 'Using PLANNOTATOR_FORGEJO_TOKEN. It is set in this Inbox’s environment.'
                      : 'No token: public repositories only.'}
                  {!own && ' The host is set in the environment.'}
                </span>
                {replacing === host.origin && (
                  <form className="ib-vkeyrow" onSubmit={(event) => { event.preventDefault(); replace(host.origin); }}>
                    <input className="ib-vkey" type="password" autoComplete="new-password" spellCheck={false} aria-label={`Token for ${host.origin}`} placeholder="Token" value={replacement} onChange={(event) => setReplacement(event.target.value)} />
                    <button type="submit" className="ib-btn" disabled={busy || !replacement.trim()}>
                      Save
                    </button>
                  </form>
                )}
              </span>
              <span className="ib-ctl">
                <button type="button" className="ib-btn" disabled={busy} onClick={() => check(host.origin)} data-forgejo-check="">
                  Check
                </button>
                {own && (
                  <>
                    <button type="button" className="ib-btn" onClick={() => { setReplacing(replacing === host.origin ? null : host.origin); setReplacement(''); }} data-forgejo-replace="">
                      {host.token.source === 'saved' ? 'Replace' : 'Add token'}
                    </button>
                    <button type="button" className="ib-btn ib-ghost" disabled={busy} onClick={() => remove(host.origin)} data-forgejo-remove="">
                      Remove
                    </button>
                  </>
                )}
              </span>
            </div>
          );
        })}
        <form className="ib-prow ib-vkeyrow" onSubmit={add} data-forgejo-add="">
          <span className="ib-txt">
            <label className="ib-l" htmlFor="ib-forgejo-origin">
              Add a host
            </label>
            <span className="ib-desc">The address of your instance, and a token if it needs one. Kept on {where}, never shown again.</span>
          </span>
          <span className="ib-ctl ib-vkeyctl">
            <input id="ib-forgejo-origin" className="ib-vkey" type="text" spellCheck={false} placeholder="https://git.example.com" value={origin} onChange={(event) => setOrigin(event.target.value)} />
            <input className="ib-vkey" type="password" autoComplete="new-password" spellCheck={false} aria-label="Token (optional)" placeholder="Token (optional)" value={token} onChange={(event) => setToken(event.target.value)} />
            <button type="submit" className="ib-btn" disabled={busy || !origin.trim()}>
              Save
            </button>
          </span>
        </form>
      </div>
      {error && (
        <div className="ib-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
