/**
 * Power Up's rows on Settings → Reviews: the model (provider) form, its key
 * check, Motion and the sentence about what is sent. Moved from the former
 * Semantic diffs tab (`SemanticDiffsTab`) unchanged in behaviour; the opinion
 * settings route, every control and the setting writer come from the host.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { writeReviewSettingToStore, type ReviewSettingChange, type ReviewSettingsControls } from './reviewSettingsControls';
import {
  POWER_UP_PROVIDER_NAMES,
  POWER_UP_WORDS,
  PROVIDER_SETTINGS,
  addKeyHint,
  customTargetSummary,
  failureText,
  keepsPoweringUp,
  keyWorks,
  missingKeyText,
  powerUpFooter,
  providerDefaultHint,
  rowTitle,
  saveButtonLabel,
  takesEndpoint,
  targetName,
  type PowerUpFailure,
  type PowerUpProvider,
} from './reviewSettingsWords';

export { POWER_UP_PROVIDER_NAMES, type PowerUpProvider } from './reviewSettingsWords';

/** The route classic code review (both runtimes) answers for the key and provider. */
export const SEM_DIFF_OPINION_SETTINGS_ROUTE = '/api/sem-diff/opinion/settings';
export const POWER_UP_CHANGED_EVENT = 'plannotator:power-up-changed';

type AuthScheme = 'bearer' | 'api-key';
type Provider = PowerUpProvider;
type Failure = PowerUpFailure;
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

export interface PowerUpFormProps {
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

const KEY_MESSAGE_ID = 'power-up-key-message';

/** Sends one request to the opinion settings route. */
export type OpinionFetch = (route: string, init?: RequestInit) => Promise<Response>;

/** The window's fetch, looked up at call time (a test may stub it after this module loads). */
const windowFetch: OpinionFetch = (route, init) => fetch(route, init);

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

function modelRowHint(form: PowerUpFormProps): string {
  if (form.configured && form.savedProvider && form.savedProvider !== form.provider) {
    const active = targetName(form.savedProvider, form.savedEndpoint);
    return keepsPoweringUp(active, form.provider, form.activeEndpoint);
  }
  return providerDefaultHint(form.provider, form.activeEndpoint, form.activeModel);
}

function isKeyFieldFlagged(failure: Failure | null, empty: boolean): boolean {
  return failure === 'refused' || failure === 'noCredit' || (failure === 'missing' && empty);
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
  if (provider === 'clef') return inputs.accountId.trim() ? POWER_UP_WORDS.addToken : POWER_UP_WORDS.addAccountId;
  if (provider === 'custom') return inputs.customUrl.trim() ? POWER_UP_WORDS.addApiKey : POWER_UP_WORDS.addEndpoint;
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

function keyRowHint(
  check: Check,
  provider: Provider,
  endpoint: string | null,
  saved: boolean,
  { Note }: ReviewSettingsControls,
): React.ReactNode {
  if (check.kind === 'ok') return keyWorks(check.ms);
  if (check.kind === 'error' && check.failure === 'noAnswer') {
    return (
      <Note tone="warning" data-power-up-key-failure="noAnswer">
        {failureText(provider, check.failure, endpoint)}
      </Note>
    );
  }
  if (check.kind === 'checking') return POWER_UP_WORDS.checking;
  return saved ? POWER_UP_WORDS.keptHere : addKeyHint(provider, endpoint);
}

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
  controls,
  wrap = false,
}: {
  caption?: string;
  /** A long value (the endpoint URL) wraps so all of it stays readable. */
  wrap?: boolean;
  message?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret: boolean;
  flagged: boolean;
  saved: boolean;
  placeholder?: string;
  onFocus: () => void;
  controls: ReviewSettingsControls;
}) {
  const { Field, TextField } = controls;
  const field = (
    <TextField
      mono
      wrap={wrap}
      secret={secret}
      placeholder={placeholder ?? (saved ? '••••••••' : '')}
      value={value}
      onChange={onChange}
      onFocus={onFocus}
      label={label}
      invalid={flagged}
      describedBy={message ? KEY_MESSAGE_ID : undefined}
    />
  );
  return caption ? <Field caption={caption}>{field}</Field> : field;
}

