import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxPullRiskReaches, type InboxPull, type InboxPullRiskAuto, type InboxPullRiskAutoMake, type InboxPullRiskAutoRun, type InboxPullRiskLevel } from "@plannotator/core/inbox-types";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_PULL_RISK_AUTO_FILE = "pull-risk-auto.json";

export interface PullRiskAutoJob {
  key: string;
  pull: InboxPull;
  made: InboxPullRiskAutoMake;
  agent: string | null;
}

export interface PullRiskAutoOptions {
  dataDir: string;
  settings: () => InboxPullRiskAuto | null;
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

type Kept = InboxPullRiskAutoRun & { pull?: InboxPull; agent?: string | null };

export function createPullRiskAuto(options: PullRiskAutoOptions): PullRiskAuto {
  const now = options.now ?? Date.now;
  const dir = inboxDir(options.dataDir);
  const file = join(dir, INBOX_PULL_RISK_AUTO_FILE);
  const runs = new Map<string, Kept>();
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; runs?: Record<string, Kept> };
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
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, runs: Object.fromEntries(runs) })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  };
  let running: Promise<void> | null = null;
  let stopped = false;
  const checks = new Set<Promise<void>>();

  const startOne = async (key: string, run: Kept) => {
    if (!run.pull || (await options.hasThread(run.pull).catch(() => false))) {
      runs.delete(key);
      save();
      return;
    }
    try {
      const { thread_id } = await options.start({ key, pull: run.pull, made: run.made, agent: run.agent ?? null });
      runs.set(key, { at: run.at, level: run.level, made: run.made, state: "started", thread_id });
    } catch (error) {
      const reason = (error instanceof Error && error.message ? error.message : "The agent could not start.").replace(/\s*Nothing was sent\.$/, "");
      runs.set(key, { at: run.at, level: run.level, made: run.made, state: "failed", thread_id: null, reason });
    }
    if (!stopped) save();
  };

  const pump = () => {
    if (running || stopped || !options.settings()) return;
    const next = [...runs].find(([, run]) => run.state === "queued");
    if (!next) return;
    running = startOne(...next).finally(() => {
      running = null;
      pump();
    });
  };

  return {
    judged(pull, level) {
      if (stopped || runs.has(pull.key)) return;
      const auto = options.settings();
      if (!auto || !inboxPullRiskReaches(level, auto)) return;
      const check = (async () => {
        if ((await options.hasThread(pull).catch(() => true)) || stopped || runs.has(pull.key)) return;
        runs.set(pull.key, { at: new Date(now()).toISOString(), level, made: auto.make, state: "queued", thread_id: null, pull, agent: auto.agent ?? null });
        save();
        pump();
      })();
      checks.add(check);
      void check.finally(() => checks.delete(check));
    },
    runs() {
      return Object.fromEntries([...runs].map(([key, { pull: _pull, agent: _agent, ...run }]) => [key, run]));
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
