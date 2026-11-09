/**
 * Codex's account, read-only, for Settings → Agents' Codex row (`GET /api/inbox/codex/account`): signed in or not,
 * with ChatGPT (which plan) or an API key, and the ChatGPT plan's usage limits. Codex itself is asked, the way voice
 * asks it (inbox-voice.ts): a short-lived `codex app-server`, `account/read` (local: Codex's cached login), then for a
 * ChatGPT login `account/rateLimits/read` (a call to ChatGPT, 5 s at most), and Codex stops.
 *
 * What must stay true here:
 *  - Plannotator never reads, stores or moves credentials, and never signs anyone in or out: a person who is not
 *    signed in is shown `codex login` to run themselves.
 *  - Named fields only: the plan word, each window's used percent, its length and reset time. Never the email, an
 *    account or workspace id, or Codex's own text.
 *  - Read only when a window asks (Settings → Agents shown), one run at a time, and an answer serves for 30 s, a
 *    failure's too. Nothing polls.
 */
import { CodexAppServerProcess } from "@plannotator/ai/providers/codex-app-server";
import type { InboxCodexAccount, InboxCodexLimit } from "@plannotator/core/inbox-types";
import { codexHome, type AgentEnvironment } from "./inbox-agents";
import { codexCliCandidates } from "./inbox-codex-wake";

/** Codex's start and its account answer. */
const CODEX_MS = 10_000;
/** The limits read goes to ChatGPT: never a long wait for Settings. */
const LIMITS_MS = 5_000;
/** How long one answer serves every window. */
export const CODEX_ACCOUNT_TTL_MS = 30_000;
/** An account answer is a few KB: a longer line is a broken `codex`. */
const LINE_MAX = 1024 * 1024;

const PLANS: Record<string, string> = {
  free: "ChatGPT Free",
  go: "ChatGPT Go",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  prolite: "ChatGPT Pro",
  promax: "ChatGPT Pro",
  team: "ChatGPT Business",
  business: "ChatGPT Business",
  self_serve_business_prolite: "ChatGPT Business",
  self_serve_business_usage_based: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
  ent26: "ChatGPT Enterprise",
  enterprise_cbp_automation: "ChatGPT Enterprise",
  enterprise_cbp_usage_based: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
  edu_plus: "ChatGPT Edu",
  edu_pro: "ChatGPT Edu",
};

/** A plan as the person reads it ("ChatGPT Plus"); "ChatGPT" for one this build does not know. */
export function codexPlanName(plan: unknown): string {
  return typeof plan === "string" && Object.hasOwn(PLANS, plan) ? PLANS[plan]! : "ChatGPT";
}

/** One rate-limit window by name: a used percent that is a finite number, else null (never 0 for a window not reported). */
function limitOf(window: unknown): InboxCodexLimit | null {
  if (!window || typeof window !== "object") return null;
  const { usedPercent, windowDurationMins, resetsAt } = window as Record<string, unknown>;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
  return {
    used_percent: Math.max(0, Math.min(100, Math.round(usedPercent))),
    window_mins: typeof windowDurationMins === "number" && Number.isFinite(windowDurationMins) && windowDurationMins > 0 ? Math.round(windowDurationMins) : null,
    resets_at: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? new Date(resetsAt * 1000).toISOString() : null,
  };
}

/** `account/rateLimits/read`'s Codex limits (its `codex` entry first, as T3 Code reads it) and the plan it names. */
export function codexLimitsOf(result: unknown): { limits: InboxCodexLimit[]; plan: string | null } {
  const read = (result ?? {}) as { rateLimits?: unknown; rateLimitsByLimitId?: unknown };
  const byId = read.rateLimitsByLimitId && typeof read.rateLimitsByLimitId === "object" ? (read.rateLimitsByLimitId as Record<string, unknown>).codex : undefined;
  const snapshot = (byId ?? read.rateLimits ?? {}) as { primary?: unknown; secondary?: unknown; planType?: unknown };
  const limits = [limitOf(snapshot.primary), limitOf(snapshot.secondary)].filter((limit): limit is InboxCodexLimit => limit !== null);
  return { limits, plan: typeof snapshot.planType === "string" ? snapshot.planType : null };
}

/** `account/read`'s answer as the row's state (no limits yet). */
export function codexAccountOf(result: unknown): InboxCodexAccount {
  const read = (result ?? {}) as { account?: unknown; requiresOpenaiAuth?: unknown };
  const account = read.account as { type?: unknown; planType?: unknown } | null | undefined;
  if (!account) return read.requiresOpenaiAuth === false ? { state: "signed_in", kind: "other", plan: null, limits: null } : { state: "signed_out" };
  if (account.type === "chatgpt") return { state: "signed_in", kind: "chatgpt", plan: codexPlanName(account.planType), limits: null };
  if (account.type === "apiKey") return { state: "signed_in", kind: "api_key", plan: null, limits: null };
  return { state: "signed_in", kind: "other", plan: null, limits: null };
}

export interface InboxCodexAccountReader {
  read(): Promise<InboxCodexAccount>;
  stop(): void;
}

export function createInboxCodexAccount(options: { environment: AgentEnvironment; dataDir: string; extraClis?: readonly string[]; now?: () => number }): InboxCodexAccountReader {
  const { environment } = options;
  const now = options.now ?? Date.now;
  /** Codex's config and login are read from the home it runs with, never one the Inbox was not given. */
  const codexEnv = { ...environment.env, CODEX_HOME: codexHome(environment) };
  const running = new Set<CodexAppServerProcess>();

  const readOnce = async (): Promise<InboxCodexAccount> => {
    const path = codexCliCandidates(environment, options.extraClis)[0];
    if (!path) return { state: "missing" };
    const codex = new CodexAppServerProcess(LINE_MAX);
    running.add(codex);
    try {
      await codex.start(path, options.dataDir, CODEX_MS, codexEnv);
      const account = codexAccountOf(await codex.sendAndWait({ method: "account/read", params: {} }, CODEX_MS));
      if (account.state !== "signed_in" || account.kind !== "chatgpt") return account;
      try {
        const { limits, plan } = codexLimitsOf(await codex.sendAndWait({ method: "account/rateLimits/read", params: {} }, LIMITS_MS));
        // The limits' plan is fresher than the login's cached one.
        return { ...account, plan: plan ? codexPlanName(plan) : account.plan, limits };
      } catch {
        return account;
      }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : { state: "unknown" };
    } finally {
      running.delete(codex);
      codex.kill();
    }
  };

  let kept: { at: number; account: InboxCodexAccount } | null = null;
  let reading: Promise<InboxCodexAccount> | null = null;
  return {
    read() {
      if (kept && now() - kept.at < CODEX_ACCOUNT_TTL_MS && now() >= kept.at) return Promise.resolve(kept.account);
      reading ??= readOnce()
        .then((account) => {
          kept = { at: now(), account };
          return account;
        })
        .finally(() => {
          reading = null;
        });
      return reading;
    },
    stop() {
      for (const codex of running) codex.kill(true);
      running.clear();
    },
  };
}
