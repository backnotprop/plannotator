/**
 * PR risk ranking in the Inbox (approval "code-review-launch-build", item 4). The
 * person writes what a high-risk pull request is for them (the "no slop rules")
 * and picks a cheap agent. Each PR head the list shows gets one judgment, low,
 * medium or high with one sentence why, in the background, a few at a time.
 *
 *   inbox/pull-risk.json   { v: 1, judgments: { [pull key]: { head, rules, level, why, at } } }
 *
 * - Runs only while Code review is on and rules exist, and only from the owner's
 *   window's list read (the routes in inbox.ts guard those). Open and draft PRs only.
 * - A judgment belongs to a head and to the rules it was made against (`rules` is a
 *   hash of them, the words stay in config.json): a new head or new rules means a new
 *   judgment, and a restart redoes nothing.
 * - A failed run keeps no judgment and tries again later, waiting longer each time
 *   (`RISK_RETRY_MS`). It never blocks the list.
 * - The agent is an Ask AI provider started for one answer (`oneShot`): no tools
 *   where its CLI allows, in an empty folder, so it has only the prompt. A provider
 *   that still reaches for a tool or asks permission is stopped and its run discarded,
 *   so a diff can't get a run to act; a Codex shell call is also sandboxed read-only.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWindowsCommandShim } from "@plannotator/ai/providers/command-path";
import { createProvider } from "@plannotator/ai/provider";
import type { AIProvider, CatalogModel, ClaudeAgentSDKConfig, CodexSDKConfig, PiSDKConfig } from "@plannotator/ai/types";
import { INBOX_PULL_RISK_RULES_MAX, inboxPullIsOpen, type InboxPull, type InboxPullRiskAgent, type InboxPullRiskAnswer, type InboxPullRiskJudgment, type InboxPullRiskModels } from "@plannotator/core/inbox-types";
import { childPath } from "@plannotator/shared/child-env";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { buildRiskPrompt, parseRiskAnswer, riskFence, RISK_SYSTEM_PROMPT, trimDiffForRisk } from "./inbox-pull-risk-prompt";
import type { InboxPulls } from "./inbox-pulls";

export const INBOX_PULL_RISK_FILE = "pull-risk.json";
/** A few at a time. */
export const RISK_CONCURRENCY = 3;
/** One judgment gets this long: past it the run counts as failed. */
export const RISK_RUN_TIMEOUT_MS = 120_000;
/** The first wait after a failed run; each further failure waits twice as long, up to the most. */
export const RISK_RETRY_MS = 15 * 60_000;
export const RISK_RETRY_MAX_MS = 6 * 60 * 60_000;
/** How many PRs keep a judgment: the oldest go first. Only ever one per PR. */
const RISK_KEPT_MAX = 2_000;

/** The Ask AI providers that can be the risk agent, in the order the dialog offers them. */
const RISK_AGENTS: readonly (InboxPullRiskAgent & { cli: string })[] = [
  { id: "claude-agent-sdk", label: "Claude Code", cli: "claude" },
  { id: "codex-sdk", label: "Codex", cli: "codex" },
  { id: "pi-sdk", label: "Pi", cli: "pi" },
  { id: "opencode-sdk", label: "OpenCode", cli: "opencode" },
];

/** The context a provider's session requires; `oneShot` means its prompt is never used. */
const NO_CONTEXT = { mode: "code-review", review: { patch: "" } } as const;

/**
 * Cheap and good enough for a quick judgment, best first: what the owner named (Sonnet,
 * Terra), then the small models of other makers. Matched on any id a provider lists.
 */
const CHEAP_MODELS = [/sonnet/i, /terra/i, /haiku/i, /flash/i, /mini(?!max)/i, /luna/i, /small|lite/i];

/** The model to start on: the cheapest sensible one a provider lists, else its own default. */
export function defaultRiskModel(models: readonly Pick<CatalogModel, "id" | "default">[]): string | null {
  for (const cheap of CHEAP_MODELS) {
    const found = models.find((m) => cheap.test(m.id));
    if (found) return found.id;
  }
  return models.find((m) => m.default)?.id ?? models[0]?.id ?? null;
}

