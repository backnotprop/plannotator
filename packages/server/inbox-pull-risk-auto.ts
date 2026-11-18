import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLayers } from "@plannotator/core/inbox-pull-handoff";
import { inboxPullRiskReaches, type InboxPull, type InboxPullStack, type InboxPullRiskAuto, type InboxPullRiskAutoMake, type InboxPullRiskAutoRun, type InboxPullRiskLevel } from "@plannotator/core/inbox-types";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_PULL_RISK_AUTO_FILE = "pull-risk-auto.json";

export interface PullRiskAutoJob {
  key: string;
  stack: InboxPullStack;
  made: InboxPullRiskAutoMake;
  agent: string | null;
}

export interface PullRiskAutoOptions {
  dataDir: string;
  settings: () => InboxPullRiskAuto | null;
  pullOf: (key: string) => InboxPull | null;
  stackOf: (key: string) => InboxPullStack | null;
  levelOf: (pull: InboxPull) => InboxPullRiskLevel | null;
  hasThread: (pull: InboxPull) => Promise<boolean>;
  start: (job: PullRiskAutoJob) => Promise<{ thread_id: string }>;
  now?: () => number;
}

export interface PullRiskAuto {
  judged(pull: InboxPull, level: InboxPullRiskLevel): void;
  runs(): Record<string, InboxPullRiskAutoRun>;
  resume(): void;
  idle(): Promise<void>;
  stop(): void;
}


export function createPullRiskAuto(options: PullRiskAutoOptions): PullRiskAuto {
  const now = options.now ?? Date.now;
  const dir = inboxDir(options.dataDir);
  const file = join(dir, INBOX_PULL_RISK_AUTO_FILE);
  const runs = new Map<string, InboxPullRiskAutoRun>();
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; runs?: Record<string, InboxPullRiskAutoRun> };
      if (parsed.v !== 1 || !parsed.runs || typeof parsed.runs !== "object") throw new Error("not a pull risk auto file");
      for (const [key, run] of Object.entries(parsed.runs)) {
        if (run && typeof run.at === "string" && (run.state === "queued" || run.state === "started" || run.state === "failed")) runs.set(key, run);
      }
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
      writeFileSync(temp, `${JSON.stringify({ v: 1, runs: Object.fromEntries(runs) })}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {}
  };
  let running: Promise<void> | null = null;
  let stopped = false;
  const checks = new Set<Promise<void>>();

  const levelOfLayers = (layers: readonly InboxPull[]): InboxPullRiskLevel | null => {
    const levels = new Set(layers.map((layer) => options.levelOf(layer)));
    return (["high", "medium", "low"] as const).find((level) => levels.has(level)) ?? null;
  };
  const anyThread = async (layers: readonly InboxPull[]) => (await Promise.all(layers.map((layer) => options.hasThread(layer).catch(() => true)))).some(Boolean);
  const openOf = (key: string) => {
    const stack = options.stackOf(key);
    return stack ? { stack, open: openLayers(stack) } : null;
  };

  const startOne = async (key: string, run: InboxPullRiskAutoRun) => {
    const auto = options.settings();
    const found = openOf(key);
    const open = found?.open ?? [];
    const level = levelOfLayers(open);
    const keys = [...new Set([key, ...open.map((layer) => layer.key)])].filter((one) => one === key || runs.get(one)?.state === "queued");
    if (!auto || !found || !open.some((layer) => layer.key === key) || !level || !inboxPullRiskReaches(level, auto) || (await anyThread(open))) {
      if (!stopped) {
        for (const one of keys) runs.delete(one);
        save();
      }
      return;
    }
    if (stopped || !options.settings()) return;
    let kept: InboxPullRiskAutoRun;
    try {
      const { thread_id } = await options.start({ key, stack: found.stack, made: auto.make, agent: auto.agent ?? null });
      kept = { at: run.at, level, made: auto.make, state: "started", thread_id };
    } catch (error) {
      const reason = (error instanceof Error && error.message ? error.message : "The agent could not start.").replace(/\s*Nothing was sent\.$/, "");
      kept = { at: run.at, level, made: auto.make, state: "failed", thread_id: null, reason };
    }
    for (const one of new Set([key, ...open.map((layer) => layer.key)])) runs.set(one, kept);
    if (!stopped) save();
  };

  const pump = () => {
    if (running || stopped) return;
    if (!options.settings()) {
      const queued = [...runs].filter(([, run]) => run.state === "queued");
      if (queued.length > 0) {
        for (const [key] of queued) runs.delete(key);
        save();
      }
      return;
    }
    const next = [...runs].find(([key, run]) => run.state === "queued" && options.pullOf(key));
    if (!next) return;
    running = startOne(...next).catch(() => {}).finally(() => {
      running = null;
      pump();
    });
  };

  return {
    judged(pull, level) {
      if (stopped) return;
      const auto = options.settings();
      if (!auto || !inboxPullRiskReaches(level, auto)) return;
      const open = openOf(pull.key)?.open ?? [];
      const layers = open.length > 0 ? open : [pull];
      const taken = () => layers.some((layer) => runs.has(layer.key));
      if (taken()) return;
      const check = (async () => {
        if ((await anyThread(layers)) || stopped || taken()) return;
        const at = new Date(now()).toISOString();
        for (const layer of layers) runs.set(layer.key, { at, level, made: auto.make, state: "queued", thread_id: null });
        save();
        pump();
      })().catch(() => {});
      checks.add(check);
      void check.finally(() => checks.delete(check));
    },
    runs() {
      return Object.fromEntries(runs);
    },
    resume: pump,
    async idle() {
      while (running || checks.size > 0) await Promise.all([running, ...checks]);
    },
    stop() {
      stopped = true;
    },
  };
}
