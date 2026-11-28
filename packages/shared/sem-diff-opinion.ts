import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Candidate } from "@plannotator/sem-jiff/candidate";
import {
  OpinionKeyError,
  checkKey,
  clefAnswers,
  jevAnswers,
  type OpinionAnswer,
} from "@plannotator/sem-jiff/opinions";
import { checkOpenAIDecisions, openaiAnswers, OpenAIDecisionError } from "./sem-diff-openai";

export const SEM_DIFF_OPINION_ROUTE = "/api/sem-diff/opinion";
export const SEM_DIFF_OPINION_SETTINGS_ROUTE = "/api/sem-diff/opinion/settings";

export type OpinionAuth = "bearer" | "api-key";
export type OpinionEnv = Readonly<Record<string, string | undefined>>;

export type OpinionSecret =
  | { provider: "jev"; apiKey: string }
  | { provider: "openai"; apiKey: string }
  | { provider: "clef"; accountId: string; apiToken: string }
  | { provider: "custom"; url: string; model?: string; auth: OpinionAuth; apiKey: string };

export type OpinionProvider = OpinionSecret["provider"];

type SystemoneSecret = Extract<OpinionSecret, { provider: "jev" | "custom" }>;

/** Jev and Custom speak the systemone contract; only they take the URL, model and auth overrides. */
function usesSystemone(secret: OpinionSecret): secret is SystemoneSecret {
  return secret.provider === "jev" || secret.provider === "custom";
}

export interface OpinionSettings {
  configured: boolean;
  provider: OpinionProvider | null;
  source?: "env";
  url?: string;
  endpoint?: string;
  model?: string;
  auth?: OpinionAuth;
}

export interface OpinionEnvConfig {
  url?: string;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  auth?: OpinionAuth;
  error?: string;
}

interface SystemoneTarget {
  url?: string;
  endpoint?: string;
  model?: string;
  auth: OpinionAuth;
  error?: string;
}

export type OpinionState = "off" | "refusedKey" | "noCredit" | "failed";

export type OpinionReply =
  | { ok: true; answers: OpinionAnswer[] }
  | { ok: false; state: OpinionState; reason: string };

export type KeySaveFailure = "missing" | "invalidUrl" | "refused" | "noCredit" | "noAnswer";
export type KeySaveReply =
  | { ok: true; provider: OpinionProvider; ms: number }
  | { ok: false; failure: KeySaveFailure; reason: string };

type Fetch = typeof fetch;

const MAX_CANDIDATES = 24;
const MAX_FIELD = 40_000;
const MAX_TEXT = 400;
const MAX_URL = 2_048;

export function semDiffOpinionPath(dataDir: string): string {
  return join(dataDir, "secrets", "sem-diff-opinion.json");
}

function boundedText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function parseHttpUrl(raw: unknown): { url: string; endpoint: string } | null {
  const trimmed = boundedText(raw, MAX_URL);
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const validScheme = parsed.protocol === "http:" || parsed.protocol === "https:";
    if (!validScheme || parsed.username || parsed.password) return null;
    return { url: parsed.href, endpoint: parsed.host };
  } catch {
    return null;
  }
}

function parseAuth(raw: unknown): OpinionAuth | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized === "bearer" || normalized === "api-key" ? normalized : null;
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseEnvUrl(raw: string | undefined): { url?: string; endpoint?: string; error?: string } {
  const value = nonEmpty(raw);
  if (!value) return {};
  return parseHttpUrl(value) ?? { error: "PLANNOTATOR_OPINION_URL must be an http or https URL." };
}

function parseEnvText(raw: string | undefined, name: string): { value?: string; error?: string } {
  const present = nonEmpty(raw);
  if (!present) return {};
  const bounded = boundedText(present);
  return bounded ? { value: bounded } : { error: `${name} is too long.` };
}

function parseEnvAuth(raw: string | undefined): { auth?: OpinionAuth; error?: string } {
  const value = nonEmpty(raw);
  if (!value) return {};
  const auth = parseAuth(value);
  return auth ? { auth } : { error: 'PLANNOTATOR_OPINION_AUTH must be "bearer" or "api-key".' };
}