/** The lowest effort a model takes, or nothing for a model that takes none. */
function lowestEffort(models: readonly CatalogModel[] | undefined, model: string | null): string | undefined {
  const efforts = models?.find((m) => m.id === model)?.reasoningEfforts?.map((e) => e.id) ?? [];
  return ["low", "minimal"].find((e) => efforts.includes(e));
}

function installedPath(cli: string): string | null {
  return Bun.which(cli, { PATH: childPath() }) ?? null;
}

/** A fresh provider of that kind, or null when its CLI is not installed. */
async function startProvider(id: string, cwd: string): Promise<AIProvider | null> {
  const agent = RISK_AGENTS.find((a) => a.id === id);
  const path = agent ? installedPath(agent.cli) : null;
  if (!path) return null;
  switch (id) {
    case "claude-agent-sdk":
      await import("@plannotator/ai/providers/claude-agent-sdk");
      return createProvider({ type: id, cwd, claudeExecutablePath: path, allowedTools: [] } as ClaudeAgentSDKConfig);
    case "codex-sdk":
      await import("@plannotator/ai/providers/codex-app-server");
      return createProvider({ type: id, cwd, codexExecutablePath: path } as CodexSDKConfig);
    case "pi-sdk":
      await import("@plannotator/ai/providers/pi-sdk");
      return createProvider({ type: id, cwd, piExecutablePath: resolveWindowsCommandShim(path) } as PiSDKConfig);
    case "opencode-sdk":
      await import("@plannotator/ai/providers/opencode-sdk");
      return createProvider({ type: id, cwd });
    default:
      return null;
  }
}

/** What one run asks of an agent. */
export interface RiskRun {
  provider: string;
  model: string | null;
  system: string;
  prompt: string;
  cwd: string;
}

/** The agent's whole answer, or null when the run failed. `costUsd` when the provider reports one. */
export type RiskRunner = (run: RiskRun) => Promise<{ text: string; costUsd?: number } | null>;

/** Run one answer on an AI provider. Any tool use or permission ask ends the run with no answer. */
export async function runRiskAgent(provider: AIProvider, run: Omit<RiskRun, "provider">, timeoutMs = RISK_RUN_TIMEOUT_MS): Promise<{ text: string; costUsd?: number } | null> {
  const model = run.model ?? defaultRiskModel(provider.models ?? []);
  const session = await provider.createSession({
    context: NO_CONTEXT,
    cwd: run.cwd,
    ...(model ? { model } : {}),
    reasoningEffort: lowestEffort(provider.models, model),
    maxTurns: 1,
    oneShot: { systemPrompt: run.system },
  });
  const read = async (): Promise<{ text: string; costUsd?: number } | null> => {
    const whole: string[] = [];
    const deltas: string[] = [];
    let final: string | undefined;
    let costUsd: number | undefined;
    for await (const message of session.query(run.prompt)) {
      if (message.type === "tool_use" || message.type === "permission_request" || message.type === "error") return null;
      if (message.type === "text") whole.push(message.text);
      if (message.type === "text_delta") deltas.push(message.delta);
      if (message.type === "result") {
        if (!message.success) return null;
        final = message.result;
        costUsd = message.costUsd;
      }
    }
    const text = final || whole.join("") || deltas.join("");
    return text ? { text, ...(costUsd !== undefined ? { costUsd } : {}) } : null;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)))]);
  } finally {
    clearTimeout(timer);
    session.abort();
    session.dispose?.();
  }
}

const defaultRunner: RiskRunner = async (run) => {
  const provider = await startProvider(run.provider, run.cwd);
  if (!provider) return null;
  try {
    return await runRiskAgent(provider, run);
  } finally {
    provider.dispose();
  }
};

/** What the agent offers, read once from its CLI when the dialog asks, then kept. */
async function defaultModels(provider: string, cwd: string): Promise<CatalogModel[]> {
  const started = await startProvider(provider, cwd);
  if (!started) return [];
  try {
    await (started as AIProvider & { fetchModels?: () => Promise<void> }).fetchModels?.().catch(() => {});
    return [...(started.models ?? [])];
  } finally {
    started.dispose();
  }
}

export interface PullRiskSettings {
  rules: string;
  provider: string | null;
  model: string | null;
}

interface Kept extends InboxPullRiskJudgment {
  head: string;
  /** A hash of the rules it was judged against. */
  rules: string;
  at: string;
}

