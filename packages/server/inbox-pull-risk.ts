/**
 * PR risk ranking in the Inbox (approval "code-review-launch-build", item 4). The
 * person writes what a high-risk pull request is for them (the "no slop zone rules")
 * and picks an agent and its model. Each PR head the list shows gets one judgment,
 * low, medium or high with one sentence why, in the background, a few at a time. The
 * agent reads the whole diff.
 *
 *   inbox/pull-risk.json   { v: 1, judgments: { [pull key]: { head, rules, level, why } } }
 *
 * - Runs only while Code review is on and rules exist, and only from the owner's
 *   window's list read (the routes in inbox.ts guard those). Open and draft PRs only.
 * - A judgment belongs to a head and to the rules it was made against (`rules` is a
 *   hash of them, the words stay in config.json): a new head or new rules means a new
 *   judgment, and a restart redoes nothing.
 * - A failed run keeps no judgment: the PR shows the reason, a diff too big for the
 *   model or the forge included, and never a level. It waits (`RISK_RETRY_MS`). Failures
 *   in a row mean the agent itself is broken: nothing runs for a while
 *   (`RISK_AGENT_PAUSE_MS`). It never blocks the list.
 * - The agent is an Ask AI provider started for one answer (`oneShot`): no tools where
 *   its CLI allows, in an empty folder. A provider that still reaches for a tool or asks
 *   permission is stopped and its run discarded, so a diff can't get a judgment out of
 *   a run that acted. Codex can't turn its shell off: that is sandboxed read-only.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { resolveWindowsCommandShim } from "@plannotator/ai/providers/command-path";
import { createProvider } from "@plannotator/ai/provider";
import type { AIProvider, AISession, CatalogModel, ClaudeAgentSDKConfig, CodexSDKConfig, PiSDKConfig } from "@plannotator/ai/types";
import { inboxPullIsOpen, type InboxPull, type InboxPullRiskAgent, type InboxPullRiskAnswer, type InboxPullRiskJudgment, type InboxPullRiskModels } from "@plannotator/core/inbox-types";
import { resolveModelChoice } from "@plannotator/core/model-catalog";
import { childPath } from "@plannotator/shared/child-env";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { buildRiskPrompt, parseRiskAnswer, riskFailureLine, riskFence, RISK_SYSTEM_PROMPT } from "./inbox-pull-risk-prompt";
import type { InboxPulls } from "./inbox-pulls";

export const INBOX_PULL_RISK_FILE = "pull-risk.json";
/** A few at a time. */
export const RISK_CONCURRENCY = 3;
/** One judgment gets this long, a large diff's slow answer included: past it the run counts as failed. */
export const RISK_RUN_TIMEOUT_MS = 5 * 60_000;
/** A PR whose run failed waits this long. Longer than the pause, so PRs that keep failing don't take every turn after it. */
export const RISK_RETRY_MS = 60 * 60_000;
/** This many failures in a row mean the agent is broken, not one PR: nothing runs for `RISK_AGENT_PAUSE_MS`. */
export const RISK_AGENT_FAILURES = RISK_CONCURRENCY;
export const RISK_AGENT_PAUSE_MS = 15 * 60_000;

/** The Ask AI providers that can be the risk agent, in the order the dialog offers them. */
const RISK_AGENTS: readonly (InboxPullRiskAgent & { cli: string })[] = [
  { id: "claude-agent-sdk", label: "Claude Code", cli: "claude" },
  { id: "codex-sdk", label: "Codex", cli: "codex" },
  { id: "pi-sdk", label: "Pi", cli: "pi" },
  { id: "opencode-sdk", label: "OpenCode", cli: "opencode" },
];

/** The context a provider's session requires; `oneShot` means its prompt is never used. */
const NO_CONTEXT = { mode: "code-review", review: { patch: "" } } as const;

/** The newest Luna a list offers: `gpt-6-luna` over `gpt-5.6-luna`. */
function newestLuna(models: readonly Pick<CatalogModel, "id">[]): string | null {
  const version = (id: string) => {
    const found = /(\d+)(?:\.(\d+))?/.exec(id);
    return found ? Number(found[1]) * 1000 + Number(found[2] ?? 0) : -1;
  };
  return models.filter((m) => /luna/i.test(m.id)).sort((a, b) => version(b.id) - version(a.id))[0]?.id ?? null;
}

