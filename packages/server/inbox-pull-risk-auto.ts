import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handoffStack, openLayers } from "@plannotator/core/inbox-pull-handoff";
import {
  INBOX_PULL_RISK_AUTO_TRIES,
  inboxPullRiskReaches,
  type InboxPull,
  type InboxPullStack,
  type InboxPullRiskAuto,
  type InboxPullRiskAutoMake,
  type InboxPullRiskAutoRun,
  type InboxPullRiskLevel,
} from "@plannotator/core/inbox-types";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import type { PullRiskEarlier } from "./inbox-pull-risk";

export const INBOX_PULL_RISK_AUTO_FILE = "pull-risk-auto.json";
export const PULL_RISK_AUTO_QUEUE_MAX = 3;
export const PULL_RISK_AUTO_RUN_TIMEOUT_MS = 3 * 60 * 60_000;
export const PULL_RISK_AUTO_RETRY_MS = 15 * 60_000;

export interface PullRiskAutoJob {
  key: string;
  stack: InboxPullStack;
  made: InboxPullRiskAutoMake;
  agent: string | null;
  level: InboxPullRiskLevel;
}

export interface PullRiskAutoOptions {
  dataDir: string;
  settings: () => InboxPullRiskAuto | null;
  listed: () => readonly InboxPull[];
  covered: () => ReadonlySet<string>;
  pullOf: (key: string) => InboxPull | null;
  stackOf: (key: string) => InboxPullStack | null;
  levelOf: (pull: InboxPull) => InboxPullRiskLevel | null;
  hasThread: (pull: InboxPull) => Promise<boolean>;
  settled: (run: InboxPullRiskAutoRun & { thread_id: string }) => boolean;
  start: (job: PullRiskAutoJob) => Promise<{ thread_id: string }>;
  now?: () => number;
}

export interface PullRiskAuto {
  judged(pull: InboxPull, level: InboxPullRiskLevel, earlier?: PullRiskEarlier): void;
  runs(): Record<string, InboxPullRiskAutoRun>;
  resume(): void;
  wouldStart(): Promise<Record<InboxPullRiskAuto["level"], number>>;
  waiting(): Promise<Record<InboxPullRiskAuto["level"], string[]>>;
  makeNow(keys?: readonly string[]): Promise<void>;
  notNow(keys: readonly string[]): Promise<void>;
  dismissed(): ReadonlySet<string>;
  idle(): Promise<void>;
  stop(): void;
}

const RANK: Record<InboxPullRiskLevel, number> = { high: 2, medium: 1, low: 0 };

export const pullRiskAutoHanded = (job: Pick<PullRiskAutoJob, "stack" | "key">): InboxPullStack => handoffStack(job.stack, {}, null, job.key) ?? job.stack;

export const pullRiskAutoMayStart = (layers: readonly InboxPull[]): boolean => layers.length > 0 && layers.every((layer) => layer.state === "open" && (layer.mine || layer.author_member === true));