export interface PullRisk {
  /** The settings, and the judgments of the PRs the last `assess` saw. */
  answer(): InboxPullRiskAnswer;
  /** Start judging what has none yet. Never waits, never throws. */
  assess(pulls: readonly InboxPull[]): void;
  /** Save the dialog. Throws InboxError on a bad input or a config that can't be written. */
  save(input: unknown): void;
  models(provider: string): Promise<InboxPullRiskModels>;
}

export interface PullRiskOptions {
  dataDir: string;
  /** Reads a layer's patch (the Pull requests page's own read). */
  pulls: Pick<InboxPulls, "diff">;
  /** Code review is on: checked again before each run. */
  isOn: () => boolean;
  /** Tests: stand-ins for the agent, the CLIs found and the clock. */
  run?: RiskRunner;
  agents?: () => InboxPullRiskAgent[];
  listModels?: (provider: string, cwd: string) => Promise<CatalogModel[]>;
  now?: () => number;
}

function settingsOf(value: unknown): PullRiskSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    rules: typeof raw.rules === "string" ? raw.rules.trim() : "",
    provider: typeof raw.provider === "string" && raw.provider ? raw.provider : null,
    model: typeof raw.model === "string" && raw.model ? raw.model : null,
  };
}

const hashOf = (rules: string) => createHash("sha256").update(rules).digest("hex").slice(0, 32);

