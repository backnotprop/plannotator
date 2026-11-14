import React, { useCallback, useEffect, useState } from 'react';
import { configStore, useConfigValue } from '../../config';
import { AnalysisLayerToggle } from '../AnalysisLayerToggle';

type Provider = 'jev' | 'clef';
type Failure = 'missing' | 'refused' | 'noCredit' | 'noAnswer';
type Check = { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok'; ms: number } | { kind: 'error'; failure: Failure };

const ROUTE = '/api/sem-diff/opinion/settings';
export const POWER_UP_CHANGED_EVENT = 'plannotator:power-up-changed';
const PROVIDER_NAME: Record<Provider, string> = { jev: 'Jev', clef: 'Clef' };
const ADD_KEY: Record<Provider, string> = { jev: 'Paste the key from your TypeSafe account', clef: 'Your Cloudflare account ID and a Workers AI token' };

function failureText(provider: Provider, failure: Failure): string {
  const name = PROVIDER_NAME[provider];
  if (failure === 'missing') return provider === 'jev' ? 'Add your TypeSafe key' : 'Add your account ID and token';
  if (failure === 'refused') return provider === 'jev' ? 'Jev refused this key' : 'Clef refused this token';
  if (failure === 'noCredit') return `No credit left on this ${name} account`;
  return `${name} did not answer. Try again in a moment.`;
}

function KeyField({ caption, label, value, onChange, secret, flagged, message, saved, onFocus, className }: {
  caption?: string;
  message?: string;
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
    <label className={`flex flex-col gap-1 ${className}`}>
      {caption && <span className="text-xs font-medium text-foreground">{caption}</span>}
      <input
        className={`h-7 w-full min-w-0 rounded-md border bg-background px-2 font-mono text-xs outline-none ${flagged ? 'border-warning ring-1 ring-warning focus:ring-2 focus:ring-warning' : 'border-border focus:ring-1 focus:ring-ring'}`}
        style={flagged ? { outlineColor: 'var(--warning)' } : undefined}
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        placeholder={saved ? '••••••••' : ''}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        aria-label={label}
        aria-invalid={flagged || undefined}
        aria-describedby={message ? `${label.replace(/\W+/g, '-')}-message` : undefined}
      />
      {message && (
        <span id={`${label.replace(/\W+/g, '-')}-message`} className="text-xs text-warning" data-power-up-key-failure="">
          {message}
        </span>
      )}
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
  const failure = check.kind === 'error' ? check.failure : null;
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
        <div className="border-t border-border pt-3">
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
                ? 'A model takes a second look at changes the engine could not label on its own. When it is on, every semantic diff gets that second look.'
                : 'A model takes a second look at changes the engine could not label on its own. Add a key below to turn it on.'
            }
          />
        </div>
        {available === false ? (
          <Row title="Model" hint="This review host cannot keep a key." />
        ) : (
          <>
            <Row
              title="Model"
              hint={
                configured && savedProvider && savedProvider !== provider
                  ? `${PROVIDER_NAME[savedProvider]} keeps powering up until ${provider === 'clef' ? 'a Clef token' : 'a Jev key'} works.`
                  : provider === 'jev'
                    ? 'Jev is the faster one, about 0.2 s a file.'
                    : 'Clef runs on your Cloudflare account.'
              }
            >
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
              title={provider === 'jev' ? 'TypeSafe key' : 'Workers AI'}
              hint={
                check.kind === 'ok' ? (
                  `✓ Key works · ${check.ms} ms`
                ) : check.kind === 'error' && check.failure === 'noAnswer' ? (
                  <span className="text-warning" data-power-up-key-failure="noAnswer">{failureText(provider, check.failure)}</span>
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
                className="flex w-[250px] items-start gap-1.5"
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
                    label="TypeSafe API key"
                    value={apiKey}
                    onChange={setApiKey}
                    secret
                    flagged={failure === 'refused' || failure === 'noCredit' || (failure === 'missing' && !apiKey)}
                    message={failure === 'refused' || failure === 'noCredit' || (failure === 'missing' && !apiKey) ? failureText('jev', failure) : undefined}
                    saved={saved}
                    onFocus={() => setEditing(true)}
                  />
                ) : (
                  <>
                    <KeyField
                      className="w-[96px] shrink-0"
                      caption="Account ID"
                      label="Cloudflare account ID"
                      value={accountId}
                      onChange={setAccountId}
                      secret={false}
                      flagged={failure === 'missing' && !accountId}
                      message={failure === 'missing' && !accountId ? 'Add your account ID' : undefined}
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
                      flagged={failure === 'refused' || failure === 'noCredit' || (failure === 'missing' && !apiToken)}
                      message={failure === 'refused' || failure === 'noCredit' ? failureText('clef', failure) : failure === 'missing' && !apiToken ? 'Add your token' : undefined}
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
            <Row title="Motion" hint="Stream moves the bands slowly. It is experimental: it costs some smoothness while you scroll. Both follow your system's reduce-motion setting.">
              <Segmented label="Motion" value={motion} options={[['still', 'Still'], ['stream', 'Stream']]} onChange={(v) => configStore.set('diffPowerUpMotion', v)} />
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
