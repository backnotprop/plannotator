/**
 * PR risk ranking in the Inbox (approval "code-review-launch-build", item 4). The
 * person writes what a high-risk pull request is for them (the "no slop rules")
 * and picks a cheap agent. Each PR head the list shows gets one judgment, low,
 * medium or high with one sentence why, in the background, a few at a time.
 *
 *   inbox/pull-risk.json   { v: 1, judgments: { [pull key]: { head, rules, level, why } } }
 *
 * - Runs only while Code review is on and rules exist, and only from the owner's
 *   window's list read (the routes in inbox.ts guard those). Open and draft PRs only.
 * - A judgment belongs to a head and to the rules it was made against (`rules` is a
 *   hash of them, the words stay in config.json): a new head or new rules means a new
 *   judgment, and a restart redoes nothing.
 * - A failed run keeps no judgment and that PR waits (`RISK_RETRY_MS`). Failures in a
 *   row mean the agent itself is broken: nothing runs for a while (`RISK_AGENT_PAUSE_MS`).
 *   It never blocks the list.
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

/**
 * Cheap and good enough for a quick judgment, best first: what the owner named (Sonnet,
 * Terra), then the small models of other makers. Matched on any id a provider lists.
 */
const CHEAP_MODELS = [/sonnet/i, /terra/i, /haiku/i, /flash/i, /(^|[^a-z])mini(?!max)/i, /luna/i, /small|lite/i];

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

/** The agent's whole answer, or null when the run failed. */
export type RiskRunner = (run: RiskRun) => Promise<{ text: string } | null>;

/** Ask a provider that reads its models only on request (Pi, OpenCode). */
const readModels = (provider: AIProvider) => (provider as AIProvider & { fetchModels?: () => Promise<void> }).fetchModels?.().catch(() => {});

/** Run one answer on an AI provider. Any tool use or permission ask ends the run with no answer, and so does the timeout, from the first step. */
export async function runRiskAgent(provider: AIProvider, run: Omit<RiskRun, "provider">, timeoutMs = RISK_RUN_TIMEOUT_MS): Promise<{ text: string } | null> {
  let session: AISession | null = null;
  let over = false;
  const close = (open: AISession) => {
    open.abort();
    open.dispose?.();
  };
  const read = async (): Promise<{ text: string } | null> => {
    // No model saved, and none known yet: find the cheap one instead of running on the person's default.
    if (!run.model && !provider.models?.length) await readModels(provider);
    const model = run.model ?? defaultRiskModel(provider.models ?? []);
    const opened = await provider.createSession({
      context: NO_CONTEXT,
      cwd: run.cwd,
      ...(model ? { model } : {}),
      reasoningEffort: lowestEffort(provider.models, model),
      maxTurns: 1,
      oneShot: { systemPrompt: run.system },
    });
    // It came back after the timeout: nobody is waiting for it.
    if (over) {
      close(opened);
      return null;
    }
    session = opened;
    const whole: string[] = [];
    const deltas: string[] = [];
    let final: string | undefined;
    for await (const message of opened.query(run.prompt)) {
      if (message.type === "tool_use" || message.type === "permission_request" || message.type === "error") return null;
      if (message.type === "text") whole.push(message.text);
      if (message.type === "text_delta") deltas.push(message.delta);
      if (message.type === "result") {
        if (!message.success) return null;
        final = message.result;
      }
    }
    const text = final || whole.join("") || deltas.join("");
    return text ? { text } : null;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)))]);
  } finally {
    over = true;
    clearTimeout(timer);
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
  /** A hash of the rules it was judged against. */
  rules: string;
}

export interface PullRisk {
  /** The settings, and the judgments of the PRs the last `assess` saw. */
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
  const modelLists = new Map<string, Promise<CatalogModel[]>>();
  /** The providers running now, for `stop`. */
  const live = new Set<AIProvider>();
  let running = 0;
  let agentFailed = false;
  let failuresInARow = 0;
  let agentPausedUntil = 0;
  let stopped = false;

  const run: RiskRunner =
    options.run ??
    (async (one) => {
      const provider = await startProvider(one.provider, one.cwd);
      if (!provider) return null;
      if (stopped) {
        provider.dispose();
        return null;
      }
      live.add(provider);
      try {
        return await runRiskAgent(provider, one);
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
    let patch: string;
    try {
      const diff = await options.pulls.diff(pull.key, "layer");
      // The diff read is the head judged: a push since the list waits for the next list's head.
      if (diff.head_sha !== pull.head_sha) throw new Error("the head moved");
      patch = diff.patch;
    } catch (cause) {
      // Too large stays too large at this head: it shows as not ranked, and isn't read again.
      waits.set(job, (cause as { code?: string })?.code === "pull_diff_too_large" ? Number.POSITIVE_INFINITY : now() + RISK_RETRY_MS);
      return;
    }
    // The Inbox stopped during that read: no agent starts now.
    if (stopped) return;
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
    if (stopped) return;
    const judgment = parseRiskAnswer(answer?.text);
    agentFailed = !judgment;
    if (!judgment) {
      waits.set(job, now() + RISK_RETRY_MS);
      failuresInARow++;
      if (failuresInARow >= RISK_AGENT_FAILURES) agentPausedUntil = now() + RISK_AGENT_PAUSE_MS;
      return;
    }
    failuresInARow = 0;
    waits.delete(job);
    keep(pull.key, { ...judgment, head: pull.head_sha, rules });
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
      if (stopped || now() < agentPausedUntil) return;
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
      agentFailed = false;
      failuresInARow = 0;
      agentPausedUntil = 0;
      waits.clear();
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
    stop() {
      stopped = true;
      queue.length = 0;
      queued.clear();
      for (const provider of live) provider.dispose();
      live.clear();
    },
  };
}