export function createPullRisk(options: PullRiskOptions): PullRisk {
  const now = options.now ?? Date.now;
  const run = options.run ?? defaultRunner;
  const listModels = options.listModels ?? defaultModels;
  const agents = options.agents ?? (() => RISK_AGENTS.filter((a) => installedPath(a.cli)).map(({ id, label }) => ({ id, label })));
  const dir = inboxDir(options.dataDir);
  const file = join(dir, INBOX_PULL_RISK_FILE);
  /** The agent's folder: empty, so it finds no project and no instructions there. */
  const agentDir = join(dir, "pull-risk-agent");
  const settings = () => settingsOf(loadConfig().inboxPullRisk);

  let kept: Map<string, Kept> | null = null;
  const load = (): Map<string, Kept> => {
    if (kept) return kept;
    kept = new Map();
    if (!existsSync(file)) return kept;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; judgments?: Record<string, Kept> };
      if (parsed.v !== 1 || !parsed.judgments || typeof parsed.judgments !== "object") throw new Error("not a risk file");
      for (const [key, value] of Object.entries(parsed.judgments)) {
        if (typeof value?.head === "string" && typeof value.rules === "string" && parseRiskAnswer(JSON.stringify({ risk: value.level, why: value.why }))) kept.set(key, value);
      }
    } catch {
      try {
        renameSync(file, `${file}.unreadable-${Date.now()}`);
      } catch {
        // Judgments are only ever made again.
      }
    }
    return kept;
  };
  const keep = (key: string, judgment: Kept) => {
    const all = load();
    all.delete(key);
    all.set(key, judgment);
    while (all.size > RISK_KEPT_MAX) all.delete(all.keys().next().value!);
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, judgments: Object.fromEntries(all) })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  };

  let listed: readonly InboxPull[] = [];
  const queue: { job: string; pull: InboxPull & { head_sha: string }; rules: string }[] = [];
  const queued = new Set<string>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  const modelLists = new Map<string, Promise<CatalogModel[]>>();
  let running = 0;
  let agentFailed = false;

  const failed = (job: string) => {
    const count = (failures.get(job)?.count ?? 0) + 1;
    failures.set(job, { count, retryAt: now() + Math.min(RISK_RETRY_MS * 2 ** (count - 1), RISK_RETRY_MAX_MS) });
  };

  const judge = async (entry: (typeof queue)[number]) => {
    const { job, pull, rules } = entry;
    const current = settings();
    // The rules changed, or the switch went off, while this waited.
    if (!options.isOn() || !current.rules || hashOf(current.rules) !== rules) return;
    // Only the agent the person chose ever sees a diff.
    const provider = current.provider;
    if (!provider || !agents().some((a) => a.id === provider)) return;
    let patch: string;
    try {
      const diff = await options.pulls.diff(pull.key, "layer");
      // The diff read is the head judged: a push since the list waits for the next list's head.
      if (diff.head_sha !== pull.head_sha) throw new Error("the head moved");
      patch = diff.patch;
    } catch {
      failed(job);
      return;
    }
    mkdirSync(agentDir, { recursive: true });
    let answer: Awaited<ReturnType<RiskRunner>> = null;
    try {
      answer = await run({
        provider,
        model: current.model,
        system: RISK_SYSTEM_PROMPT,
        prompt: buildRiskPrompt({ rules: current.rules, title: pull.title, diff: trimDiffForRisk(patch), fence: riskFence() }),
        cwd: agentDir,
      });
    } catch {
      // Below: the same as no answer.
    }
    const judgment = parseRiskAnswer(answer?.text);
    agentFailed = !judgment;
    if (!judgment) {
      failed(job);
      return;
    }
    failures.delete(job);
    keep(pull.key, { ...judgment, head: pull.head_sha, rules, at: new Date(now()).toISOString() });
  };

  const pump = () => {
    while (running < RISK_CONCURRENCY && queue.length > 0) {
      const entry = queue.shift()!;
      running++;
      void judge(entry)
        .catch(() => failed(entry.job))
        .finally(() => {
          running--;
          queued.delete(entry.job);
          pump();
        });
    }
  };

  return {
    answer() {
      const current = settings();
      const hash = hashOf(current.rules);
      const judgments: InboxPullRiskAnswer["judgments"] = {};
      if (current.rules) {
        const all = load();
        for (const pull of listed) {
          const one = all.get(pull.key);
          if (inboxPullIsOpen(pull) && one && one.head === pull.head_sha && one.rules === hash) judgments[pull.key] = { level: one.level, why: one.why };
        }
      }
      return { ...current, agents: agents(), judgments, pending: queued.size, agent_failed: agentFailed };
    },
    assess(pulls) {
      listed = pulls;
      try {
        const { rules, provider } = settings();
        if (!rules || !provider || !options.isOn() || !agents().some((a) => a.id === provider)) return;
        const hash = hashOf(rules);
        const all = load();
        for (const pull of pulls) {
          if (!inboxPullIsOpen(pull) || !pull.head_sha) continue;
          const one = all.get(pull.key);
          if (one && one.head === pull.head_sha && one.rules === hash) continue;
          const job = `${pull.key}\u0000${pull.head_sha}\u0000${hash}`;
          if (queued.has(job) || now() < (failures.get(job)?.retryAt ?? 0)) continue;
          queued.add(job);
          queue.push({ job, pull: pull as InboxPull & { head_sha: string }, rules: hash });
        }
        pump();
      } catch {
        // The list answers whatever happened here.
      }
    },
    save(input) {
      const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      if (typeof body.rules !== "string" || body.rules.length > INBOX_PULL_RISK_RULES_MAX) throw new InboxError("validation_error", `rules: text of at most ${INBOX_PULL_RISK_RULES_MAX} characters.`, { field: "rules" });
      if (body.provider !== null && typeof body.provider !== "string") throw new InboxError("validation_error", "provider: an agent from the list, or null.", { field: "provider" });
      if (typeof body.provider === "string" && !RISK_AGENTS.some((a) => a.id === body.provider)) throw new InboxError("validation_error", "provider: an agent from the list, or null.", { field: "provider" });
      if (body.model !== null && (typeof body.model !== "string" || body.model.length > 200)) throw new InboxError("validation_error", "model: a model from the list, or null.", { field: "model" });
      const next: PullRiskSettings = { rules: body.rules.trim(), provider: (body.provider as string | null) || null, model: (body.model as string | null) || null };
      if (!saveConfig({ inboxPullRisk: next })) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
      agentFailed = false;
    },
    async models(provider) {
      let list = modelLists.get(provider);
      if (!list) {
        mkdirSync(agentDir, { recursive: true });
        list = listModels(provider, agentDir);
        modelLists.set(provider, list);
      }
      const models = await list.catch(() => [] as CatalogModel[]);
      // A later dialog asks again: this one may have run before the CLI was signed in.
      if (models.length === 0) modelLists.delete(provider);
      return { models: models.map(({ id, label }) => ({ id, label })), default_model: defaultRiskModel(models) };
    },
  };
}
