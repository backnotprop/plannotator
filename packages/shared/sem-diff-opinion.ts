import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Candidate } from "@plannotator/sem-diff/candidate";
import {
  OpinionKeyError,
  checkKey,
  clefAnswers,
  jevAnswers,
  type OpinionAnswer,
} from "@plannotator/sem-diff/opinions";

export const SEM_DIFF_OPINION_ROUTE = "/api/sem-diff/opinion";
export const SEM_DIFF_OPINION_SETTINGS_ROUTE = "/api/sem-diff/opinion/settings";

export type OpinionProvider = "jev" | "clef";

export type OpinionSecret =
  | { provider: "jev"; apiKey: string }
  | { provider: "clef"; accountId: string; apiToken: string };

export interface OpinionSettings {
  configured: boolean;
  provider: OpinionProvider | null;
}

export type OpinionState = "off" | "refusedKey" | "noCredit" | "failed";

export type OpinionReply =
  | { ok: true; answers: OpinionAnswer[] }
  | { ok: false; state: OpinionState; reason: string };

export type KeySaveFailure = "missing" | "refused" | "noCredit" | "noAnswer";
export type KeySaveReply = { ok: true; provider: OpinionProvider; ms: number } | { ok: false; failure: KeySaveFailure; reason: string };

type Fetch = typeof fetch;

const MAX_CANDIDATES = 24;
const MAX_FIELD = 40_000;

export function semDiffOpinionPath(dataDir: string): string {
  return join(dataDir, "secrets", "sem-diff-opinion.json");
}

function parseSecret(value: unknown): OpinionSecret | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" && x.trim().length > 0 && x.length <= 400 ? x.trim() : null);
  if (v.provider === "jev") {
    const apiKey = text(v.apiKey);
    return apiKey ? { provider: "jev", apiKey } : null;
  }
  if (v.provider === "clef") {
    const accountId = text(v.accountId);
    const apiToken = text(v.apiToken);
    return accountId && apiToken ? { provider: "clef", accountId, apiToken } : null;
  }
  return null;
}

export async function readOpinionSecret(dataDir: string): Promise<OpinionSecret | null> {
  try {
    return parseSecret(JSON.parse(await readFile(semDiffOpinionPath(dataDir), "utf8")));
  } catch {
    return null;
  }
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

export async function opinionSettings(dataDir: string): Promise<OpinionSettings> {
  const secret = await readOpinionSecret(dataDir);
  return { configured: secret !== null, provider: secret?.provider ?? null };
}

export async function saveOpinionKey(dataDir: string, body: unknown, fetchImpl: Fetch = fetch): Promise<KeySaveReply> {
  const secret = parseSecret(body);
  if (!secret) return { ok: false, failure: "missing", reason: "Enter a key for Jev, or an account ID and token for Clef." };
  const check =
    secret.provider === "jev"
      ? await checkKey({ provider: "jev", apiKey: secret.apiKey }, fetchImpl)
      : await checkKey({ provider: "clef", accountId: secret.accountId, apiToken: secret.apiToken }, fetchImpl);
  if (!check.ok) return { ok: false, ...plainReason(check.reason) };
  await writeOpinionSecret(dataDir, secret);
  return { ok: true, provider: secret.provider, ms: check.ms };
}

function plainReason(reason: string): { failure: KeySaveFailure; reason: string } {
  if (/no credit/i.test(reason)) return { failure: "noCredit", reason: "The account has no credit left." };
  if (/refused/i.test(reason)) return { failure: "refused", reason: "The key was refused." };
  return { failure: "noAnswer", reason: "The provider did not answer. Try again in a moment." };
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

function askerFor(secret: OpinionSecret, fetchImpl: Fetch): (cs: Candidate[]) => Promise<OpinionAnswer[]> {
  const id = secret.provider === "jev" ? `jev\0${secret.apiKey}` : `clef\0${secret.accountId}\0${secret.apiToken}`;
  const kept = askers.get(fetchImpl);
  if (kept?.id === id) return kept.ask;
  const ask =
    secret.provider === "jev"
      ? jevAnswers({ apiKey: secret.apiKey, fetch: fetchImpl, concurrency: 4 })
      : clefAnswers({ accountId: secret.accountId, apiToken: secret.apiToken, fetch: fetchImpl, concurrency: 4 });
  askers.set(fetchImpl, { id, ask });
  return ask;
}

export async function askOpinion(dataDir: string, body: unknown, fetchImpl: Fetch = fetch): Promise<OpinionReply> {
  const candidates = parseCandidates(body);
  if (!candidates) return { ok: false, state: "failed", reason: "The question was not understood." };
  const secret = await readOpinionSecret(dataDir);
  if (!secret) return { ok: false, state: "off", reason: "Power Up has no key." };
  try {
    return { ok: true, answers: await askerFor(secret, fetchImpl)(candidates) };
  } catch (e) {
    if (e instanceof OpinionKeyError) {
      return e.status === 402
        ? { ok: false, state: "noCredit", reason: "The account has no credit left." }
        : { ok: false, state: "refusedKey", reason: "The key was refused." };
    }
    return { ok: false, state: "failed", reason: "The provider did not answer." };
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
    return { status: 200, body: await askOpinion(dataDir, await read(), fetchImpl) };
  }
  if (method === "GET") return { status: 200, body: await opinionSettings(dataDir) };
  if (method === "POST") {
    const reply = await saveOpinionKey(dataDir, await read(), fetchImpl);
    return { status: 200, body: reply };
  }
  if (method === "DELETE") {
    await clearOpinionSecret(dataDir);
    return { status: 200, body: { ok: true } };
  }
  return { status: 405, body: { ok: false, reason: "Method not allowed" } };
}
