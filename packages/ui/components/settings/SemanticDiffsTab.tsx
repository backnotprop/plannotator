import React, { useCallback, useEffect, useState } from 'react';
import { configStore, useConfigValue } from '../../config';
import { AnalysisLayerToggle } from '../AnalysisLayerToggle';

type AuthScheme = 'bearer' | 'api-key';
type Failure = 'missing' | 'invalidUrl' | 'refused' | 'noCredit' | 'noAnswer';
type Check =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; ms: number }
  | { kind: 'error'; failure: Failure };

type SettingsData = {
  configured: boolean;
  provider: Provider | null;
  source?: 'env';
  url?: string;
  endpoint?: string;
  model?: string;
  auth?: AuthScheme;
};

interface FormInputs {
  apiKey: string;
  accountId: string;
  apiToken: string;
  customUrl: string;
  customModel: string;
  customAuth: AuthScheme;
}

interface PowerUpFormProps {
  provider: Provider;
  savedProvider: Provider | null;
  configured: boolean;
  activeEndpoint: string | null;
  savedEndpoint: string | null;
  activeModel: string | null;
  check: Check;
  saved: boolean;
  complete: boolean;
  failure: Failure | null;
  fieldMessage: string | null;
  inputs: FormInputs;
  onInput: (patch: Partial<FormInputs>) => void;
  onSelectProvider: (v: Provider) => void;
  onFocus: () => void;
  onSave: () => void;
  onMissing: () => void;
  onRemove: () => void;
}

type CustomInputs = Pick<FormInputs, 'customUrl' | 'customModel' | 'customAuth'>;

const EMPTY_CUSTOM: CustomInputs = { customUrl: '', customModel: '', customAuth: 'bearer' };

const EMPTY_INPUTS: FormInputs = { apiKey: '', accountId: '', apiToken: '', ...EMPTY_CUSTOM };

const ROUTE = '/api/sem-diff/opinion/settings';
export const POWER_UP_CHANGED_EVENT = 'plannotator:power-up-changed';
export const POWER_UP_PROVIDER_NAMES = { jev: 'Jev', clef: 'Clef', openai: 'OpenAI Decisions', custom: 'Custom' } as const;
export type PowerUpProvider = keyof typeof POWER_UP_PROVIDER_NAMES;
type Provider = PowerUpProvider;
const PROVIDER_NAME = POWER_UP_PROVIDER_NAMES;
const PROVIDER_SETTINGS = {
  jev: { title: 'Jev key', credential: 'a Jev key', label: 'TypeSafe API key', hint: 'Paste the key from your TypeSafe account', modelHint: 'Jev runs on your TypeSafe account.' },
  clef: { title: 'Workers AI', credential: 'a Clef token', label: 'Workers AI token', hint: 'Your Cloudflare account ID and a Workers AI token', modelHint: 'Clef runs on your Cloudflare account.' },
  openai: { title: 'OpenAI key', credential: 'an OpenAI API key', label: 'OpenAI API key', hint: 'Paste an OpenAI project API key', modelHint: 'OpenAI Decisions runs on your OpenAI API project.' },
  custom: { title: 'Custom endpoint', credential: 'a custom endpoint key', label: 'Custom API key', hint: 'Endpoint URL, optional model, auth header, and API key', modelHint: 'Your own server, if it speaks the same API as Jev.' },
} satisfies Record<Provider, { title: string; credential: string; label: string; hint: string; modelHint: string }>;
const KEY_MESSAGE_ID = 'power-up-key-message';

/** Jev and Custom speak the systemone contract, so only they go to an endpoint the person chose. */
function takesEndpoint(provider: Provider): boolean {
  return provider === 'jev' || provider === 'custom';
}

function hostOf(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : null;
  } catch {
    return null;
  }
}

function activeEndpointFor(
  provider: Provider,
  savedProvider: Provider | null,
  endpoint: string | null,
  customUrl: string,
): string | null {
  if (!takesEndpoint(provider)) return null;
  if (provider === 'custom') return hostOf(customUrl) ?? (savedProvider === 'custom' ? endpoint : null);
  return savedProvider === 'custom' ? null : endpoint;
}

function activeModelFor(
  provider: Provider,
  savedProvider: Provider | null,
  modelName: string | null,
  customModel: string,
): string | null {
  if (provider === 'custom') return customModel.trim() || null;
  if (provider !== 'jev') return null;
  return savedProvider === 'custom' ? null : modelName;
}