function SaveActions({
  checking,
  saved,
  complete,
  showRemove,
  onRemove,
  controls,
}: {
  checking: boolean;
  saved: boolean;
  complete: boolean;
  showRemove: boolean;
  onRemove: () => void;
  controls: ReviewSettingsControls;
}) {
  const { Button } = controls;
  return (
    <>
      <Button type="submit" disabled={checking || showRemove} data-power-up-key-save="">
        {saveButtonLabel(checking, saved, complete)}
      </Button>
      {showRemove && (
        <Button type="button" onClick={onRemove} data-power-up-key-remove="">
          {POWER_UP_WORDS.remove}
        </Button>
      )}
    </>
  );
}

type FieldsProps = { form: PowerUpFormProps; checking: boolean; showRemove: boolean; controls: ReviewSettingsControls };

function ApiKeyFields({ form, checking, showRemove, controls }: FieldsProps) {
  const flagged = isKeyFieldFlagged(form.failure, !form.inputs.apiKey);
  return (
    <span className="flex items-end gap-1.5">
      <span className="min-w-0 flex-1">
        <KeyField
          controls={controls}
          label={form.provider === 'jev' && form.activeEndpoint ? POWER_UP_WORDS.apiKey : PROVIDER_SETTINGS[form.provider].label}
          value={form.inputs.apiKey}
          onChange={(apiKey) => form.onInput({ apiKey })}
          secret
          flagged={flagged}
          message={flagged ? form.fieldMessage ?? undefined : undefined}
          saved={form.saved}
          onFocus={form.onFocus}
        />
      </span>
      <SaveActions controls={controls} checking={checking} saved={form.saved} complete={form.complete} showRemove={showRemove} onRemove={form.onRemove} />
    </span>
  );
}

function ClefKeyFields({ form, checking, showRemove, controls }: FieldsProps) {
  const missingAccount = form.failure === 'missing' && !form.inputs.accountId;
  const tokenFlagged = isKeyFieldFlagged(form.failure, !form.inputs.apiToken);
  return (
    <span className="flex items-end gap-1.5">
      <span className="min-w-0 flex-1">
        <KeyField
          controls={controls}
          caption={POWER_UP_WORDS.accountIdCaption}
          label={POWER_UP_WORDS.accountIdLabel}
          value={form.inputs.accountId}
          onChange={(accountId) => form.onInput({ accountId })}
          secret={false}
          flagged={missingAccount}
          message={missingAccount ? POWER_UP_WORDS.addAccountId : undefined}
          saved={form.saved}
          onFocus={form.onFocus}
        />
      </span>
      <span className="min-w-0 flex-1">
        <KeyField
          controls={controls}
          caption={POWER_UP_WORDS.tokenCaption}
          label={PROVIDER_SETTINGS.clef.label}
          value={form.inputs.apiToken}
          onChange={(apiToken) => form.onInput({ apiToken })}
          secret
          flagged={tokenFlagged}
          message={tokenFlagged ? form.fieldMessage ?? undefined : undefined}
          saved={form.saved}
          onFocus={form.onFocus}
        />
      </span>
      <SaveActions controls={controls} checking={checking} saved={form.saved} complete={form.complete} showRemove={showRemove} onRemove={form.onRemove} />
    </span>
  );
}