export function readOpinionEnv(env: OpinionEnv = process.env): OpinionEnvConfig {
  const url = parseEnvUrl(env.PLANNOTATOR_OPINION_URL);
  const model = parseEnvText(env.PLANNOTATOR_OPINION_MODEL, "PLANNOTATOR_OPINION_MODEL");
  const key = parseEnvText(env.PLANNOTATOR_OPINION_API_KEY, "PLANNOTATOR_OPINION_API_KEY");
  const auth = parseEnvAuth(env.PLANNOTATOR_OPINION_AUTH);
  const error = [url.error, model.error, key.error, auth.error].find(Boolean);
  const config: OpinionEnvConfig = {};
  if (url.url) {
    config.url = url.url;
    config.endpoint = url.endpoint;
  }
  if (model.value) config.model = model.value;
  if (key.value) config.apiKey = key.value;
  if (auth.auth) config.auth = auth.auth;
  if (error) config.error = error;
  return config;
}

function savedCustomTarget(secret: OpinionSecret): { url?: string; endpoint?: string; model?: string; auth: OpinionAuth } {
  if (secret.provider !== "custom") return { auth: "bearer" };
  const parsed = parseHttpUrl(secret.url);
  return { url: parsed?.url, endpoint: parsed?.endpoint, model: secret.model, auth: secret.auth };
}

function resolveSystemoneTarget(secret: OpinionSecret, envConfig: OpinionEnvConfig): SystemoneTarget {
  const saved = savedCustomTarget(secret);
  return {
    url: envConfig.url ?? saved.url,
    endpoint: envConfig.endpoint ?? saved.endpoint,
    model: envConfig.model ?? saved.model,
    auth: envConfig.auth ?? saved.auth,
    error: envConfig.error,
  };
}

function withApiKeyAuth(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  const authorization = headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    headers.set("authorization", `Api-Key ${authorization.slice(7)}`);
  }
  return { ...init, headers };
}

// Every call that carries the key goes through this: a redirect is a failed call, never followed, so the key in its
// header never reaches a host the person did not name. One wrapper per fetch, so the askers' memory (keyed by fetch)
// still holds between asks.
const noRedirectFetches = new WeakMap<Fetch, Fetch>();
export function withoutRedirects(fetchImpl: Fetch): Fetch {
  let wrapped = noRedirectFetches.get(fetchImpl);
  if (!wrapped) {
    wrapped = ((input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input, { ...init, redirect: "error" })) as Fetch;
    noRedirectFetches.set(fetchImpl, wrapped);
  }
  return wrapped;
}

// @plannotator/sem-jiff hardcodes TypeSafe's endpoint and Bearer header in its post helper.
function systemoneFetch(fetchImpl: Fetch, target: SystemoneTarget): Fetch {
  if (!target.url && target.auth === "bearer") return fetchImpl;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const dest = target.url ?? input;
    const nextInit = target.auth === "api-key" ? withApiKeyAuth(init) : init;
    return fetchImpl(dest, nextInit);
  }) as Fetch;
}

type ParsedSaveBody = { secret?: OpinionSecret; failure?: KeySaveFailure; reason?: string };

const MISSING_SAVE_BODY: ParsedSaveBody = {
  failure: "missing",
  reason: "Enter the credentials for the selected model.",
};

function parseOptionalModel(raw: unknown): { model?: string; error?: string } {
  if (typeof raw !== "string") return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const model = boundedText(trimmed);
  return model ? { model } : { error: "Model name is too long." };
}

function parseOptionalAuth(raw: unknown): OpinionAuth | null {
  if (raw === undefined || raw === "") return "bearer";
  return parseAuth(raw);
}

