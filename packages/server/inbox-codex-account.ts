import { CodexAppServerProcess } from "@plannotator/ai/providers/codex-app-server";
import type { InboxCodexAccount, InboxCodexLimit } from "@plannotator/core/inbox-types";
import { codexHome, type AgentEnvironment } from "./inbox-agents";
import { codexCliCandidates } from "./inbox-codex-wake";

const CODEX_MS = 10_000;
const LIMITS_MS = 5_000;
export const CODEX_ACCOUNT_TTL_MS = 30_000;
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

export function codexPlanName(plan: unknown): string {
  return typeof plan === "string" && Object.hasOwn(PLANS, plan) ? PLANS[plan]! : "ChatGPT";
}

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

export function codexLimitsOf(result: unknown): { limits: InboxCodexLimit[]; plan: string | null } {
  const read = (result ?? {}) as { rateLimits?: unknown; rateLimitsByLimitId?: unknown };
  const byId = read.rateLimitsByLimitId && typeof read.rateLimitsByLimitId === "object" ? (read.rateLimitsByLimitId as Record<string, unknown>).codex : undefined;
  const snapshot = (byId ?? read.rateLimits ?? {}) as { primary?: unknown; secondary?: unknown; planType?: unknown };
  const limits = [limitOf(snapshot.primary), limitOf(snapshot.secondary)].filter((limit): limit is InboxCodexLimit => limit !== null);
  return { limits, plan: typeof snapshot.planType === "string" ? snapshot.planType : null };
}

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

export function createInboxCodexAccount(options: {
  environment: () => AgentEnvironment;
  ready?: () => Promise<{ ok: true } | { ok: false; code?: string }> | null;
  dataDir: string;
  extraClis?: readonly string[];
  now?: () => number;
}): InboxCodexAccountReader {
  const now = options.now ?? Date.now;
  const running = new Set<CodexAppServerProcess>();

  const readOnce = async (): Promise<InboxCodexAccount> => {
    if (options.ready) {
      const ready: { ok: boolean; code?: string } = (await options.ready()) ?? { ok: false };
      if (!ready.ok) return ready.code === "signed_out" ? { state: "signed_out" } : ready.code === "missing" ? { state: "missing" } : { state: "unknown" };
    }
    const environment = options.environment();
    const codexEnv = { ...environment.env, CODEX_HOME: codexHome(environment) };
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