function targetName(provider: Provider, endpoint: string | null): string {
  if (takesEndpoint(provider) && endpoint) return endpoint;
  return PROVIDER_NAME[provider];
}

function footerTarget(provider: Provider, endpoint: string | null): string {
  if (provider === 'custom' && !endpoint) return 'your custom endpoint';
  return targetName(provider, endpoint);
}

function addKeyHint(provider: Provider, endpoint: string | null): string {
  if (!takesEndpoint(provider) || !endpoint) return PROVIDER_SETTINGS[provider].hint;
  return provider === 'custom' ? `Key and auth for ${endpoint}` : `Paste the key for ${endpoint}`;
}

function missingKeyText(provider: Provider, endpoint: string | null): string {
  if (provider === 'custom' || (provider === 'jev' && endpoint)) return 'Add your API key';
  return `Add your ${PROVIDER_SETTINGS[provider].label}`;
}

function failureText(provider: Provider, failure: Failure, endpoint: string | null): string {
  const name = targetName(provider, endpoint);
  if (failure === 'missing') return missingKeyText(provider, endpoint);
  if (failure === 'invalidUrl') return 'Enter an http or https endpoint URL';
  if (failure === 'refused') return `${name} refused this ${provider === 'clef' ? 'token' : 'key'}`;
  if (failure === 'noCredit') return `No credit left on this ${name} account`;
  return `${name} did not answer. Try again in a moment.`;
}

function customTargetSummary(endpoint: string | null, model: string | null): string | null {
  if (!endpoint && !model) return null;
  const host = endpoint ?? 'Jev';
  return model ? `${host} · ${model}` : host;
}

function nextKeyLabel(provider: Provider, endpoint: string | null): string {
  if (takesEndpoint(provider) && endpoint) return `a key for ${endpoint}`;
  return PROVIDER_SETTINGS[provider].credential;
}

function providerDefaultHint(provider: Provider, endpoint: string | null, model: string | null): string {
  const fallback = PROVIDER_SETTINGS[provider].modelHint;
  if (!takesEndpoint(provider)) return fallback;
  return customTargetSummary(endpoint, model) ?? fallback;
}

function modelRowHint(form: PowerUpFormProps): string {
  if (form.configured && form.savedProvider && form.savedProvider !== form.provider) {
    const active = targetName(form.savedProvider, form.savedEndpoint);
    return `${active} keeps powering up until ${nextKeyLabel(form.provider, form.activeEndpoint)} works.`;
  }
  return providerDefaultHint(form.provider, form.activeEndpoint, form.activeModel);
}

function isKeyFieldFlagged(failure: Failure | null, empty: boolean): boolean {
  return failure === 'refused' || failure === 'noCredit' || (failure === 'missing' && empty);
}

function saveButtonLabel(checking: boolean, saved: boolean, complete: boolean): string {
  if (checking) return 'Checking…';
  return saved && !complete ? 'Saved' : 'Check and save';
}

function areInputsEmpty(provider: Provider, inputs: FormInputs): boolean {
  if (provider === 'clef') return !inputs.accountId && !inputs.apiToken;
  return !inputs.apiKey;
}

function areInputsComplete(provider: Provider, inputs: FormInputs): boolean {
  if (provider === 'clef') return inputs.accountId.trim() !== '' && inputs.apiToken.trim() !== '';
  if (provider === 'custom') return inputs.customUrl.trim() !== '' && inputs.apiKey.trim() !== '';
  return inputs.apiKey.trim() !== '';
}

function missingFieldMessage(provider: Provider, endpoint: string | null, inputs: FormInputs): string {
  if (provider === 'clef') return inputs.accountId.trim() ? 'Add your token' : 'Add your account ID';
  if (provider === 'custom') return inputs.customUrl.trim() ? 'Add your API key' : 'Add an endpoint URL';
  return missingKeyText(provider, endpoint);
}

function fieldFailureMessage(
  provider: Provider,
  failure: Failure | null,
  endpoint: string | null,
  inputs: FormInputs,
): string | null {
  if (!failure || failure === 'noAnswer') return null;
  if (failure === 'missing') return missingFieldMessage(provider, endpoint, inputs);
  return failureText(provider, failure, endpoint);
}