function parseCustomSecret(fields: Record<string, unknown>): ParsedSaveBody {
  const rawUrl = boundedText(fields.url, MAX_URL);
  const apiKey = boundedText(fields.apiKey);
  if (!rawUrl || !apiKey) return { failure: "missing", reason: "Enter an endpoint URL and API key." };
  const parsedUrl = parseHttpUrl(rawUrl);
  if (!parsedUrl) return { failure: "invalidUrl", reason: "Enter an http or https endpoint URL." };
  const auth = parseOptionalAuth(fields.auth);
  if (!auth) return { failure: "missing", reason: 'Auth scheme must be "bearer" or "api-key".' };
  const { model, error } = parseOptionalModel(fields.model);
  if (error) return { failure: "missing", reason: error };
  const secret: OpinionSecret = { provider: "custom", url: parsedUrl.url, auth, apiKey };
  if (model) secret.model = model;
  return { secret };
}

function parseClefSecret(fields: Record<string, unknown>): ParsedSaveBody {
  const accountId = boundedText(fields.accountId);
  const apiToken = boundedText(fields.apiToken);
  if (!accountId || !apiToken) return MISSING_SAVE_BODY;
  return { secret: { provider: "clef", accountId, apiToken } };
}

function parseSaveBody(value: unknown): ParsedSaveBody {
  if (!value || typeof value !== "object") return MISSING_SAVE_BODY;
  const fields = value as Record<string, unknown>;
  if (fields.provider === "jev" || fields.provider === "openai") {
    const apiKey = boundedText(fields.apiKey);
    return apiKey ? { secret: { provider: fields.provider, apiKey } } : MISSING_SAVE_BODY;
  }
  if (fields.provider === "clef") return parseClefSecret(fields);
  if (fields.provider === "custom") return parseCustomSecret(fields);
  return MISSING_SAVE_BODY;
}

function parseSecret(value: unknown): OpinionSecret | null {
  return parseSaveBody(value).secret ?? null;
}

export async function readOpinionSecret(dataDir: string): Promise<OpinionSecret | null> {
  try {
    return parseSecret(JSON.parse(await readFile(semDiffOpinionPath(dataDir), "utf8")));
  } catch {
    return null;
  }
}

async function resolveOpinionSecret(dataDir: string, config: OpinionEnvConfig): Promise<OpinionSecret | null> {
  if (config.apiKey) return { provider: "jev", apiKey: config.apiKey };
  return readOpinionSecret(dataDir);
}

async function writeOpinionSecret(dataDir: string, secret: OpinionSecret): Promise<void> {
  const path = semDiffOpinionPath(dataDir);
  await mkdir(join(dataDir, "secrets"), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(secret), { mode: 0o600 });
  await rename(temp, path);
}

export async function clearOpinionSecret(dataDir: string): Promise<void> {
  await rm(semDiffOpinionPath(dataDir), { force: true });
}

function applyCustomMetadata(settings: OpinionSettings, secret: OpinionSecret | null, envConfig: OpinionEnvConfig): void {
  if (secret?.provider === "custom") {
    const target = resolveSystemoneTarget(secret, envConfig);
    if (target.url) settings.url = target.url;
    if (target.endpoint) settings.endpoint = target.endpoint;
    if (target.model) settings.model = target.model;
    settings.auth = target.auth;
    return;
  }
  // The overrides never reroute OpenAI or Clef, so their settings name no overridden endpoint.
  if (secret && !usesSystemone(secret)) return;
  if (envConfig.endpoint) settings.endpoint = envConfig.endpoint;
  if (envConfig.model) settings.model = envConfig.model;
}

export async function opinionSettings(dataDir: string, env: OpinionEnv = process.env): Promise<OpinionSettings> {
  const config = readOpinionEnv(env);
  const secret = await resolveOpinionSecret(dataDir, config);
  const settings: OpinionSettings = { configured: secret !== null, provider: secret?.provider ?? null };
  if (config.apiKey) settings.source = "env";
  applyCustomMetadata(settings, secret, config);
  return settings;
}

type KeyCheck = { ok: true; ms: number } | { ok: false; failure: KeySaveFailure; reason: string };