/**
 * The model the dialog starts on: Sonnet for Claude, the newest Luna for Codex. Pi and OpenCode start on the
 * person's own default, null, as the guided review's picker does: only they know what those are set up with.
 */
export function startingRiskModel(provider: string, models: readonly CatalogModel[]): string | null {
  if (provider === "claude-agent-sdk") return resolveModelChoice("sonnet", models);
  if (provider === "codex-sdk") return newestLuna(models) ?? (resolveModelChoice("", models) || null);
  return null;
}

/** The lowest effort a model takes, or nothing for a model that takes none. */
function lowestEffort(models: readonly CatalogModel[] | undefined, model: string | null): string | undefined {
  const efforts = models?.find((m) => m.id === model)?.reasoningEfforts?.map((e) => e.id) ?? [];
  return ["low", "minimal"].find((e) => efforts.includes(e));
}

const realPath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Where an agent's CLI is. A test Inbox only ever finds its own fakes, in the temp folders: never a person's real agents. */
export function installedPath(cli: string): string | null {
  const found = Bun.which(cli, { PATH: childPath() }) ?? null;
  if (!found || !process.env.PLANNOTATOR_TEST_SANDBOX) return found;
  const real = realPath(found);
  return [tmpdir(), "/tmp"].some((dir) => real.startsWith(realPath(dir) + sep)) ? found : null;
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

/** The agent's whole answer, or why there is none, in words a person reads. */
export type RiskRunResult = { text: string } | { failed: string };
export type RiskRunner = (run: RiskRun) => Promise<RiskRunResult>;

/** Ask a provider that reads its models only on request (Pi, OpenCode). */
const readModels = (provider: AIProvider) => (provider as AIProvider & { fetchModels?: () => Promise<void> }).fetchModels?.().catch(() => {});

/**
 * Run one answer on an AI provider. Any tool use or permission ask ends the run with no answer, and so do the timeout
 * and `signal`, from the first step. A CLI or model that refuses (the diff is too big, not signed in) says why here.
 */
export async function runRiskAgent(provider: AIProvider, run: Omit<RiskRun, "provider">, timeoutMs = RISK_RUN_TIMEOUT_MS, signal?: AbortSignal): Promise<RiskRunResult> {
  let session: AISession | null = null;
  let over = false;
  const close = (open: AISession) => {
    open.abort();
    open.dispose?.();
  };
  const read = async (): Promise<RiskRunResult> => {
    const model = run.model ?? startingRiskModel(provider.name, provider.models ?? []);
    const opened = await provider.createSession({
      context: NO_CONTEXT,
      cwd: run.cwd,
      ...(model ? { model } : {}),
      reasoningEffort: lowestEffort(provider.models, model),
      maxTurns: 1,
      oneShot: { systemPrompt: run.system },
    });
    // It came back after the end: nobody is waiting for it.
    if (over) {
      close(opened);
      return { failed: "" };
    }
    session = opened;
    const whole: string[] = [];
    const deltas: string[] = [];
    let final: string | undefined;
    for await (const message of opened.query(run.prompt)) {
      if (message.type === "tool_use" || message.type === "permission_request") return { failed: "The agent tried to use a tool, so its answer was dropped." };
      if (message.type === "error") return { failed: message.error };
      if (message.type === "text") whole.push(message.text);
      if (message.type === "text_delta") deltas.push(message.delta);
      if (message.type === "result") {
        if (!message.success) return { failed: message.result || "The agent stopped with an error." };
        final = message.result;
      }
    }
    const text = final || whole.join("") || deltas.join("");
    return text ? { text } : { failed: "The agent gave no answer." };
  };
  let end: (result: RiskRunResult) => void = () => {};
  const ended = new Promise<RiskRunResult>((resolve) => (end = resolve));
  const minutes = Math.round(timeoutMs / 60_000);
  const timer = setTimeout(() => end({ failed: `The agent took longer than ${minutes} ${minutes === 1 ? "minute" : "minutes"}.` }), timeoutMs);
  const stopped = () => end({ failed: "The Inbox stopped." });
  signal?.addEventListener("abort", stopped);
  try {
    return await Promise.race([read(), ended]);
  } finally {
    over = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", stopped);
    if (session) close(session);
  }
}

/** What the agent offers, read once from its CLI when the dialog asks, then kept. */
async function defaultModels(provider: string, cwd: string): Promise<CatalogModel[]> {
  const started = await startProvider(provider, cwd);
  if (!started) return [];
  try {
    await readModels(started);
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
  /** The branch it was judged against: a retargeted PR is another diff. */
  base: string;
  /** A hash of the rules it was judged against. */
  rules: string;
}

export interface PullRisk {
  /** The settings, and the judgments and failures of the PRs the last `assess` saw. */
  answer(): InboxPullRiskAnswer;
  /** Start judging what has none yet. Never waits, never throws. */
  assess(pulls: readonly InboxPull[]): void;
  /** Save the dialog. Throws InboxError on a bad input or a config that can't be written. */
  save(input: unknown): void;
  models(provider: string): Promise<InboxPullRiskModels>;
  /** The Inbox is stopping: nothing more runs or is written, and running agents are stopped. */
  stop(): void;
}

export interface PullRiskOptions {
  dataDir: string;
  /** Reads a layer's whole diff. */
  pulls: Pick<InboxPulls, "wholeDiff">;
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
        const clean = parseRiskAnswer(JSON.stringify({ risk: value?.level, why: value?.why }));
        if (typeof value?.head === "string" && typeof value.base === "string" && typeof value.rules === "string" && clean) kept.set(key, { head: value.head, base: value.base, rules: value.rules, ...clean });
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
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, judgments: Object.fromEntries(all) })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  };

  let listed: readonly InboxPull[] = [];
  const queue: { job: string; pull: InboxPull & { head_sha: string }; rules: string }[] = [];
  const queued = new Set<string>();
  /** When a job that failed may run again. */
  const waits = new Map<string, number>();
  /** Why a PR has no judgment at that head and those rules. Kept for this run of the Inbox: a restart tries again. */
  const failures = new Map<string, { head: string; base: string; rules: string; reason: string }>();
  const modelLists = new Map<string, Promise<CatalogModel[]>>();
  /** The providers running now, for `stop`. */
  const live = new Set<AIProvider>();
  let running = 0;
  let lastFailure: string | null = null;
  let failuresInARow = 0;
  let agentPausedUntil = 0;
  /** Aborted when the Inbox stops. */
  const stopping = new AbortController();

  const run: RiskRunner =
    options.run ??
    (async (one) => {
      const provider = await startProvider(one.provider, one.cwd);
      if (!provider) return { failed: "The agent could not start." };
      if (stopping.signal.aborted) {
        provider.dispose();
        return { failed: "The Inbox stopped." };
      }
      live.add(provider);
      try {
        return await runRiskAgent(provider, one, RISK_RUN_TIMEOUT_MS, stopping.signal);
      } finally {
        live.delete(provider);
        provider.dispose();
      }
    });

  const judge = async (entry: (typeof queue)[number]) => {
    const { job, pull, rules } = entry;
    if (now() < agentPausedUntil) return;
    const current = settings();
    // The rules changed, or the switch went off, while this waited.
    if (!options.isOn() || !current.rules || hashOf(current.rules) !== rules) return;
    // Only the agent the person chose ever sees a diff.
    const provider = current.provider;
    if (!provider || !agents().some((a) => a.id === provider)) return;
    const failed = (reason: string) => {
      failures.set(pull.key, { head: pull.head_sha, base: pull.base, rules, reason });
    };
    let patch: string;
    try {
      const diff = await options.pulls.wholeDiff(pull.key, stopping.signal);
      // The diff read is the head judged: a push since the list waits for the next list's head.
      if (diff.head_sha !== pull.head_sha) {
        waits.set(job, now() + RISK_RETRY_MS);
        return;
      }
      patch = diff.patch;
    } catch (cause) {
      const { code, message } = cause as { code?: string; message?: string };
      waits.set(job, now() + RISK_RETRY_MS);
      // A forge's words only come with its code; anything else is no sentence for a person.
      failed((code && message) || "The diff could not be read.");
      return;
    }
    // The Inbox stopped during that read: no agent starts now.
    if (stopping.signal.aborted) return;
    mkdirSync(agentDir, { recursive: true });
    let result: RiskRunResult;
    try {
      result = await run({
        provider,
        model: current.model,
        system: RISK_SYSTEM_PROMPT,
        prompt: buildRiskPrompt({ rules: current.rules, title: pull.title, diff: patch, fence: riskFence() }),
        cwd: agentDir,
      });
    } catch (cause) {
      result = { failed: (cause instanceof Error && cause.message) || "The agent could not start." };
    }
    if (stopping.signal.aborted) return;
    const judgment = "text" in result ? parseRiskAnswer(result.text) : null;
    if (!judgment) {
      // An answer that is no ranking may still say why: "Prompt is too long" comes back as a CLI's ordinary answer.
      const reason = riskFailureLine("failed" in result ? result.failed : `The agent didn\u2019t answer with a ranking: ${result.text}`) || "The agent gave no answer.";
      failed(reason);
      lastFailure = reason;
      waits.set(job, now() + RISK_RETRY_MS);
      failuresInARow++;
      if (failuresInARow >= RISK_AGENT_FAILURES) agentPausedUntil = now() + RISK_AGENT_PAUSE_MS;
      return;
    }
    lastFailure = null;
    failuresInARow = 0;
    waits.delete(job);
    keep(pull.key, { ...judgment, head: pull.head_sha, base: pull.base, rules });
  };

  const pump = () => {
    while (running < RISK_CONCURRENCY && queue.length > 0) {
      const entry = queue.shift()!;
      running++;
      void judge(entry)
        .catch(() => waits.set(entry.job, now() + RISK_RETRY_MS))
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
      const failed: InboxPullRiskAnswer["failed"] = {};
      if (current.rules) {
        const all = load();
        for (const pull of listed) {
          const one = all.get(pull.key);
          if (!inboxPullIsOpen(pull)) continue;
          if (one && one.head === pull.head_sha && one.base === pull.base && one.rules === hash) {
            judgments[pull.key] = { level: one.level, why: one.why };
            continue;
          }
          const failure = failures.get(pull.key);
          if (failure && failure.head === pull.head_sha && failure.base === pull.base && failure.rules === hash) failed[pull.key] = failure.reason;
        }
      }
      return { ...current, agents: agents(), judgments, failed, pending: queued.size, last_failure: lastFailure };
    },
    assess(pulls) {
      listed = pulls;
      if (stopping.signal.aborted || now() < agentPausedUntil) return;
      try {
        const { rules, provider } = settings();
        if (!rules || !provider || !options.isOn() || !agents().some((a) => a.id === provider)) return;
        const hash = hashOf(rules);
        const all = load();
        for (const pull of pulls) {
          if (!inboxPullIsOpen(pull) || !pull.head_sha) continue;
          const one = all.get(pull.key);
          if (one && one.head === pull.head_sha && one.base === pull.base && one.rules === hash) continue;
          const job = `${pull.key}\u0000${pull.head_sha}\u0000${pull.base}\u0000${hash}`;
          if (queued.has(job) || now() < (waits.get(job) ?? 0)) continue;
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
      if (typeof body.rules !== "string") throw new InboxError("validation_error", "rules: text.", { field: "rules" });
      if (body.provider !== null && typeof body.provider !== "string") throw new InboxError("validation_error", "provider: an agent from the list, or null.", { field: "provider" });
      if (typeof body.provider === "string" && !RISK_AGENTS.some((a) => a.id === body.provider)) throw new InboxError("validation_error", "provider: an agent from the list, or null.", { field: "provider" });
      if (body.model !== null && typeof body.model !== "string") throw new InboxError("validation_error", "model: a model from the list, or null.", { field: "model" });
      const next: PullRiskSettings = { rules: body.rules.trim(), provider: (body.provider as string | null) || null, model: (body.model as string | null) || null };
      if (!saveConfig({ inboxPullRisk: next })) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
      // The person just looked at this: start over, with whatever they changed.
      lastFailure = null;
      failuresInARow = 0;
      agentPausedUntil = 0;
      waits.clear();
      failures.clear();
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
      return { models: models.map(({ id, label }) => ({ id, label })), default_model: startingRiskModel(provider, models) };
    },
    stop() {
      stopping.abort();
      queue.length = 0;
      queued.clear();
      for (const provider of live) provider.dispose();
      live.clear();
    },
  };
}