function CustomKeyFields({ form, checking, showRemove, controls }: FieldsProps) {
  const { Segmented, Field } = controls;
  const urlFlagged = form.failure === 'invalidUrl' || (form.failure === 'missing' && !form.inputs.customUrl.trim());
  const keyFlagged = isKeyFieldFlagged(form.failure, !form.inputs.apiKey.trim());
  return (
    <div className="flex flex-col gap-2">
      <KeyField
        controls={controls}
        caption={POWER_UP_WORDS.endpointCaption}
        label={POWER_UP_WORDS.endpointLabel}
        value={form.inputs.customUrl}
        onChange={(customUrl) => form.onInput({ customUrl })}
        secret={false}
        flagged={urlFlagged}
        message={urlFlagged ? form.fieldMessage ?? undefined : undefined}
        saved={false}
        placeholder="https://..."
        onFocus={form.onFocus}
        wrap
      />
      {/* Captions on one line: the row aligns tops, and Auth's choice sits centred in a field's height. */}
      <span className="flex items-start gap-1.5">
        <span className="min-w-0 flex-1">
          <KeyField
            controls={controls}
            caption={POWER_UP_WORDS.modelCaption}
            label={POWER_UP_WORDS.modelLabel}
            value={form.inputs.customModel}
            onChange={(customModel) => form.onInput({ customModel })}
            secret={false}
            flagged={false}
            saved={false}
            placeholder="jev-1.14.0"
            onFocus={form.onFocus}
          />
        </span>
        <span className="shrink-0">
          <Field caption={POWER_UP_WORDS.authCaption} labelsControl={false}>
            <span className="flex min-h-8 items-center">
              <Segmented
                label={POWER_UP_WORDS.authLabel}
                value={form.inputs.customAuth}
                options={POWER_UP_WORDS.authOptions}
                onChange={(customAuth) => form.onInput({ customAuth })}
              />
            </span>
          </Field>
        </span>
      </span>
      <span className="flex items-end gap-1.5">
        <span className="min-w-0 flex-1">
          <KeyField
            controls={controls}
            caption={POWER_UP_WORDS.apiKey}
            label={PROVIDER_SETTINGS.custom.label}
            value={form.inputs.apiKey}
            onChange={(apiKey) => form.onInput({ apiKey })}
            secret
            flagged={keyFlagged}
            message={keyFlagged ? form.fieldMessage ?? undefined : undefined}
            saved={form.saved}
            onFocus={form.onFocus}
          />
        </span>
        <SaveActions controls={controls} checking={checking} saved={form.saved} complete={form.complete} showRemove={showRemove} onRemove={form.onRemove} />
      </span>
    </div>
  );
}

function ProviderFields(props: FieldsProps) {
  if (props.form.provider === 'custom') return <CustomKeyFields {...props} />;
  if (props.form.provider === 'clef') return <ClefKeyFields {...props} />;
  return <ApiKeyFields {...props} />;
}

/** OpenAI saves only on "Check and save"; Custom has optional fields and an auth toggle inside the form. */
function savesOnBlur(provider: Provider): boolean {
  return provider === 'jev' || provider === 'clef';
}

const PROVIDER_OPTIONS = (Object.keys(POWER_UP_PROVIDER_NAMES) as Provider[]).map((value) => ({
  value,
  label: POWER_UP_PROVIDER_NAMES[value],
}));

function ManualProviderRows({ form, controls }: { form: PowerUpFormProps; controls: ReviewSettingsControls }) {
  const { Row, Segmented, Note } = controls;
  const checking = form.check.kind === 'checking';
  const showRemove = form.saved && !form.complete;
  return (
    <>
      <Row title={POWER_UP_WORDS.model} hint={modelRowHint(form)}>
        <Segmented label={POWER_UP_WORDS.model} value={form.provider} options={PROVIDER_OPTIONS} onChange={form.onSelectProvider} />
      </Row>
      {/* The key form is wider than a row's end: it always sits under its title, at full width. */}
      <Row
        wide
        title={rowTitle(form.provider, form.activeEndpoint)}
        hint={keyRowHint(form.check, form.provider, form.activeEndpoint, form.saved, controls)}
      >
        <form
          className="flex w-full flex-col gap-1"
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
          <ProviderFields form={form} checking={checking} showRemove={showRemove} controls={controls} />
          {form.fieldMessage && (
            <Note tone="warning" id={KEY_MESSAGE_ID} data-power-up-key-failure="">
              {form.fieldMessage}
            </Note>
          )}
        </form>
      </Row>
    </>
  );
}

