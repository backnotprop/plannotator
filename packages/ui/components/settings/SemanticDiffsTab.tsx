import React, { useCallback, useEffect, useState } from 'react';
import { configStore, useConfigValue } from '../../config';
import { AnalysisLayerToggle } from '../AnalysisLayerToggle';

type Failure = 'missing' | 'refused' | 'noCredit' | 'noAnswer';
type Check = { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok'; ms: number } | { kind: 'error'; failure: Failure };

const ROUTE = '/api/sem-diff/opinion/settings';
export const POWER_UP_CHANGED_EVENT = 'plannotator:power-up-changed';
export const POWER_UP_PROVIDER_NAMES = { jev: 'Jev', clef: 'Clef', openai: 'OpenAI Decisions' } as const;
export type PowerUpProvider = keyof typeof POWER_UP_PROVIDER_NAMES;
type Provider = PowerUpProvider;
const PROVIDER_NAME = POWER_UP_PROVIDER_NAMES;
const PROVIDER_SETTINGS = {
  jev: { title: 'Jev key', credential: 'a Jev key', label: 'TypeSafe API key', hint: 'Paste the key from your TypeSafe account', modelHint: 'Jev runs on your TypeSafe account.' },
  clef: { title: 'Workers AI', credential: 'a Clef token', label: 'Workers AI token', hint: 'Your Cloudflare account ID and a Workers AI token', modelHint: 'Clef runs on your Cloudflare account.' },
  openai: { title: 'OpenAI key', credential: 'an OpenAI API key', label: 'OpenAI API key', hint: 'Paste an OpenAI project API key', modelHint: 'OpenAI Decisions runs on your OpenAI API project.' },
} satisfies Record<Provider, { title: string; credential: string; label: string; hint: string; modelHint: string }>;

function failureText(provider: Provider, failure: Failure): string {
  const name = PROVIDER_NAME[provider];
  if (failure === 'missing') return `Add your ${PROVIDER_SETTINGS[provider].label}`;
  if (failure === 'refused') return `${name} refused this ${provider === 'clef' ? 'token' : 'key'}`;
  if (failure === 'noCredit') return `No credit left on this ${name} account`;
  return `${name} did not answer. Try again in a moment.`;
}

const KEY_MESSAGE_ID = 'power-up-key-message';

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
        aria-describedby={message ? KEY_MESSAGE_ID : undefined}
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
  const semanticDiffEnabled = useConfigValue('semanticDiffEnabled');
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
  const fields = PROVIDER_SETTINGS[provider];
  const usesToken = provider === 'clef';

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
    const body = usesToken ? { provider, accountId, apiToken } : { provider, apiKey };
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
    try {
      const res = await fetch(ROUTE, { method: 'DELETE' });
      if (!res.ok || !(await res.json()).ok) throw new Error('Could not remove key');
    } catch {
      setCheck({ kind: 'error', failure: 'noAnswer' });
      return;
    }
    setConfigured(false);
    setSavedProvider(null);
    setEditing(true);
    setCheck({ kind: 'idle' });
    changed();
  };

  const saved = configured && savedProvider === provider && (!editing || (usesToken ? !accountId && !apiToken : !apiKey));
  const failure = check.kind === 'error' ? check.failure : null;
  const fieldMessage =
    failure === 'refused' || failure === 'noCredit'
      ? failureText(provider, failure)
      : failure === 'missing'
        ? !usesToken
          ? failureText(provider, failure)
          : !accountId
            ? 'Add your account ID'
            : 'Add your token'
        : null;
  const complete = usesToken ? accountId.trim() !== '' && apiToken.trim() !== '' : apiKey.trim() !== '';
  return (
    <div className="space-y-4" data-semantic-diffs-settings="">
      <div>
        <div className="text-sm font-semibold">Semantic diffs</div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Labels what each change really is: moved, renamed, reformatted, extracted.</p>
      </div>
      <AnalysisLayerToggle
        checked={semantic && semanticDiffEnabled}
        disabled={!semanticDiffEnabled}
        onChange={(on) => configStore.set('diffSemantic', on)}
        label="Show moved & renamed code"
        description={semanticDiffEnabled
          ? 'Draw moved, renamed, reformatted, extracted and inlined code as what it is.'
          : 'Off while Semantic changes is off in Settings › Analysis.'}
      />
      <div data-power-up-settings="">
        <div className="border-t border-border pt-3">
          <AnalysisLayerToggle
            checked={powerUp && configured}
            disabled={!configured || !semantic || !semanticDiffEnabled}
            onChange={(on) => configStore.set('diffPowerUp', on)}
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
                  ? `${PROVIDER_NAME[savedProvider]} keeps powering up until ${fields.credential} works.`
                  : fields.modelHint
              }
            >
              <Segmented
                label="Model"
                value={provider}
                options={[['jev', PROVIDER_NAME.jev], ['clef', PROVIDER_NAME.clef], ['openai', PROVIDER_NAME.openai]]}
                onChange={(v) => {
                  if (v === provider || check.kind === 'checking') return;
                  setProvider(v);
                  setApiKey('');
                  setAccountId('');
                  setApiToken('');
                  setEditing(true);
                  setCheck({ kind: 'idle' });
                }}
              />
            </Row>
            <Row
              title={fields.title}
              hint={
                check.kind === 'ok' ? (
                  `✓ Key works · ${check.ms} ms`
                ) : check.kind === 'error' && check.failure === 'noAnswer' ? (
                  <span className="text-warning" data-power-up-key-failure="noAnswer">{failureText(provider, check.failure)}</span>
                ) : check.kind === 'checking' ? (
                  'Checking…'
                ) : saved ? (
                  'Kept on this computer'
                ) : (
                  fields.hint
                )
              }
            >
              <form
                className={`flex flex-col gap-1 ${usesToken ? 'w-[340px]' : 'w-[280px]'}`}
                data-power-up-key-set={saved ? '' : undefined}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (check.kind === 'checking') return;
                  if (complete) void save();
                  else setCheck({ kind: 'error', failure: 'missing' });
                }}
                onBlur={(e) => {
                  if (provider !== 'openai' && !e.currentTarget.contains(e.relatedTarget as Node | null) && complete && check.kind !== 'checking') void save();
                }}
              >
                <span className="flex items-start gap-1.5">
                  {!usesToken ? (
                    <KeyField
                      className="w-full"
                      label={fields.label}
                      value={apiKey}
                      onChange={setApiKey}
                      secret
                      flagged={failure === 'refused' || failure === 'noCredit' || (failure === 'missing' && !apiKey)}
                      message={failure === 'refused' || failure === 'noCredit' || (failure === 'missing' && !apiKey) ? failureText(provider, failure) : undefined}
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
                  <span className="flex shrink-0 flex-col gap-1">
                    {usesToken && <span aria-hidden="true" className="invisible text-xs font-medium">Token</span>}
                    <button
                      type="submit"
                      className="h-7 shrink-0 whitespace-nowrap rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                      disabled={check.kind === 'checking' || (saved && !complete)}
                      data-power-up-key-save=""
                    >
                      {check.kind === 'checking' ? 'Checking…' : saved && !complete ? 'Saved' : 'Check and save'}
                    </button>
                  </span>
                  {saved && !complete && (
                    <button
                      type="button"
                      className="h-7 shrink-0 whitespace-nowrap rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => void remove()}
                      data-power-up-key-remove=""
                    >
                      Remove
                    </button>
                  )}
                </span>
                {fieldMessage && (
                  <span id={KEY_MESSAGE_ID} className="text-xs text-warning" data-power-up-key-failure="">
                    {fieldMessage}
                  </span>
                )}
              </form>
            </Row>
            <Row title="Motion" hint="Stream moves the bands slowly. It is experimental: it costs some smoothness while you scroll. Both follow your system's reduce-motion setting.">
              <Segmented label="Motion" value={motion} options={[['still', 'Still'], ['stream', 'Stream']]} onChange={(v) => configStore.set('diffPowerUpMotion', v)} />
            </Row>
            <p className="pt-1 text-xs text-muted-foreground">
              Your key, your account; code is sent to {PROVIDER_NAME[savedProvider ?? provider]}. Only the functions the engine asks about are sent, never the rest of the repository.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