function checkSemJiffKey(secret: Exclude<OpinionSecret, { provider: "openai" }>, envConfig: OpinionEnvConfig, fetchImpl: Fetch) {
  if (secret.provider === "clef") {
    return checkKey({ provider: "clef", accountId: secret.accountId, apiToken: secret.apiToken }, fetchImpl);
  }
  const target = resolveSystemoneTarget(secret, envConfig);
  return checkKey({ provider: "jev", apiKey: secret.apiKey, model: target.model }, systemoneFetch(fetchImpl, target));
}

async function verifyOpinionSecret(secret: OpinionSecret, envConfig: OpinionEnvConfig, fetchImpl: Fetch): Promise<KeyCheck> {
  if (secret.provider === "openai") {
    try {
      return { ok: true, ms: await checkOpenAIDecisions(secret.apiKey, fetchImpl) };
    } catch (e) {
      return { ok: false, ...keyFailure(e instanceof OpenAIDecisionError ? e.failure : "noAnswer") };
    }
  }
  const check = await checkSemJiffKey(secret, envConfig, fetchImpl);
  return check.ok ? { ok: true, ms: check.ms } : { ok: false, ...plainReason(check.reason) };
}

export async function saveOpinionKey(
  dataDir: string,
  body: unknown,
  fetchImpl: Fetch = fetch,
  env: OpinionEnv = process.env,
): Promise<KeySaveReply> {
  const parsed = parseSaveBody(body);
  if (!parsed.secret) return { ok: false, failure: parsed.failure ?? "missing", reason: parsed.reason ?? "Invalid settings." };
  const config = readOpinionEnv(env);
  if (usesSystemone(parsed.secret) && config.error) return { ok: false, failure: "noAnswer", reason: config.error };
  const check = await verifyOpinionSecret(parsed.secret, config, withoutRedirects(fetchImpl));
  if (!check.ok) return { ok: false, failure: check.failure, reason: check.reason };
  await writeOpinionSecret(dataDir, parsed.secret);
  return { ok: true, provider: parsed.secret.provider, ms: check.ms };
}

function plainReason(reason: string): { failure: KeySaveFailure; reason: string } {
  return keyFailure(/no credit/i.test(reason) ? "noCredit" : /refused/i.test(reason) ? "refused" : "noAnswer");
}

function keyFailure(failure: Exclude<KeySaveFailure, "missing">) {
  const reason = failure === "noCredit" ? "The account has no credit left."
    : failure === "refused" ? "The key was refused."
    : "The provider did not answer. Try again in a moment.";
  return { failure, reason };
}

function parseCandidates(body: unknown): Candidate[] | null {
  const list = (body as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CANDIDATES) return null;
  const out: Candidate[] = [];
  for (const raw of list) {
    const c = raw as Partial<Candidate> & { code?: Partial<Candidate["code"]> };
    const field = (x: unknown) => typeof x === "string" && x.length <= MAX_FIELD;
    if ((c.kind !== "extract" && c.kind !== "inline") || !field(c.helper) || !field(c.caller)) return null;
    if (!c.code || !field(c.code.helper) || !field(c.code.caller) || !field(c.code.callerNew)) return null;
    if (c.file !== undefined && !field(c.file)) return null;
    out.push({ kind: c.kind, helper: c.helper!, caller: c.caller!, file: c.file, code: { helper: c.code.helper!, caller: c.code.caller!, callerNew: c.code.callerNew! } });
  }
  return out;
}

const askers = new WeakMap<Fetch, { id: string; ask: (cs: Candidate[]) => Promise<OpinionAnswer[]> }>();

function askerCacheKey(secret: OpinionSecret, envConfig: OpinionEnvConfig): string {
  if (secret.provider === "clef") return `clef\0${secret.accountId}\0${secret.apiToken}`;
  if (secret.provider === "openai") return `openai\0${secret.apiKey}`;
  const target = resolveSystemoneTarget(secret, envConfig);
  return `systemone\0${secret.apiKey}\0${target.url ?? ""}\0${target.model ?? ""}\0${target.auth}`;
}

