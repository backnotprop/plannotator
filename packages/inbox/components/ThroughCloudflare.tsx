import type { CloudflareAccessSettings } from '../api';
import { Icon } from '../icons';

function tunnelLine(tunnel: CloudflareAccessSettings['tunnel']): string {
  if (!tunnel) return '';
  if (tunnel.state === 'connected') return 'tunnel connected';
  if (tunnel.state === 'missing') return 'cloudflared is not installed';
  if (tunnel.state === 'retrying') return 'tunnel reconnecting';
  return 'tunnel starting';
}

export function ThroughCloudflare({ state }: { state: CloudflareAccessSettings }) {
  const problem = state.error ?? (state.tunnel && state.tunnel.state !== 'connected' && state.tunnel.state !== 'starting' ? state.tunnel.error : null);
  return (
    <section className="ib-sgroup" data-settings-cloudflare={state.url ? 'on' : 'off'} aria-labelledby="ib-g-cloudflare">
      <h2 id="ib-g-cloudflare">Through Cloudflare Access</h2>
      <p>Your own Cloudflare address for the Inbox and for sessions started with --cloudflare-access. Reachable from the internet, behind your Cloudflare login.</p>
      <div className="ib-card">
        <div className="ib-prow">
          <span className="ib-tile">
            <Icon name="globe" />
          </span>
          <span className="ib-txt">
            <span className="ib-l">
              Reach the Inbox through Cloudflare
              {problem && <span className="ib-chip ib-chip-err">Not working</span>}
            </span>
            <span className="ib-desc" data-cloudflare-url={state.url ?? ''}>
              {state.url ? (
                <>
                  On ·{' '}
                  <a href={state.url} target="_blank" rel="noreferrer">
                    {state.url}
                  </a>{' '}
                  · only {state.allowed.join(', ')} can open it{state.tunnel ? ` · ${tunnelLine(state.tunnel)}` : ''}
                </>
              ) : state.on ? (
                'On · not open'
              ) : (
                'Off'
              )}
            </span>
          </span>
        </div>
        {problem && (
          <div className="ib-callout ib-err ib-in-card" data-cloudflare-error="">
            <Icon name="xCircle" />
            <span>{problem}</span>
          </div>
        )}
      </div>
      <div className="ib-note">
        <Icon name="info" />
        <span>
          Set up and removed from a terminal: <code>plannotator inbox cloudflare-access teardown</code> takes it all down.
        </span>
      </div>
    </section>
  );
}
