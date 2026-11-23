/**
 * PR risk ranking in the Inbox (approval "code-review-launch-build", item 4). The
 * person writes what a high-risk pull request is for them (the "no slop zone rules")
 * and picks an agent and its model. Each PR head the list shows gets one judgment,
 * low, medium or high with one sentence why, in the background, a few at a time. The
 * agent reads the whole diff.
 *
 *   inbox/pull-risk.json   { v: 1, judgments: { [pull key]: { head, base, rules, level, why, where? } } }
 *
 * - A high judgment may name its places in the diff (`where`, context notes,
 *   approval "inbox-context-notes"): checked against the diff that was judged
 *   when it is made, kept beside it, and shown on the PR's diff. Kept only when
 *   the diff judged is the one the PR's diff draws (the forge's one document):
 *   a per-file read, a clone's diff or a too-large one draws none of them.
 *
 * - Runs only while Code review is on and rules exist, and only from the owner's
 *   window's list read (the routes in inbox.ts guard those). Open and draft PRs only.
 * - A judgment belongs to a head, to the base it was read against and to the rules it
 *   was made against (`rules` is a hash of them, the words stay in config.json): a new
 *   head, a PR retargeted to another base or new rules means a new
 *   judgment, and a restart redoes nothing.
 * - A failed run keeps no judgment: the PR shows the reason, a diff too big for the
 *   model included, and never a level. It waits (`RISK_RETRY_MS`). A forge that won't
 *   serve the diff as one document is read file by file (`wholeDiff`), and a Low from
 *   a read known to be incomplete is kept as Medium. A diff a clone on this computer
 *   gave whole, which the agent finds too long, is tried once more as the forge gave it
 *   (its held-back files as their headers), and is then a read known to be incomplete.
 *   Failures in a row mean the agent itself is broken: nothing runs for a while
 *   (`RISK_AGENT_PAUSE_MS`); a diff too long for the model is that PR's alone and
 *   doesn't count. It never blocks the list.
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
import { AI_ERROR_CONTEXT_WINDOW_EXCEEDED, type AIProvider, type AISession, type CatalogModel, type ClaudeAgentSDKConfig, type CodexSDKConfig, type PiSDKConfig } from "@plannotator/ai/types";
import { inboxPullIsOpen, inboxPullRepoKey, inboxPullRiskAutoOf, type InboxPull, type InboxPullRiskAgent, type InboxPullRiskAnswer, type InboxPullRiskAuto, type InboxPullRiskAutoRun, type InboxPullRiskJudgment, type InboxPullRiskModels } from "@plannotator/core/inbox-types";
import { resolveModelChoice } from "@plannotator/core/model-catalog";
import { childPath } from "@plannotator/shared/child-env";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { buildRiskPrompt, parseRiskAnswer, riskFailureLine, riskFence, RISK_SYSTEM_PROMPT } from "./inbox-pull-risk-prompt";
import { INBOX_PULL_DIFF_MAX_BYTES, type InboxPulls } from "./inbox-pulls";

export const INBOX_PULL_RISK_FILE = "pull-risk.json";

export type PullRiskEarlier = "none" | "same_head" | "new_head";
const earlierOf = (one: { head: string } | undefined, pull: Pick<InboxPull, "head_sha">): PullRiskEarlier => (!one ? "none" : one.head === pull.head_sha ? "same_head" : "new_head");
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

/**
 * The agent's whole answer, or why there is none, in words a person reads. `tooLong`: the provider itself said the
 * prompt was past the model's context (an error code, not words).
 */
export type RiskRunResult = { text: string } | { failed: string; tooLong?: true };

/** A reported branch to judge: its risk key (`inboxBranchRiskKey`), head, base, title for the prompt, and its diff's read. */
export interface RiskBranch {
  key: string;
  head_sha: string;
  base: string;
  title: string;
  read: (signal: AbortSignal) => Promise<string>;
}