export function createPullRiskAuto(options: PullRiskAutoOptions): PullRiskAuto {
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const dir = inboxDir(options.dataDir);
  const file = join(dir, INBOX_PULL_RISK_AUTO_FILE);
  const runs = new Map<string, InboxPullRiskAutoRun>();
  const fresh = new Set<string>();
  const seen = new Map<string, number>();
  const dismissed = new Set<string>();
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; runs?: Record<string, InboxPullRiskAutoRun>; fresh?: unknown; seen?: unknown; dismissed?: unknown };
      if (parsed.v !== 1 || !parsed.runs || typeof parsed.runs !== "object") throw new Error("not a pull risk auto file");
      const knowsFresh = Array.isArray(parsed.fresh);
      for (const [key, run] of Object.entries(parsed.runs)) {
        if (run && typeof run.at === "string" && ((knowsFresh && run.state === "queued") || run.state === "started" || run.state === "failed")) runs.set(key, run);
      }
      if (Array.isArray(parsed.fresh)) for (const key of parsed.fresh) if (typeof key === "string") fresh.add(key);
      if (Array.isArray(parsed.dismissed)) for (const key of parsed.dismissed) if (typeof key === "string") dismissed.add(key);
      if (parsed.seen && typeof parsed.seen === "object") for (const [repo, number] of Object.entries(parsed.seen)) if (typeof number === "number") seen.set(repo, number);
    } catch {
      try {
        renameSync(file, `${file}.unreadable-${Date.now()}`);
      } catch {}
    }
  }
  const save = () => {
    try {
      mkdirSync(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, runs: Object.fromEntries(runs), fresh: [...fresh], seen: Object.fromEntries(seen), dismissed: [...dismissed] })}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {}
  };
  let running: Promise<void> | null = null;
  let stopped = false;
  const checking = new Set<string>();
  let checkingJobs = 0;
  const checks = new Set<Promise<void>>();

  const levelOfLayers = (layers: readonly InboxPull[]): InboxPullRiskLevel | null => {
    const levels = new Set(layers.map((layer) => options.levelOf(layer)));
    return (["high", "medium", "low"] as const).find((level) => levels.has(level)) ?? null;
  };
  const anyThread = async (layers: readonly InboxPull[]) => (await Promise.all(layers.map((layer) => options.hasThread(layer).catch(() => true)))).some(Boolean);
  const openOf = (key: string) => {
    const stack = options.stackOf(key);
    return stack ? { stack, open: openLayers(pullRiskAutoHanded({ stack, key })) } : null;
  };
  const retryable = (run: InboxPullRiskAutoRun) => run.state === "failed" && (run.tries ?? 1) < INBOX_PULL_RISK_AUTO_TRIES && now() - Date.parse(run.failed_at ?? run.at) >= PULL_RISK_AUTO_RETRY_MS;
  const taken = (layers: readonly InboxPull[]) => layers.some((layer) => checking.has(layer.key) || (runs.has(layer.key) && !retryable(runs.get(layer.key)!)));
  const queuedJobs = () => new Set([...runs].filter(([, run]) => run.state === "queued").map(([key, run]) => run.ranked ?? key)).size + checkingJobs;
  const dropQueued = (keep: (key: string, run: InboxPullRiskAutoRun) => boolean) => {
    const gone = [...runs].filter(([key, run]) => run.state === "queued" && !keep(key, run));
    for (const [key] of gone) runs.delete(key);
    if (gone.length > 0) save();
  };

  const turnedOff = () => {
    dropQueued(() => false);
    const failed = [...runs].filter(([, run]) => run.state === "failed");
    for (const [key] of failed) runs.delete(key);
    if (failed.length === 0 && fresh.size === 0 && seen.size === 0 && dismissed.size === 0) return;
    fresh.clear();
    seen.clear();
    dismissed.clear();
    save();
  };
  const repoOf = (pull: Pick<InboxPull, "host" | "repo">) => `${pull.host}/${pull.repo}`.toLowerCase();
  const watch = (pulls: readonly InboxPull[]) => {
    let changed = false;
    for (const repo of options.covered()) {
      if (seen.has(repo)) continue;
      seen.set(repo, Math.max(0, ...pulls.filter((pull) => repoOf(pull) === repo).map((pull) => pull.number)));
      changed = true;
    }
    if (changed) save();
  };

  const busy = (): boolean => {
    let live = false;
    let changed = false;
    for (const run of new Set(runs.values())) {
      if (run.state !== "started" || run.done || !run.thread_id) continue;
      const over = now() - Date.parse(run.started_at ?? run.at) >= PULL_RISK_AUTO_RUN_TIMEOUT_MS;
      let settled = over;
      if (!settled) {
        try {
          settled = options.settled({ ...run, thread_id: run.thread_id });
        } catch {}
      }
      if (settled) {
        run.done = true;
        changed = true;
      } else live = true;
    }
    if (changed) save();
    return live;
  };

  const startOne = async (key: string, run: InboxPullRiskAutoRun) => {
    const auto = options.settings();
    const found = openOf(key);
    const open = found?.open ?? [];
    const level = levelOfLayers(open);
    const keys = [...new Set([key, ...open.map((layer) => layer.key), ...[...runs].filter(([, one]) => one.state === "queued" && one.ranked === key).map(([one]) => one)])].filter((one) => one === key || runs.get(one)?.state === "queued");
    if (!auto || !found || !open.some((layer) => layer.key === key) || !level || !inboxPullRiskReaches(level, auto) || !pullRiskAutoMayStart(open) || (await anyThread(open))) {
      if (!stopped) {
        for (const one of keys) {
          runs.delete(one);
          fresh.delete(one);
        }
        save();
      }
      return;
    }
    if (stopped || !options.settings()) return;
    let kept: InboxPullRiskAutoRun;
    try {
      const { thread_id } = await options.start({ key, stack: found.stack, made: auto.make, agent: auto.agent ?? null, level });
      kept = { at: run.at, level, made: auto.make, state: "started", thread_id, started_at: iso() };
    } catch (error) {
      const reason = (error instanceof Error && error.message ? error.message : "The agent could not start.").replace(/\s*Nothing was sent\.$/, "");
      kept = { at: run.at, level, made: auto.make, state: "failed", thread_id: null, reason, tries: (run.tries ?? 0) + 1, failed_at: iso() };
    }
    for (const one of keys) {
      runs.delete(one);
      fresh.delete(one);
    }
    for (const one of new Set([key, ...open.map((layer) => layer.key)])) {
      runs.set(one, kept);
      fresh.delete(one);
    }
    if (!stopped) save();
  };

  const pump = (auto: InboxPullRiskAuto | null = options.settings()) => {
    if (running || stopped) return;
    if (!auto) {
      turnedOff();
      return;
    }
    if (busy()) return;
    const next = [...runs].find(([key, run]) => run.state === "queued" && (run.ranked ?? key) === key && options.pullOf(key));
    if (!next) return;
    running = startOne(...next)
      .catch(() => {})
      .finally(() => {
        running = null;
        pump();
      });
  };

  const enqueue = (pull: InboxPull, level: InboxPullRiskLevel, auto: InboxPullRiskAuto) => {
    const open = openOf(pull.key)?.open ?? [];
    const layers = open.length > 0 ? open : [pull];
    if (!pullRiskAutoMayStart(layers) || taken(layers) || queuedJobs() >= PULL_RISK_AUTO_QUEUE_MAX) return;
    const tries = Math.max(0, ...layers.map((layer) => runs.get(layer.key)?.tries ?? 0));
    for (const layer of layers) checking.add(layer.key);
    checkingJobs++;
    const check = (async () => {
      try {
        if (stopped) return;
        if (await anyThread(layers)) {
          if (fresh.delete(pull.key)) save();
          return;
        }
        const run: InboxPullRiskAutoRun = { at: iso(), level, made: auto.make, state: "queued", thread_id: null, ranked: pull.key, ...(tries > 0 ? { tries } : {}) };
        for (const layer of layers) runs.set(layer.key, run);
        save();
      } finally {
        for (const layer of layers) checking.delete(layer.key);
        checkingJobs--;
      }
      pump();
    })().catch(() => {});
    checks.add(check);
    void check.finally(() => checks.delete(check));
  };

  const waitingBefore = async () => {
    const found: { pull: InboxPull; level: InboxPullRiskLevel }[] = [];
    if (!options.settings()) return found;
    for (const pull of options.listed()) {
      if (pull.state !== "open" || fresh.has(pull.key) || checking.has(pull.key)) continue;
      const level = !runs.has(pull.key) && pullRiskAutoMayStart(openOf(pull.key)?.open ?? [pull]) ? options.levelOf(pull) : null;
      if (!level || level === "low" || (await options.hasThread(pull).catch(() => true))) continue;
      found.push({ pull, level });
    }
    return found;
  };

  const waitingStacks = async () => {
    const stacks = new Map<string, { key: string; level: InboxPullRiskLevel; pulls: InboxPull[] }>();
    for (const { pull, level } of await waitingBefore()) {
      const id = options.stackOf(pull.key)?.id ?? pull.key;
      const group = stacks.get(id);
      if (!group) stacks.set(id, { key: pull.key, level, pulls: [pull] });
      else {
        group.pulls.push(pull);
        if (group.level !== "high" && level === "high") Object.assign(group, { key: pull.key, level });
      }
    }
    return [...stacks.values()];
  };

  const api: PullRiskAuto = {
    judged(pull, level, earlier = "none") {
      if (stopped) return;
      const auto = options.settings();
      const reaches = !!auto && inboxPullRiskReaches(level, auto);
      if (reaches) watch([...options.listed(), pull]);
      const isNew = earlier === "new_head" || (earlier === "none" && pull.number > (seen.get(repoOf(pull)) ?? Infinity));
      const marked = reaches && isNew && !runs.has(pull.key);
      if (marked && !fresh.has(pull.key)) {
        fresh.add(pull.key);
        save();
      } else if (!reaches && fresh.delete(pull.key)) save();
      if (auto && marked) enqueue(pull, level, auto);
    },
    runs() {
      return Object.fromEntries(runs);
    },
    resume() {
      if (stopped) return;
      const auto = options.settings();
      const listed = options.listed();
      const known = new Set(listed.map((pull) => pull.key));
      dropQueued((key, run) => !!auto && known.has(key) && known.has(run.ranked ?? key));
      if (!auto) {
        turnedOff();
        return;
      }
      watch(listed);
      const waiting = listed
        .filter((pull) => pull.state === "open" && (runs.has(pull.key) ? retryable(runs.get(pull.key)!) : fresh.has(pull.key)))
        .map((pull) => ({ pull, level: options.levelOf(pull) }))
        .filter((one): one is { pull: InboxPull; level: InboxPullRiskLevel } => !!one.level && inboxPullRiskReaches(one.level, auto))
        .sort((a, b) => RANK[b.level] - RANK[a.level] || b.pull.updated_at.localeCompare(a.pull.updated_at));
      for (const { pull, level } of waiting) enqueue(pull, level, auto);
      pump(auto);
    },
    async wouldStart() {
      const keys = await api.waiting();
      return { high: keys.high.length, medium: keys.medium.length };
    },
    async waiting() {
      const groups = await waitingStacks();
      return { high: groups.filter((group) => group.level === "high").map((group) => group.key), medium: groups.map((group) => group.key) };
    },
    async makeNow(keys) {
      const auto = options.settings();
      if (stopped || !auto) return;
      const wanted = keys ? new Set(keys) : null;
      const chosen = (await waitingStacks()).filter((group) => inboxPullRiskReaches(group.level, auto) && (!wanted || wanted.has(group.key)));
      if (chosen.length === 0) return;
      for (const group of chosen) for (const pull of group.pulls) fresh.add(pull.key);
      save();
      api.resume();
    },
    async notNow(keys) {
      const auto = options.settings();
      if (stopped || !auto) return;
      const waitingNow = new Set((await waitingStacks()).map((group) => group.key));
      const applies = async (key: string) => {
        const pull = options.pullOf(key);
        const level = pull?.state === "open" && !runs.has(key) ? options.levelOf(pull) : null;
        return !!pull && !!level && inboxPullRiskReaches(level, auto) && !(await options.hasThread(pull).catch(() => false));
      };
      const kept = await Promise.all([...dismissed].map(async (key) => (waitingNow.has(key) || (await applies(key)) ? [key] : [])));
      const next = new Set([...kept.flat(), ...keys.filter((key) => waitingNow.has(key))]);
      if (next.size === dismissed.size && [...next].every((key) => dismissed.has(key))) return;
      dismissed.clear();
      for (const key of next) dismissed.add(key);
      save();
    },
    dismissed() {
      return dismissed;
    },
    async idle() {
      while (running || checks.size > 0) await Promise.all([running, ...checks]);
    },
    stop() {
      stopped = true;
    },
  };
  return api;
}
