import { useState, type FormEvent } from 'react';
import { CloudflareRefusal, postCloudflare, type CloudflareStepId, type CloudflareView, type CloudflareZone } from '../data/cloudflareAccess';
import { Icon, type IconName } from '../icons';

const STEP_LABEL: Record<CloudflareStepId, string> = {
  account: 'Your Cloudflare account and its one-time-code sign-in',
  tunnel: 'The tunnel to this computer',
  gate: 'The login gate, for your e-mail only',
  address: 'The two addresses',
  checks: 'Outside checks: nothing gets in without your sign-in',
};

const STEP_ICON: Record<string, { icon: IconName; word: string; cls: string }> = {
  done: { icon: 'checkCircle', word: 'Done', cls: 'ok' },
  running: { icon: 'refresh', word: 'Working', cls: 'later' },
  pending: { icon: 'minus', word: 'Waiting', cls: 'later' },
  failed: { icon: 'xCircle', word: 'Failed', cls: 'fail' },
};

export function CloudflareProgress({ job, onClose, onRetry }: { job: NonNullable<CloudflareView['job']>; onClose: () => void; onRetry: () => void }) {
  return (
    <div className="ib-flow" data-cloudflare-progress={job.running ? 'running' : job.failed ? 'failed' : 'done'}>
      <div className="ib-flow-head">
        <h3>{job.failed ? 'Setup stopped' : job.running ? 'Setting up' : 'Set up'} {job.host ?? ''}</h3>
      </div>
      <div className="ib-flow-body">
        <ul className="ib-checks" aria-live="polite">
          {job.steps.map((step) => {
            const look = STEP_ICON[step.state]!;
            return (
              <li key={step.id} className={`ib-ck-${look.cls}`} data-cloudflare-step={step.id} data-state={step.state}>
                <Icon name={look.icon} size={14} />
                <span>
                  <span className="ib-sr">{look.word}: </span>
                  {STEP_LABEL[step.id]}
                </span>
              </li>
            );
          })}
        </ul>
        {job.failed && (
          <div className="ib-callout ib-err" role="alert" data-cloudflare-failed={job.failed.step}>
            <Icon name="xCircle" />
            <span>
              {STEP_LABEL[job.failed.step]}: {job.failed.message}{' '}
              {job.failed.leftover.length > 0
                ? `Could not remove everything; delete in Cloudflare: ${job.failed.leftover.join(', ')}.`
                : 'Nothing was left behind in Cloudflare.'}
            </span>
          </div>
        )}
        {!job.running && job.failed && (
          <div className="ib-flow-f">
            <button type="button" className="ib-btn ib-pri" onClick={onRetry}>
              Try again
            </button>
            <button type="button" className="ib-btn ib-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function CloudflareForm({ onStarted, onCancel }: { onStarted: (view: CloudflareView) => void; onCancel: () => void }) {
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [zones, setZones] = useState<CloudflareZone[] | null>(null);
  const [zone, setZone] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = zones?.find((z) => z.name === zone)?.account ?? null;
  const host = zone && label ? `${label}.${zone}` : null;

  const findZones = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await postCloudflare<{ zones: CloudflareZone[]; label: string }>('zones', { token });
      setZones(found.zones);
      setLabel(found.label);
      setZone(found.zones.length === 1 ? found.zones[0]!.name : '');
    } catch (failure) {
      setError(failure instanceof CloudflareRefusal ? failure.message : 'Could not reach this Inbox.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!host) return;
    const sent = token;
    setToken('');
    setBusy(true);
    setError(null);
    try {
      onStarted(await postCloudflare('setup', { token: sent, email, zone, hostname: host, account }));
    } catch (failure) {
      setError(failure instanceof CloudflareRefusal ? `${failure.message} Paste the token again to retry.` : 'Could not reach this Inbox.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ib-flow" onSubmit={(event) => void submit(event)} data-cloudflare-form="">
      <div className="ib-flow-head">
        <h3>Set up Cloudflare</h3>
      </div>
      <div className="ib-flow-body">
        <p className="ib-lead">
          The token is used once and never saved.{' '}
          <a href="https://developers.cloudflare.com/fundamentals/api/get-started/create-token/" target="_blank" rel="noreferrer">
            Create one in Cloudflare
          </a>{' '}
          with edit rights for Tunnel, Access (apps, policies, identity providers) and DNS.
        </p>
        <div className="ib-card">
          <div className="ib-prow">
            <span className="ib-txt">
              <label className="ib-l" htmlFor="ib-cf-email">
                Who may sign in
              </label>
              <span className="ib-desc">Your e-mail. Only this address gets a sign-in code.</span>
            </span>
            <span className="ib-ctl ib-vkeyctl">
              <input id="ib-cf-email" className="ib-vkey" type="email" autoComplete="off" spellCheck={false} placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
            </span>
          </div>
          <div className="ib-prow">
            <span className="ib-txt">
              <label className="ib-l" htmlFor="ib-cf-token">
                API token
              </label>
              <span className="ib-desc">Sent once to this Inbox, used for setup, then forgotten.</span>
            </span>
            <span className="ib-ctl ib-vkeyctl">
              <input id="ib-cf-token" className="ib-vkey" type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} />
              {zones === null && (
                <button type="button" className="ib-btn" disabled={busy || !token.trim()} onClick={() => void findZones()} data-cloudflare-zones="">
                  Find domains
                </button>
              )}
            </span>
          </div>
          {zones !== null && (
            <div className="ib-prow">
              <span className="ib-txt">
                <label className="ib-l" htmlFor="ib-cf-zone">
                  Domain
                </label>
                <span className="ib-desc" data-cloudflare-names={host ?? ''}>
                  {host ? (
                    <>
                      Inbox at <span className="ib-mono">{host}</span>
                      <br />
                      Sessions at <span className="ib-mono">{`${label}-s.${zone}`}</span>
                    </>
                  ) : zones.length === 0 ? (
                    'This token sees no domain on Cloudflare.'
                  ) : (
                    'Pick the domain to use.'
                  )}
                </span>
              </span>
              <span className="ib-ctl ib-vkeyctl">
                <select id="ib-cf-zone" className="ib-vkey" value={zone} onChange={(event) => setZone(event.target.value)} disabled={zones.length === 0}>
                  <option value="">Choose…</option>
                  {zones.map((z) => (
                    <option key={z.name} value={z.name}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </span>
            </div>
          )}
        </div>
        {error && (
          <div className="ib-callout ib-err" role="alert">
            <Icon name="xCircle" />
            <span>{error}</span>
          </div>
        )}
        <div className="ib-flow-f">
          <button type="submit" className="ib-btn ib-pri" disabled={busy || !host || !email.trim() || !token.trim()} data-cloudflare-start="">
            Set up
          </button>
          <button type="button" className="ib-btn ib-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}