function EnvProviderRows({ endpoint, modelName, controls }: { endpoint: string | null; modelName: string | null; controls: ReviewSettingsControls }) {
  const { Row } = controls;
  const summary = customTargetSummary(endpoint, modelName) ?? POWER_UP_PROVIDER_NAMES.jev;
  return (
    <>
      <Row title={POWER_UP_WORDS.model} hint={POWER_UP_WORDS.envModel(summary)} />
      <Row title={rowTitle('jev', endpoint)} hint={POWER_UP_WORDS.envKey} />
    </>
  );
}

export interface PowerUpSettingsState {
  /** null while the first settings read is out; false when the host has no key route. */
  available: boolean | null;
  configured: boolean;
  envConfigured: boolean;
  form: PowerUpFormProps;
}

export interface PowerUpSettingsOptions {
  /** Read the route only once this is true (the Power Up section is on screen). Default true. */
  load?: boolean;
  /** Writes `diffPowerUp` on after a key works. Default: the config store. */
  onChange?: ReviewSettingChange;
  /** Sends the requests to the route. Default: the window's fetch. */
  fetch?: OpinionFetch;
}

/**
 * The provider and key form's state, read from and written to the host's
 * opinion settings route. The route is read once, the first time `load` is
 * true, never on every open of a page that has not shown Power Up yet.
 */
export function usePowerUpSettings(route: string, { load: shouldLoad = true, onChange = writeReviewSettingToStore, fetch: send = windowFetch }: PowerUpSettingsOptions = {}): PowerUpSettingsState {
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
      const res = await send(route);
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
  }, [hydrateCustom, route, send]);

  useEffect(() => {
    if (shouldLoad) void load();
  }, [load, shouldLoad]);

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
      const res = await send(route, {
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
      onChange('diffPowerUp', true);
      changed();
    } catch {
      setCheck({ kind: 'error', failure: 'noAnswer' });
    }
  };

  const remove = async () => {
    try {
      const res = await send(route, { method: 'DELETE' });
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

  return { available, configured, envConfigured, form };
}

/** Power Up's rows under its switch: the model form (or the environment's), Motion, and what is sent. */
export function PowerUpRows({
  state,
  motion,
  controls,
  onChange = writeReviewSettingToStore,
}: {
  state: PowerUpSettingsState;
  motion: 'still' | 'stream';
  controls: ReviewSettingsControls;
  onChange?: ReviewSettingChange;
}) {
  const { Row, Segmented, Note } = controls;
  const { available, envConfigured, form } = state;
  if (available === false) {
    return <Row title={POWER_UP_WORDS.model} hint={POWER_UP_WORDS.unavailable} />;
  }
  return (
    <>
      {envConfigured ? (
        <EnvProviderRows endpoint={form.activeEndpoint} modelName={form.activeModel} controls={controls} />
      ) : (
        <ManualProviderRows form={form} controls={controls} />
      )}
      <Row title={POWER_UP_WORDS.motion} hint={POWER_UP_WORDS.motionDescription}>
        <Segmented
          label={POWER_UP_WORDS.motion}
          value={motion}
          options={POWER_UP_WORDS.motionOptions}
          onChange={(v) => onChange('diffPowerUpMotion', v)}
        />
      </Row>
      <Note data-power-up-footer="">
        {form.savedProvider
          ? powerUpFooter(form.savedProvider, form.savedEndpoint)
          : powerUpFooter(form.provider, form.activeEndpoint)}
      </Note>
    </>
  );
}
