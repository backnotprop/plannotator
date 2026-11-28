import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CloudflareRefusal, postCloudflare, readCloudflare, type CloudflareView } from '../data/cloudflareAccess';
import { Icon } from '../icons';
import { qrModules } from '../qr';
import { CloudflareForm, CloudflareProgress } from './CloudflareSetup';
import { Switch } from './SettingSwitch';
import { CloudflareMark } from './CloudflareMark';

const CloudflareTileMark = CloudflareMark;

function AddressQr({ url }: { url: string }) {
  const path = useMemo(() => qrModules(url), [url]);
  return (
    <div className="ib-qr-wrap ib-cf-qr">
      <svg className="ib-qr" viewBox={`-2 -2 ${path.size + 4} ${path.size + 4}`} role="img" aria-label="QR code of the Inbox address" data-cloudflare-qr="" shapeRendering="crispEdges">
        <rect x={-2} y={-2} width={path.size + 4} height={path.size + 4} fill="#fff" />
        <path d={path.d} fill="#000" />
      </svg>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ib-btn ib-ghost"
      aria-label={`Copy the ${label} address`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={13} />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function problemOf(view: CloudflareView): string | null {
  if (!view.on) return null;
  if (view.error) return view.error;
  const tunnel = view.tunnel;
  if (!tunnel) return null;
  if (tunnel.state === 'missing') return tunnel.error ?? 'cloudflared is not installed.';
  if (tunnel.state === 'retrying') return `The tunnel is not connected: ${tunnel.error ?? 'cloudflared stopped'}. It starts again by itself.`;
  return null;
}

function tunnelLine(view: CloudflareView): string {
  const tunnel = view.tunnel;
  if (!view.on) return 'tunnel stopped, setup kept';
  if (!tunnel) return 'starting';
  if (tunnel.state === 'connected') return 'tunnel connected';
  if (tunnel.state === 'starting') return 'tunnel starting';
  return 'tunnel not connected';
}

function RemoveForm({ onDone, onCancel }: { onDone: (view: CloudflareView) => void; onCancel: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const sent = token;
    setToken('');
    setBusy(true);
    setError(null);
    try {
      onDone(await postCloudflare('remove', { token: sent }));
    } catch (failure) {
      setError(failure instanceof CloudflareRefusal ? failure.message : 'Could not reach this Inbox.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="ib-prow" onSubmit={(event) => void submit(event)} data-cloudflare-remove="">
      <span className="ib-txt">
        <label className="ib-l" htmlFor="ib-cf-remove-token">
          Remove from Cloudflare
        </label>
        <span className="ib-desc">Deletes the two addresses, the login gate and the tunnel. It needs an API token again; it is not kept.</span>
        {error && (
          <span className="ib-desc" role="alert">
            {error}
          </span>
        )}
      </span>
      <span className="ib-ctl ib-vkeyctl">
        <input id="ib-cf-remove-token" className="ib-vkey" type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} />
        <button type="submit" className="ib-btn ib-danger" disabled={busy || !token.trim()}>
          Remove
        </button>
        <button type="button" className="ib-btn ib-ghost" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}

export function ThroughCloudflare() {
  const [view, setView] = useState<CloudflareView | null>(null);
  const [refused, setRefused] = useState(false);
  const [mode, setMode] = useState<'view' | 'form' | 'remove'>('view');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await readCloudflare());
    } catch (failure) {
      if (failure instanceof CloudflareRefusal && failure.code === 'local_only') setRefused(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = view?.job?.running === true;
  useEffect(() => {
    if (!view || (!running && !view.on)) return;
    const timer = setInterval(() => void load(), running ? 1000 : 5000);
    return () => clearInterval(timer);
  }, [view, running, load]);

  if (refused) {
    return (
      <section className="ib-sgroup" data-settings-cloudflare="elsewhere" aria-labelledby="ib-g-cloudflare">
        <h2 id="ib-g-cloudflare">Cloudflare</h2>
        <p>Change this on the computer itself or over your tailnet.</p>
      </section>
    );
  }
  if (!view) return null;

  const swap = async (on: boolean) => {
    setBusy(true);
    try {
      setView(await postCloudflare('switch', { on }));
    } finally {
      setBusy(false);
    }
  };

  const job = view.job;
  const showJob = job && (job.running || job.failed);
  const problem = problemOf(view);
  const state = showJob ? 'setting-up' : mode === 'form' ? 'form' : !view.configured ? 'off' : problem ? 'problem' : view.on ? 'on' : 'paused';

  return (
    <section className="ib-sgroup" data-settings-cloudflare={state} aria-labelledby="ib-g-cloudflare">
      <h2 id="ib-g-cloudflare">Cloudflare</h2>
      <p>
        Open the Inbox and sessions from your other devices with{' '}
        <a href="https://www.cloudflare.com/products/access/" target="_blank" rel="noreferrer">
          Cloudflare Access
        </a>{' '}
        and Cloudflare Tunnel, on your own Cloudflare account. Only your e-mail can sign in.
      </p>
      {showJob ? (
        <CloudflareProgress
          job={job!}
          onClose={() => void postCloudflare('dismiss', {}).then(setView)}
          onRetry={() => void postCloudflare('dismiss', {}).then((next) => {
            setView(next);
            setMode('form');
          })}
        />
      ) : mode === 'form' ? (
        <CloudflareForm
          onStarted={(next) => {
            setView(next);
            setMode('view');
          }}
          onCancel={() => setMode('view')}
        />
      ) : !view.configured ? (
        <div className="ib-card">
          <div className="ib-prow">
            <span className="ib-tile">
              <CloudflareTileMark />
            </span>
            <span className="ib-txt">
              <span className="ib-l">Reach the Inbox through Cloudflare</span>
              <span className="ib-desc">Needs a Cloudflare account with a domain on it, Zero Trust turned on (the Free plan is enough) and cloudflared on this computer.</span>
              <ul className="ib-checks ib-cf-need" data-cloudflared={view.cloudflared.found ? 'found' : 'missing'}>
                <li className={view.cloudflared.found ? 'ib-ck-ok' : 'ib-ck-fail'}>
                  <Icon name={view.cloudflared.found ? 'checkCircle' : 'xCircle'} size={14} />
                  <span>
                    {view.cloudflared.found ? 'cloudflared found on this computer' : 'cloudflared is not installed'}
                    {!view.cloudflared.found && <span className="ib-fix">{view.cloudflared.install}</span>}
                  </span>
                </li>
              </ul>
            </span>
            <span className="ib-ctl">
              <button type="button" className="ib-btn ib-pri" disabled={!view.cloudflared.found} onClick={() => setMode('form')} data-cloudflare-setup="">
                Set up
              </button>
            </span>
          </div>
        </div>
      ) : (
        <div className="ib-card">
          <div className="ib-prow">
            <span className="ib-tile">
              <CloudflareTileMark />
            </span>
            <span className="ib-txt">
              <span className="ib-l">
                <span id="ib-cf-label">Reach the Inbox through Cloudflare</span>
                {problem && <span className="ib-chip ib-chip-err">Not working</span>}
              </span>
              <span className="ib-desc">
                {view.on ? 'On' : 'Off'} · only {view.allowed.join(', ')} can sign in · {tunnelLine(view)}
              </span>
            </span>
            <span className="ib-ctl">
              <Switch on={view.on} labelledBy="ib-cf-label" disabled={busy} onClick={() => void swap(!view.on)} />
            </span>
          </div>
          {[
            { label: 'Inbox', url: view.url ?? (view.host ? `https://${view.host}/` : null) },
            { label: 'sessions', url: view.sessions_url ?? (view.session_host ? `https://${view.session_host}/` : null) },
          ].map(
            (row) =>
              row.url && (
                <div className="ib-prow" key={row.label} data-cloudflare-address={row.label}>
                  <span className="ib-txt">
                    <span className="ib-l">{row.label === 'Inbox' ? 'Inbox address' : 'Sessions address'}</span>
                    <span className="ib-desc ib-mono">{row.label === 'Inbox' ? row.url : `${row.url}s/…`}</span>
                  </span>
                  <span className="ib-ctl">
                    <CopyButton text={row.url} label={row.label} />
                  </span>
                </div>
              ),
          )}
          {view.on && view.url && (
            <div className="ib-prow ib-cf-on">
              <AddressQr url={view.url} />
              <span className="ib-txt">
                <span className="ib-desc">Scan to open the Inbox on your phone, then sign in with the code Cloudflare e-mails you.</span>
              </span>
            </div>
          )}
          {problem && (
            <div className="ib-callout ib-err ib-in-card" data-cloudflare-problem="">
              <Icon name="xCircle" />
              <span>{problem}</span>
            </div>
          )}
          {mode === 'remove' ? (
            <RemoveForm
              onDone={(next) => {
                setView(next);
                setMode('view');
              }}
              onCancel={() => setMode('view')}
            />
          ) : (
            <div className="ib-prow">
              <span className="ib-txt">
                <span className="ib-desc">The switch stops or starts the tunnel and keeps the setup. Remove deletes it from Cloudflare.</span>
              </span>
              <span className="ib-ctl">
                <button type="button" className="ib-btn ib-ghost" onClick={() => setMode('remove')} data-cloudflare-remove-open="">
                  Remove
                </button>
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