function buildSaveBody(provider: Provider, inputs: FormInputs): Record<string, string> {
  if (provider === 'jev' || provider === 'openai') return { provider, apiKey: inputs.apiKey };
  if (provider === 'clef') return { provider, accountId: inputs.accountId, apiToken: inputs.apiToken };
  const model = inputs.customModel.trim();
  const body: Record<string, string> = {
    provider,
    url: inputs.customUrl.trim(),
    auth: inputs.customAuth,
    apiKey: inputs.apiKey,
  };
  if (model) body.model = model;
  return body;
}

function rowTitle(provider: Provider, endpoint: string | null): string {
  if (provider === 'jev' && endpoint) return 'API key';
  return PROVIDER_SETTINGS[provider].title;
}

function keyRowHint(
  check: Check,
  provider: Provider,
  endpoint: string | null,
  saved: boolean,
): React.ReactNode {
  if (check.kind === 'ok') return `✓ Key works · ${check.ms} ms`;
  if (check.kind === 'error' && check.failure === 'noAnswer') {
    return (
      <span className="text-warning" data-power-up-key-failure="noAnswer">
        {failureText(provider, check.failure, endpoint)}
      </span>
    );
  }
  if (check.kind === 'checking') return 'Checking…';
  return saved ? 'Kept on this computer' : addKeyHint(provider, endpoint);
}

const INPUT_BASE = 'h-7 w-full min-w-0 rounded-md border bg-background px-2 font-mono text-xs outline-none';
const INPUT_RING = 'border-border focus:ring-1 focus:ring-ring';
const INPUT_WARN = 'border-warning ring-1 ring-warning focus:ring-2 focus:ring-warning';