/** What a judgment reads: the diff, and how whole it is. */
interface RiskDiff {
  head_sha: string | null;
  patch: string;
  partial: boolean;
  held_back?: string | null;
  per_file?: boolean;
}
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
      if (message.type === "error") return message.code === AI_ERROR_CONTEXT_WINDOW_EXCEEDED ? { failed: message.error, tooLong: true } : { failed: message.error };
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
  /** Rank the branches agents report too (Branch reviews): off unless the person turned it on. */
  branches: boolean;
  auto: InboxPullRiskAuto | null;
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
  assess(pulls: readonly InboxPull[], read?: { covered?: readonly string[]; board?: boolean }): void;
  /**
   * A branch an agent just reported (Branch reviews): judged once at that head, only while the person's `branches`
   * switch is on. Never waits, never throws. Nothing else ever queues a branch.
   */
  assessBranch(branch: RiskBranch): void;
  /** A reported branch's judgment at that head and base under the current rules, or why it failed; nulls when none. */
  branchJudgment(key: string, head: string | null, base: string | null): { judgment: InboxPullRiskJudgment | null; failed: string | null };
  /** A reported branch's judgment at that head and base under the current rules is waiting or running. */
  branchPending(key: string, head: string | null, base: string | null): boolean;
  /** A branch may be judged now: the person's `branches` switch, rules, an agent that is here, Code review and Branch reviews on. */
  branchRankable(): boolean;
  levelOf(pull: InboxPull): InboxPullRiskJudgment["level"] | null;
  listed(): readonly InboxPull[];
  /** The repositories (`host/owner/repo`, lowercased) whose every open PR `listed` holds. */
  covered(): ReadonlySet<string>;
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
  /** The clones of a PR's repository on this computer (the Inbox's projects on it): where git reads a diff the forge held back. */
  roots?: (key: string) => Promise<readonly string[]>;
  /** Code review is on: checked again before each run. */
  isOn: () => boolean;
  /** Branch reviews is on (config.json `inboxBranchReviews`): the answer carries `branches`, and a branch may run. Absent: off. */
  branchesOn?: () => boolean;
  /** Tests: stand-ins for the agent, the CLIs found and the clock. */
  run?: RiskRunner;
  agents?: () => InboxPullRiskAgent[];
  listModels?: (provider: string, cwd: string) => Promise<CatalogModel[]>;
  now?: () => number;
  onJudged?: (pull: InboxPull, level: InboxPullRiskJudgment["level"], earlier: PullRiskEarlier) => void;
  autoRuns?: () => Record<string, InboxPullRiskAutoRun>;
}

function settingsOf(value: unknown): PullRiskSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    rules: typeof raw.rules === "string" ? raw.rules.trim() : "",
    provider: typeof raw.provider === "string" && raw.provider ? raw.provider : null,
    model: typeof raw.model === "string" && raw.model ? raw.model : null,
    branches: raw.branches === true,
    auto: inboxPullRiskAutoOf(raw.auto),
  };
}

