import React, { useCallback, useEffect, useState } from 'react';
import { configStore, useConfigValue } from '../../config';
import { AnalysisLayerToggle } from '../AnalysisLayerToggle';
import { PowerUpGuy } from '../agentFace/PowerUpGuy';

type Provider = 'jev' | 'clef';
type Check = { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok'; ms: number } | { kind: 'error'; reason: string };

const ROUTE = '/api/sem-diff/opinion/settings';
export const POWER_UP_CHANGED_EVENT = 'plannotator:power-up-changed';
const PROVIDER_NAME: Record<Provider, string> = { jev: 'Jev', clef: 'Clef' };

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex items-center gap-px rounded-md bg-muted/60 p-px" role="radiogroup" aria-label={label}>
      {options.map(([id, text]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={`rounded-[5px] px-2.5 py-1 text-xs ${value === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</div>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

export function SemanticDiffsTab() {
  const semantic = useConfigValue('diffSemantic');
  const powerUp = useConfigValue('diffPowerUp');
  const motion = useConfigValue('diffPowerUpMotion');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [configured, setConfigured] = useState(false);
  const [provider, setProvider] = useState<Provider>('jev');
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [accountId, setAccountId] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [check, setCheck] = useState<Check>({ kind: 'idle' });

  const load = useCallback(async () => {
    try {
      const res = await fetch(ROUTE);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { configured: boolean; provider: Provider | null };
      setAvailable(true);
      setConfigured(data.configured);
      if (data.provider) setProvider(data.provider);
      setEditing(!data.configured);
    } catch {
      setAvailable(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const changed = () => window.dispatchEvent(new Event(POWER_UP_CHANGED_EVENT));

  const save = async () => {
    setCheck({ kind: 'checking' });
    const body = provider === 'jev' ? { provider, apiKey } : { provider, accountId, apiToken };
    try {
      const res = await fetch(ROUTE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const reply = (await res.json()) as { ok: true; ms: number } | { ok: false; reason: string };
      setApiKey('');
      setApiToken('');
      if (reply.ok === false) {
        setCheck({ kind: 'error', reason: reply.reason });
        return;
      }
      setCheck({ kind: 'ok', ms: reply.ms });
      setConfigured(true);
      setEditing(false);
      configStore.set('diffPowerUp', true);
      changed();
    } catch {
      setCheck({ kind: 'error', reason: 'The review server did not answer.' });
    }
  };

  const remove = async () => {
    await fetch(ROUTE, { method: 'DELETE' }).catch(() => {});
    setConfigured(false);
    setEditing(true);
    setCheck({ kind: 'idle' });
    changed();
  };

  const field = 'w-56 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs';
  return (
    <div className="space-y-4" data-semantic-diffs-settings="">
      <div>
        <div className="text-sm font-semibold">Semantic diffs</div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Labels what each change really is: moved, renamed, reformatted, extracted.</p>
      </div>
      <AnalysisLayerToggle
        checked={semantic}
        onChange={(on) => configStore.set('diffSemantic', on)}
        label="Show moved & renamed code"
        description="Draw moved, renamed, reformatted, extracted and inlined code as what it is."
      />
      <div data-power-up-settings="">
        <div className="flex items-start justify-between gap-4 border-t border-border pt-3">
          <span data-power-up-settings-slot="" aria-hidden="true" className="pt-0.5">
            <PowerUpGuy state={powerUp && configured && semantic ? 'alive' : 'grey'} size={20} wakeKey={powerUp} />
          </span>
          <AnalysisLayerToggle
            checked={powerUp && configured}
            disabled={!configured || !semantic}
            onChange={(on) => {
              configStore.set('diffPowerUp', on);
              changed();
            }}
            label="Power Up"
            description={
              configured
                ? 'A decision model answers the calls the engine was too strict to make. When it is on, every semantic diff is powered up.'
                : 'A decision model answers the calls the engine was too strict to make. Add a key below to turn it on.'
            }
          />
        </div>
        {available === false ? (
          <Row title="Model" hint="This review host cannot keep a key." />
        ) : (
          <>
            <Row title="Model" hint={provider === 'jev' ? 'Jev is the faster one, about 0.2 s a file.' : 'Clef runs on your Cloudflare account.'}>
              <Segmented
                label="Model"
                value={provider}
                options={[['jev', 'Jev'], ['clef', 'Clef']]}
                onChange={(v) => {
                  setProvider(v);
                  setEditing(true);
                  setCheck({ kind: 'idle' });
                }}
              />
            </Row>
            <Row
              title={provider === 'jev' ? 'API key' : 'Account and token'}
              hint={
                check.kind === 'ok'
                  ? `✓ Key works · ${check.ms} ms`
                  : check.kind === 'error'
                    ? check.reason
                    : check.kind === 'checking'
                      ? 'Checking the key…'
                      : configured && !editing
                        ? 'Kept by this computer, never shown again.'
                        : undefined
              }
            >
              {configured && !editing ? (
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-muted-foreground" data-power-up-key-set="">•••• set</span>
                  <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => setEditing(true)}>Change</button>
                  <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => void remove()}>Remove</button>
                </div>
              ) : (
                <form
                  className="flex flex-col items-end gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                  }}
                >
                  {provider === 'jev' ? (
                    <input className={field} type="password" autoComplete="off" placeholder="TypeSafe API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} aria-label="TypeSafe API key" />
                  ) : (
                    <>
                      <input className={field} autoComplete="off" placeholder="Cloudflare account ID" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Cloudflare account ID" />
                      <input className={field} type="password" autoComplete="off" placeholder="Workers AI token" value={apiToken} onChange={(e) => setApiToken(e.target.value)} aria-label="Workers AI token" />
                    </>
                  )}
                  <button type="submit" disabled={check.kind === 'checking'} className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50">
                    Check and save
                  </button>
                </form>
              )}
            </Row>
            <Row title="Motion" hint="The stream on powered bands. Follows your system's reduce-motion setting.">
              <Segmented label="Motion" value={motion} options={[['stream', 'Stream'], ['still', 'Still']]} onChange={(v) => configStore.set('diffPowerUpMotion', v)} />
            </Row>
            <p className="pt-1 text-xs text-muted-foreground">
              Your key, your account; code is sent to {PROVIDER_NAME[provider]}. Only the functions a link is about, never the rest of the repository.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