function KeyField({
  caption,
  label,
  value,
  onChange,
  secret,
  flagged,
  message,
  saved,
  placeholder,
  onFocus,
  className,
}: {
  caption?: string;
  message?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret: boolean;
  flagged: boolean;
  saved: boolean;
  placeholder?: string;
  onFocus: () => void;
  className: string;
}) {
  const hint = placeholder ?? (saved ? '••••••••' : '');
  const ringClass = flagged ? INPUT_WARN : INPUT_RING;
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      {caption && <span className="text-xs font-medium text-foreground">{caption}</span>}
      <input
        className={`${INPUT_BASE} ${ringClass}`}
        style={flagged ? { outlineColor: 'var(--warning)' } : undefined}
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        placeholder={hint}
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

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}) {
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
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{hint}</div>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

const ACTION_BTN =
  'h-7 shrink-0 whitespace-nowrap rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground';

function SaveActions({
  checking,
  saved,
  complete,
  showRemove,
  onRemove,
}: {
  checking: boolean;
  saved: boolean;
  complete: boolean;
  showRemove: boolean;
  onRemove: () => void;
}) {
  return (
    <>
      <button
        type="submit"
        className={`${ACTION_BTN} disabled:hover:bg-transparent disabled:hover:text-muted-foreground`}
        disabled={checking || showRemove}
        data-power-up-key-save=""
      >
        {saveButtonLabel(checking, saved, complete)}
      </button>
      {showRemove && (
        <button type="button" className={ACTION_BTN} onClick={onRemove} data-power-up-key-remove="">
          Remove
        </button>
      )}
    </>
  );
}

function EnvProviderRows({ endpoint, modelName }: { endpoint: string | null; modelName: string | null }) {
  const summary = customTargetSummary(endpoint, modelName) ?? 'Jev';
  return (
    <>
      <Row title="Model" hint={`${summary} · configured via environment`} />
      <Row title={rowTitle('jev', endpoint)} hint="Provided by PLANNOTATOR_OPINION_API_KEY" />
    </>
  );
}

function ApiKeyFields({ form, checking, showRemove }: { form: PowerUpFormProps; checking: boolean; showRemove: boolean }) {
  const flagged = isKeyFieldFlagged(form.failure, !form.inputs.apiKey);
  return (
    <span className="flex items-end gap-1.5">
      <KeyField
        className="w-full"
        label={form.provider === 'jev' && form.activeEndpoint ? 'API key' : PROVIDER_SETTINGS[form.provider].label}
        value={form.inputs.apiKey}
        onChange={(apiKey) => form.onInput({ apiKey })}
        secret
        flagged={flagged}
        message={flagged ? form.fieldMessage ?? undefined : undefined}
        saved={form.saved}
        onFocus={form.onFocus}
      />
      <SaveActions checking={checking} saved={form.saved} complete={form.complete} showRemove={showRemove} onRemove={form.onRemove} />
    </span>
  );
}

function ClefKeyFields({ form, checking, showRemove }: { form: PowerUpFormProps; checking: boolean; showRemove: boolean }) {
  const missingAccount = form.failure === 'missing' && !form.inputs.accountId;
  const tokenFlagged = isKeyFieldFlagged(form.failure, !form.inputs.apiToken);
  return (
    <span className="flex items-end gap-1.5">
      <KeyField
        className="w-[96px] shrink-0"
        caption="Account ID"
        label="Cloudflare account ID"
        value={form.inputs.accountId}
        onChange={(accountId) => form.onInput({ accountId })}
        secret={false}
        flagged={missingAccount}
        message={missingAccount ? 'Add your account ID' : undefined}
        saved={form.saved}
        onFocus={form.onFocus}
      />
      <KeyField
        className="min-w-0 flex-1"
        caption="Token"
        label="Workers AI token"
        value={form.inputs.apiToken}
        onChange={(apiToken) => form.onInput({ apiToken })}
        secret
        flagged={tokenFlagged}
        message={tokenFlagged ? form.fieldMessage ?? undefined : undefined}
        saved={form.saved}
        onFocus={form.onFocus}
      />
      <SaveActions checking={checking} saved={form.saved} complete={form.complete} showRemove={showRemove} onRemove={form.onRemove} />
    </span>
  );
}

function CustomKeyFields({ form, checking, showRemove }: { form: PowerUpFormProps; checking: boolean; showRemove: boolean }) {
  const urlFlagged = form.failure === 'invalidUrl' || (form.failure === 'missing' && !form.inputs.customUrl.trim());
  const keyFlagged = isKeyFieldFlagged(form.failure, !form.inputs.apiKey.trim());
  return (
    <div className="flex flex-col gap-2">
      <KeyField
        className="w-full"
        caption="Endpoint URL"
        label="Custom endpoint URL"
        value={form.inputs.customUrl}
        onChange={(customUrl) => form.onInput({ customUrl })}
        secret={false}
        flagged={urlFlagged}
        message={urlFlagged ? form.fieldMessage ?? undefined : undefined}
        saved={false}
        placeholder="https://..."
        onFocus={form.onFocus}
      />
      <span className="flex items-end gap-1.5">
        <KeyField
          className="min-w-0 flex-1"
          caption="Model (optional)"
          label="Custom model"
          value={form.inputs.customModel}
          onChange={(customModel) => form.onInput({ customModel })}
          secret={false}
          flagged={false}
          saved={false}
          placeholder="jev-1.14.0"
          onFocus={form.onFocus}
        />
        <span className="flex shrink-0 flex-col gap-1">
          <span className="text-xs font-medium text-foreground">Auth</span>
          <Segmented
            label="Auth header"
            value={form.inputs.customAuth}
            options={[['bearer', 'Bearer'], ['api-key', 'Api-Key']]}
            onChange={(customAuth) => form.onInput({ customAuth })}
          />
        </span>
      </span>
      <span className="flex items-end gap-1.5">
        <KeyField
          className="min-w-0 flex-1"
          caption="API key"
          label="Custom API key"
          value={form.inputs.apiKey}
          onChange={(apiKey) => form.onInput({ apiKey })}
          secret
          flagged={keyFlagged}
          message={keyFlagged ? form.fieldMessage ?? undefined : undefined}
          saved={form.saved}
          onFocus={form.onFocus}
        />
        <SaveActions checking={checking} saved={form.saved} complete={form.complete} showRemove={showRemove} onRemove={form.onRemove} />
      </span>
    </div>
  );
}

function ProviderFields({ form, checking, showRemove }: { form: PowerUpFormProps; checking: boolean; showRemove: boolean }) {
  if (form.provider === 'custom') return <CustomKeyFields form={form} checking={checking} showRemove={showRemove} />;
  if (form.provider === 'clef') return <ClefKeyFields form={form} checking={checking} showRemove={showRemove} />;
  return <ApiKeyFields form={form} checking={checking} showRemove={showRemove} />;
}

/** OpenAI saves only on "Check and save"; Custom has optional fields and an auth toggle inside the form. */
function savesOnBlur(provider: Provider): boolean {
  return provider === 'jev' || provider === 'clef';
}

function ManualProviderRows({ form }: { form: PowerUpFormProps }) {
  const checking = form.check.kind === 'checking';
  const showRemove = form.saved && !form.complete;
  const wide = form.provider === 'clef' || form.provider === 'custom';
  return (
    <>
      <Row title="Model" hint={modelRowHint(form)}>
        <Segmented
          label="Model"
          value={form.provider}
          options={[
            ['jev', PROVIDER_NAME.jev],
            ['clef', PROVIDER_NAME.clef],
            ['openai', PROVIDER_NAME.openai],
            ['custom', PROVIDER_NAME.custom],
          ]}
          onChange={form.onSelectProvider}
        />
      </Row>
      <Row
        title={rowTitle(form.provider, form.activeEndpoint)}
        hint={keyRowHint(form.check, form.provider, form.activeEndpoint, form.saved)}
      >
        <form
          className={`flex flex-col gap-1 ${wide ? 'w-[340px]' : 'w-[280px]'}`}
          data-power-up-key-set={form.saved ? '' : undefined}
          onSubmit={(e) => {
            e.preventDefault();
            if (checking) return;
            if (form.complete) form.onSave();
            else form.onMissing();
          }}
          onBlur={(e) => {
            if (savesOnBlur(form.provider) && !e.currentTarget.contains(e.relatedTarget as Node | null) && form.complete && !checking) {
              form.onSave();
            }
          }}
        >
          <ProviderFields form={form} checking={checking} showRemove={showRemove} />
          {form.fieldMessage && (
            <span id={KEY_MESSAGE_ID} className="text-xs text-warning" data-power-up-key-failure="">
              {form.fieldMessage}
            </span>
          )}
        </form>
      </Row>
    </>
  );
}

function PowerUpSection({
  available,
  envConfigured,
  motion,
  form,
}: {
  available: boolean | null;
  envConfigured: boolean;
  motion: 'still' | 'stream';
  form: PowerUpFormProps;
}) {
  if (available === false) {
    return <Row title="Model" hint="This review host cannot keep a key." />;
  }
  return (
    <>
      {envConfigured ? (
        <EnvProviderRows endpoint={form.activeEndpoint} modelName={form.activeModel} />
      ) : (
        <ManualProviderRows form={form} />
      )}
      <Row
        title="Motion"
        hint="Stream moves the bands slowly. It is experimental: it costs some smoothness while you scroll. Both follow your system's reduce-motion setting."
      >
        <Segmented
          label="Motion"
          value={motion}
          options={[['still', 'Still'], ['stream', 'Stream']]}
          onChange={(v) => configStore.set('diffPowerUpMotion', v)}
        />
      </Row>
      <p className="pt-1 text-xs text-muted-foreground">
        Your key, your account; code is sent to {form.savedProvider
          ? footerTarget(form.savedProvider, form.savedEndpoint)
          : footerTarget(form.provider, form.activeEndpoint)}. Only the functions the engine asks about are sent, never the rest of the repository.
      </p>
    </>
  );
}

function powerUpDescription(configured: boolean): string {
  const suffix = configured
    ? 'When it is on, every semantic diff gets that second look.'
    : 'Add a key below to turn it on.';
  return `A model takes a second look at changes the engine could not label on its own. ${suffix}`;
}

function semanticDescription(enabled: boolean): string {
  return enabled
    ? 'Draw moved, renamed, reformatted, extracted and inlined code as what it is.'
    : 'Off while Semantic changes is off in Settings › Analysis.';
}

export function SemanticDiffsTab() {
  const semantic = useConfigValue('diffSemantic');
  const semanticDiffEnabled = useConfigValue('semanticDiffEnabled');
  const powerUp = useConfigValue('diffPowerUp');
  const motion = useConfigValue('diffPowerUpMotion');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [configured, setConfigured] = useState(false);
  const [savedProvider, setSavedProvider] = useState<Provider | null>(null);
  const [envConfigured, setEnvConfigured] = useState(false);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [modelName, setModelName] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>('jev');
  const [editing, setEditing] = useState(false);
  const [inputs, setInputs] = useState<FormInputs>(EMPTY_INPUTS);
  const [check, setCheck] = useState<Check>({ kind: 'idle' });
  // The saved Custom endpoint is not secret: it stays in its fields when the person switches models and back.
  const [savedCustom, setSavedCustom] = useState<CustomInputs>(EMPTY_CUSTOM);

  const updateInputs = useCallback((patch: Partial<FormInputs>) => {
    setInputs((prev) => ({ ...prev, ...patch }));
  }, []);

  const hydrateCustom = useCallback((data: SettingsData) => {
    if (data.provider !== 'custom') return;
    const kept: CustomInputs = {
      customUrl: data.url ?? '',
      customModel: data.model ?? '',
      customAuth: data.auth ?? 'bearer',
    };
    setSavedCustom(kept);
    updateInputs(kept);
  }, [updateInputs]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(ROUTE);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as SettingsData;
      setAvailable(true);
      setConfigured(data.configured);
      setSavedProvider(data.provider);
      setEnvConfigured(data.source === 'env');
      setEndpoint(data.endpoint ?? null);
      setModelName(data.model ?? null);
      if (data.provider) setProvider(data.provider);
      hydrateCustom(data);
      setEditing(!data.configured);
    } catch {
      setAvailable(false);
    }
  }, [hydrateCustom]);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = () => window.dispatchEvent(new Event(POWER_UP_CHANGED_EVENT));

  const syncSavedMetadata = (nextProvider: Provider) => {
    if (nextProvider === 'custom') {
      setEndpoint(hostOf(inputs.customUrl) ?? endpoint);
      setModelName(inputs.customModel.trim() || null);
      return;
    }
    if (savedProvider === 'custom') {
      setEndpoint(null);
      setModelName(null);
    }
  };

  const save = async () => {
    setCheck({ kind: 'checking' });
    const body = buildSaveBody(provider, inputs);
    try {
      const res = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const reply = (await res.json()) as { ok: true; ms: number } | { ok: false; failure?: Failure };
      updateInputs({ apiKey: '', apiToken: '' });
      if (reply.ok === false) {
        setCheck({ kind: 'error', failure: reply.failure ?? 'noAnswer' });
        return;
      }
      setCheck({ kind: 'ok', ms: reply.ms });
      updateInputs({ accountId: '' });
      if (provider === 'custom') {
        setSavedCustom({ customUrl: inputs.customUrl.trim(), customModel: inputs.customModel.trim(), customAuth: inputs.customAuth });
      }
      syncSavedMetadata(provider);
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
    if (savedProvider === 'custom') {
      setEndpoint(null);
      setModelName(null);
      setSavedCustom(EMPTY_CUSTOM);
    }
    setSavedProvider(null);
    setEditing(true);
    setCheck({ kind: 'idle' });
    changed();
  };

  const activeEndpoint = activeEndpointFor(provider, savedProvider, endpoint, inputs.customUrl);
  const activeModel = activeModelFor(provider, savedProvider, modelName, inputs.customModel);
  const saved = configured && savedProvider === provider && (!editing || areInputsEmpty(provider, inputs));
  const failure = check.kind === 'error' ? check.failure : null;
  const form: PowerUpFormProps = {
    provider,
    savedProvider,
    configured,
    activeEndpoint,
    savedEndpoint: endpoint,
    activeModel,
    check,
    saved,
    complete: areInputsComplete(provider, inputs),
    failure,
    fieldMessage: fieldFailureMessage(provider, failure, activeEndpoint, inputs),
    inputs,
    onInput: updateInputs,
    onSelectProvider: (next) => {
      if (next === provider || check.kind === 'checking') return;
      setProvider(next);
      // What was typed for one model never carries over to another; a saved Custom endpoint comes back.
      setInputs({ ...EMPTY_INPUTS, ...savedCustom });
      setEditing(true);
      setCheck({ kind: 'idle' });
    },
    onFocus: () => setEditing(true),
    onSave: () => void save(),
    onMissing: () => setCheck({ kind: 'error', failure: 'missing' }),
    onRemove: () => void remove(),
  };

  return (
    <div className="space-y-4" data-semantic-diffs-settings="">
      <div>
        <div className="text-sm font-semibold">Semantic diffs</div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Labels what each change really is: moved, renamed, reformatted, extracted.
        </p>
      </div>
      <AnalysisLayerToggle
        checked={semantic && semanticDiffEnabled}
        disabled={!semanticDiffEnabled}
        onChange={(on) => configStore.set('diffSemantic', on)}
        label="Show moved & renamed code"
        description={semanticDescription(semanticDiffEnabled)}
      />
      <div data-power-up-settings="">
        <div className="border-t border-border pt-3">
          <AnalysisLayerToggle
            checked={powerUp && configured}
            disabled={!configured || !semantic || !semanticDiffEnabled}
            onChange={(on) => configStore.set('diffPowerUp', on)}
            label="Power Up"
            description={powerUpDescription(configured)}
          />
        </div>
        <PowerUpSection available={available} envConfigured={envConfigured} motion={motion} form={form} />
      </div>
    </div>
  );
}