/** The agent's words for a prompt past its model's context: that diff's, not a broken agent's. */
export function isPromptTooLong(text: string): boolean {
  return /prompt is too long|input is too long|too many (input )?tokens|context[ _-]?length[ _-]?exceeded|maximum context length|exceeds? (the |its )?(model'?s? )?context( window)?|context window (is )?exceeded|ran out of room in the model.?s context window|exceeds? the maximum number of (input )?tokens|request[ _-]too[ _-]large/i.test(text);
}

/** A run that ended because its prompt was past the model's context: the provider said so, or its words do. */
export function riskRunTooLong(result: RiskRunResult): boolean {
  if ("failed" in result) return result.tooLong === true || isPromptTooLong(result.failed);
  return isPromptTooLong(result.text);
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
        const clean = parseRiskAnswer(JSON.stringify({ risk: value?.level, why: value?.why, ...(value?.where !== undefined ? { where: value.where } : {}) }));
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

  const branchRankable = (): boolean => {
    try {
      const { rules, provider, branches } = settings();
      return !stopping.signal.aborted && branches && !!options.branchesOn?.() && !!rules && !!provider && options.isOn() && agents().some((a) => a.id === provider);
    } catch {
      return false;
    }
  };

  let listed: readonly InboxPull[] = [];
  let covered = new Set<string>();
  /** A PR's layer or a reported branch: what the prompt and the store need, and how its diff is read. */
  const queue: { job: string; pull: { key: string; head_sha: string; base: string; title: string }; listed?: InboxPull; earlier?: PullRiskEarlier; rules: string; read: (signal: AbortSignal) => Promise<RiskDiff> }[] = [];
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
    const { job, pull, rules, read } = entry;
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
    let patch: string | null;
    let partial: boolean;
    let heldBack: string | null;
    // Whether the diff judged is the one the PR's diff on screen draws (the forge's one document, within its size):
    // only then are a high or medium judgment's places kept, so "See the N places" and the risk bars point only at
    // places the diff can show.
    let onScreen: boolean;
    try {
      const diff = await read(stopping.signal);
      // The diff read is the head judged: a push since the list waits for the next list's head.
      if (diff.head_sha !== pull.head_sha) {
        waits.set(job, now() + RISK_RETRY_MS);
        return;
      }
      patch = diff.patch;
      partial = diff.partial;
      heldBack = diff.held_back ?? null;
      onScreen = !diff.per_file && !diff.partial && Buffer.byteLength(diff.patch, "utf8") <= INBOX_PULL_DIFF_MAX_BYTES;
    } catch (cause) {
      const { code, message } = cause as { code?: string; message?: string };
      waits.set(job, now() + RISK_RETRY_MS);
      // A forge's words only come with its code; anything else is no sentence for a person. A branch's read says its own.
      failed((code && message) || (pull.key.startsWith("branch:") && message) || "The diff could not be read.");
      return;
    }
    // The Inbox stopped during that read: no agent starts now.
    if (stopping.signal.aborted) return;
    mkdirSync(agentDir, { recursive: true });
    const ask = async (diff: string): Promise<RiskRunResult> => {
      try {
        return await run({
          provider,
          model: current.model,
          system: RISK_SYSTEM_PROMPT,
          prompt: buildRiskPrompt({ rules: current.rules, title: pull.title, diff, fence: riskFence() }),
          cwd: agentDir,
        });
      } catch (cause) {
        return { failed: (cause instanceof Error && cause.message) || "The agent could not start." };
      }
    };
    let result = await ask(patch);
    // A judgment's places are checked against the diff it read, held only for that.
    let judgment = "text" in result ? parseRiskAnswer(result.text, { rules: current.rules, patch }) : null;
    // The whole diff is held only for its run.
    patch = null;
    if (stopping.signal.aborted) return;
    // An answer that is no ranking may still say why: "Prompt is too long" comes back as a CLI's ordinary answer.
    if (!judgment && heldBack && riskRunTooLong(result)) {
      // Too long whole, from a clone: once more as the forge gave it, its held-back files as their headers.
      result = await ask(heldBack);
      judgment = "text" in result ? parseRiskAnswer(result.text, { rules: current.rules, patch: heldBack }) : null;
      heldBack = null;
      partial = true;
      onScreen = false;
      if (stopping.signal.aborted) return;
    }
    if (!judgment) {
      const reason = riskFailureLine("failed" in result ? result.failed : `The agent didn\u2019t answer with a ranking: ${result.text}`) || "The agent gave no answer.";
      failed(reason);
      lastFailure = reason;
      waits.set(job, now() + RISK_RETRY_MS);
      // A diff too long for the model is this PR's alone: it says nothing of the agent.
      if (!riskRunTooLong(result)) {
        failuresInARow++;
        if (failuresInARow >= RISK_AGENT_FAILURES) agentPausedUntil = now() + RISK_AGENT_PAUSE_MS;
      }
      return;
    }
    lastFailure = null;
    failuresInARow = 0;
    waits.delete(job);
    // Part of a diff can't show that nothing is touched: Low from it is the rules' "maybe".
    const level = partial && judgment.level === "low" ? "medium" : judgment.level;
    const { where, ...ranked } = judgment;
    keep(pull.key, { ...ranked, level, ...(where && onScreen ? { where } : {}), head: pull.head_sha, base: pull.base, rules });
    if (entry.listed) options.onJudged?.(entry.listed, level, entry.earlier ?? "none");
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
            judgments[pull.key] = { level: one.level, why: one.why, ...(one.where ? { where: one.where } : {}) };
            continue;
          }
          const failure = failures.get(pull.key);
          if (failure && failure.head === pull.head_sha && failure.base === pull.base && failure.rules === hash) failed[pull.key] = failure.reason;
        }
      }
      const { branches, ...shown } = current;
      return { ...shown, ...(options.branchesOn?.() ? { branches } : {}), agents: agents(), judgments, failed, pending: queued.size, last_failure: lastFailure, auto_runs: options.autoRuns?.() ?? {} };
    },
    listed: () => listed,
    covered: () => covered,
    levelOf(pull) {
      const { rules } = settings();
      const one = rules && pull.head_sha ? load().get(pull.key) : undefined;
      return one && one.head === pull.head_sha && one.base === pull.base && one.rules === hashOf(rules) ? one.level : null;
    },
    assess(pulls, read = {}) {
      const repos = new Set(read.covered ?? []);
      if (read.board) {
        const named = new Set([...repos, ...pulls.map((pull) => inboxPullRepoKey(pull.host, pull.repo))]);
        listed = [...listed.filter((pull) => !named.has(inboxPullRepoKey(pull.host, pull.repo))), ...pulls];
        for (const repo of named) {
          if (repos.has(repo)) covered.add(repo);
          else covered.delete(repo);
        }
      } else {
        listed = pulls;
        covered = repos;
      }
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
          // A branch reported and judged at this very head against this base: the PR opened on it is that diff (no places:
          // a branch's judgment keeps none).
          const reported = [...all.entries()].find(([key, kept]) => key.startsWith("branch:") && kept.head === pull.head_sha && kept.base === pull.base && kept.rules === hash)?.[1];
          if (reported) {
            const { where: _where, ...same } = reported;
            keep(pull.key, same);
            options.onJudged?.(pull, same.level, earlierOf(one, pull));
            continue;
          }
          const job = `${pull.key}\u0000${pull.head_sha}\u0000${pull.base}\u0000${hash}`;
          if (queued.has(job) || now() < (waits.get(job) ?? 0)) continue;
          queued.add(job);
          const layer = pull as InboxPull & { head_sha: string };
          queue.push({
            job,
            pull: layer,
            listed: layer,
            earlier: earlierOf(one, pull),
            rules: hash,
            read: async (signal) => options.pulls.wholeDiff(layer.key, signal, options.roots ? await options.roots(layer.key).catch(() => []) : []),
          });
        }
        pump();
      } catch {
        // The list answers whatever happened here.
      }
    },
    assessBranch(branch) {
      if (stopping.signal.aborted || now() < agentPausedUntil) return;
      try {
        const { rules } = settings();
        if (!branchRankable()) return;
        const hash = hashOf(rules);
        const one = load().get(branch.key);
        if (one && one.head === branch.head_sha && one.base === branch.base && one.rules === hash) return;
        const job = `${branch.key}\u0000${branch.head_sha}\u0000${branch.base}\u0000${hash}`;
        if (queued.has(job)) return;
        queued.add(job);
        queue.push({
          job,
          pull: { key: branch.key, head_sha: branch.head_sha, base: branch.base, title: branch.title },
          rules: hash,
          // The branch's diff as git here gives it: whole, and never the one a PR's page draws, so no places.
          read: async (signal) => ({ head_sha: branch.head_sha, patch: await branch.read(signal), partial: false, per_file: true }),
        });
        pump();
      } catch {
        // The report answers whatever happened here.
      }
    },
    branchPending(key, head, base) {
      const { rules } = settings();
      return !!rules && !!head && !!base && queued.has(`${key}\u0000${head}\u0000${base}\u0000${hashOf(rules)}`);
    },
    branchRankable: () => branchRankable(),
    branchJudgment(key, head, base) {
      const current = settings();
      if (!current.rules || !head || !base) return { judgment: null, failed: null };
      const hash = hashOf(current.rules);
      const one = load().get(key);
      if (one && one.head === head && one.base === base && one.rules === hash) return { judgment: { level: one.level, why: one.why }, failed: null };
      const failure = failures.get(key);
      return { judgment: null, failed: failure && failure.head === head && failure.base === base && failure.rules === hash ? failure.reason : null };
    },
    save(input) {
      const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
      if (typeof body.rules !== "string") throw new InboxError("validation_error", "rules: text.", { field: "rules" });
      if (body.provider !== null && typeof body.provider !== "string") throw new InboxError("validation_error", "provider: an agent from the list, or null.", { field: "provider" });
      if (typeof body.provider === "string" && !RISK_AGENTS.some((a) => a.id === body.provider)) throw new InboxError("validation_error", "provider: an agent from the list, or null.", { field: "provider" });
      if (body.model !== null && typeof body.model !== "string") throw new InboxError("validation_error", "model: a model from the list, or null.", { field: "model" });
      if (body.branches !== undefined && typeof body.branches !== "boolean") throw new InboxError("validation_error", "branches: true or false.", { field: "branches" });
      if (body.auto !== undefined && body.auto !== null && !inboxPullRiskAutoOf(body.auto)) throw new InboxError("validation_error", "auto: { level: high or medium, make: guide or picture_it, agent? }, or null.", { field: "auto" });
      const auto = body.auto === undefined ? settings().auto : inboxPullRiskAutoOf(body.auto);
      // Absent (a window from before Branch reviews, or with it off): what the person chose stays.
      const branches = typeof body.branches === "boolean" ? body.branches : settings().branches;
      const next = { rules: body.rules.trim(), provider: (body.provider as string | null) || null, model: (body.model as string | null) || null, ...(branches ? { branches: true } : {}), ...(auto ? { auto } : {}) };
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