function createAsker(
  secret: OpinionSecret,
  envConfig: OpinionEnvConfig,
  fetchImpl: Fetch,
): (cs: Candidate[]) => Promise<OpinionAnswer[]> {
  if (secret.provider === "clef") {
    return clefAnswers({ accountId: secret.accountId, apiToken: secret.apiToken, fetch: fetchImpl, concurrency: 4 });
  }
  if (secret.provider === "openai") return openaiAnswers(secret.apiKey, fetchImpl);
  const target = resolveSystemoneTarget(secret, envConfig);
  return jevAnswers({
    apiKey: secret.apiKey,
    model: target.model,
    fetch: systemoneFetch(fetchImpl, target),
    concurrency: 4,
  });
}

function askerFor(
  secret: OpinionSecret,
  envConfig: OpinionEnvConfig,
  fetchImpl: Fetch,
): (cs: Candidate[]) => Promise<OpinionAnswer[]> {
  const id = askerCacheKey(secret, envConfig);
  const kept = askers.get(fetchImpl);
  if (kept?.id === id) return kept.ask;
  const ask = createAsker(secret, envConfig, fetchImpl);
  askers.set(fetchImpl, { id, ask });
  return ask;
}

function classifyOpinionError(err: unknown): OpinionReply {
  if (err instanceof OpenAIDecisionError) {
    const state = err.failure === "noCredit" ? "noCredit" : err.failure === "refused" ? "refusedKey" : "failed";
    return { ok: false, state, reason: keyFailure(err.failure).reason };
  }
  if (err instanceof OpinionKeyError) {
    return err.status === 402
      ? { ok: false, state: "noCredit", reason: "The account has no credit left." }
      : { ok: false, state: "refusedKey", reason: "The key was refused." };
  }
  return { ok: false, state: "failed", reason: "The provider did not answer." };
}

export async function askOpinion(
  dataDir: string,
  body: unknown,
  fetchImpl: Fetch = fetch,
  env: OpinionEnv = process.env,
): Promise<OpinionReply> {
  const candidates = parseCandidates(body);
  if (!candidates) return { ok: false, state: "failed", reason: "The question was not understood." };
  const config = readOpinionEnv(env);
  const secret = await resolveOpinionSecret(dataDir, config);
  if (!secret) return { ok: false, state: "off", reason: "Power Up has no key." };
  if (usesSystemone(secret) && config.error) return { ok: false, state: "failed", reason: config.error };
  try {
    return { ok: true, answers: await askerFor(secret, config, withoutRedirects(fetchImpl))(candidates) };
  } catch (err) {
    return classifyOpinionError(err);
  }
}

export function isSemDiffOpinionRequest(pathname: string): boolean {
  return pathname === SEM_DIFF_OPINION_ROUTE || pathname === SEM_DIFF_OPINION_SETTINGS_ROUTE;
}

export interface OpinionRouteAnswer {
  status: number;
  body: unknown;
}

export async function answerSemDiffOpinionRequest(
  pathname: string,
  method: string | undefined,
  readJson: () => Promise<unknown>,
  dataDir: string,
  fetchImpl: Fetch = fetch,
  env: OpinionEnv = process.env,
): Promise<OpinionRouteAnswer> {
  const read = async () => {
    try {
      return await readJson();
    } catch {
      return null;
    }
  };
  if (pathname === SEM_DIFF_OPINION_ROUTE) {
    if (method !== "POST") return { status: 405, body: { ok: false, reason: "Method not allowed" } };
    return { status: 200, body: await askOpinion(dataDir, await read(), fetchImpl, env) };
  }
  if (method === "GET") return { status: 200, body: await opinionSettings(dataDir, env) };
  if (method === "POST") {
    const reply = await saveOpinionKey(dataDir, await read(), fetchImpl, env);
    return { status: 200, body: reply };
  }
  if (method === "DELETE") {
    await clearOpinionSecret(dataDir);
    return { status: 200, body: { ok: true } };
  }
  return { status: 405, body: { ok: false, reason: "Method not allowed" } };
}
