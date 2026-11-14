import React, { useCallback, useEffect, useState } from 'react';
import { configStore, useConfigValue } from '../../config';
import { AnalysisLayerToggle } from '../AnalysisLayerToggle';
import { PowerUpGuy } from '../agentFace/PowerUpGuy';

type Provider = 'jev' | 'clef';
type Failure = 'missing' | 'refused' | 'noCredit' | 'noAnswer';
type Check = { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok'; ms: number } | { kind: 'error'; failure: Failure };

const ROUTE = '/api/sem-diff/opinion/settings';
export const POWER_UP_CHANGED_EVENT = 'plannotator:power-up-changed';
const PROVIDER_NAME: Record<Provider, string> = { jev: 'Jev', clef: 'Clef' };
const ADD_KEY: Record<Provider, string> = { jev: 'Add your Jev key', clef: 'Add your account ID and token' };

function failureText(provider: Provider, failure: Failure): string {
  const name = PROVIDER_NAME[provider];
  if (failure === 'missing') return ADD_KEY[provider];
  if (failure === 'refused') return provider === 'jev' ? 'Jev refused this key' : 'Clef refused this token';
  if (failure === 'noCredit') return `No credit left on this ${name} account`;
  return `${name} did not answer. Try again in a moment.`;
}

function KeyField({ caption, label, value, onChange, secret, flagged, saved, onFocus, className }: {
  caption: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret: boolean;
  flagged: boolean;
  saved: boolean;
  onFocus: () => void;
  className: string;
}) {
  return (
    <label className={`relative flex h-7 items-center ${className}`}>
      <span className="pointer-events-none absolute left-2 text-[10px] text-muted-foreground">{caption}</span>
      <input
        className={`h-7 w-full min-w-0 rounded-md border bg-background pr-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring ${flagged ? 'border-warning' : 'border-border'}`}
        style={{ paddingLeft: `${caption.length * 0.55 + 1.1}em` }}
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        placeholder={saved ? '••••••••' : ''}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        aria-label={label}
        aria-invalid={flagged || undefined}
      />
    </label>
  );
}

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
  const [savedProvider, setSavedProvider] = useState<Provider | null>(null);
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
      setSavedProvider(data.provider);
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
      const reply = (await res.json()) as { ok: true; ms: number } | { ok: false; failure?: Failure };
      setApiKey('');
      setApiToken('');
      if (reply.ok === false) {
        setCheck({ kind: 'error', failure: reply.failure ?? 'noAnswer' });
        return;
      }
      setCheck({ kind: 'ok', ms: reply.ms });
      setAccountId('');
      setSavedProvider(provider);
      setConfigured(true);
      setEditing(false);
      configStore.set('diffPowerUp', true);
      changed();
    } catch {
      setCheck({ kind: 'error', failure: 'noAnswer' });
    }
  };

  const remove = async () => {
    await fetch(ROUTE, { method: 'DELETE' }).catch(() => {});
    setConfigured(false);
    setSavedProvider(null);
    setEditing(true);
    setCheck({ kind: 'idle' });
    changed();
  };

  const saved = configured && savedProvider === provider && (!editing || (provider === 'jev' ? !apiKey : !accountId && !apiToken));
  const complete = provider === 'jev' ? apiKey.trim() !== '' : accountId.trim() !== '' && apiToken.trim() !== '';
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
                check.kind === 'ok' ? (
                  `✓ Key works · ${check.ms} ms`
                ) : check.kind === 'error' ? (
                  <span className="text-foreground" data-power-up-key-failure={check.failure}>{failureText(provider, check.failure)}</span>
                ) : check.kind === 'checking' ? (
                  'Checking…'
                ) : saved ? (
                  <>
                    Kept by this computer, never shown again ·{' '}
                    <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => void remove()}>Remove</button>
                  </>
                ) : (
                  ADD_KEY[provider]
                )
              }
            >
              <form
                className="flex h-7 w-[250px] items-center gap-1.5"
                data-power-up-key-set={saved ? '' : undefined}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (complete) void save();
                  else setCheck({ kind: 'error', failure: 'missing' });
                }}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null) && complete && check.kind !== 'checking') void save();
                }}
              >
                {provider === 'jev' ? (
                  <KeyField
                    className="w-full"
                    caption="Key"
                    label="TypeSafe API key"
                    value={apiKey}
                    onChange={setApiKey}
                    secret
                    flagged={check.kind === 'error' && (check.failure === 'refused' || (check.failure === 'missing' && !apiKey))}
                    saved={saved}
                    onFocus={() => setEditing(true)}
                  />
                ) : (
                  <>
                    <KeyField
                      className="w-[78px] shrink-0"
                      caption="ID"
                      label="Cloudflare account ID"
                      value={accountId}
                      onChange={setAccountId}
                      secret={false}
                      flagged={check.kind === 'error' && check.failure === 'missing' && !accountId}
                      saved={saved}
                      onFocus={() => setEditing(true)}
                    />
                    <KeyField
                      className="min-w-0 flex-1"
                      caption="Token"
                      label="Workers AI token"
                      value={apiToken}
                      onChange={setApiToken}
                      secret
                      flagged={check.kind === 'error' && (check.failure === 'refused' || (check.failure === 'missing' && !apiToken))}
                      saved={saved}
                      onFocus={() => setEditing(true)}
                    />
                  </>
                )}
                <button type="submit" className="sr-only" tabIndex={-1} disabled={check.kind === 'checking'}>
                  Check and save
                </button>
              </form>
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
