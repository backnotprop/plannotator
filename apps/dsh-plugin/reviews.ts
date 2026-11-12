import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  isOlderCliBundleRefusal,
  PLANNOTATOR_OUTCOME_REVIEW_POSTED,
  PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT,
  plannotatorDecisionHeading,
  plannotatorDecisionSubject,
  plannotatorDistinctSubjects,
  plannotatorSessionId,
  plannotatorTargetSubject,
  plannotatorToolCloseText,
  plannotatorToolListText,
  plannotatorUnknownSessionText,
  type PlannotatorCloseOutcome,
  type PlannotatorSessionSummary,
  type PlannotatorTarget,
} from "../../packages/shared/plannotator-tool";

export type DshReviewKind = "annotate" | "review" | "last";

export const DSH_LOCAL_CHANGES_SUBJECT = "local changes";

export const DSH_LAST_SUBJECT = "your last message";

export interface DshReviewRequest {
  kind: DshReviewKind;
  args: string[];
  subject: string;
  gate: boolean;
  owner: string;
  sessionId: string;
  cwd?: string;
}

export type DshReviewStart =
  | { state: "ready"; id: string; subject: string; url: string; target?: PlannotatorTarget }
  | { state: "starting"; id: string; subject: string }
  | { state: "failed"; message: string };

export interface DshReviewsOptions {
  command: () => string[] | undefined;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  dshHome?: () => string | undefined;
  deliver(owner: string, text: string): void;
  log(message: string): void;
  readyWaitMs?: { review: number; other: number };
  pollMs?: number;
  now?: () => number;
}

const READY_WAIT_MS = { review: 45_000, other: 15_000 };
const STDOUT_LIMIT = 4 * 1024 * 1024;
const STDERR_LIMIT = 16 * 1024;
const KILL_AFTER_MS = 1000;

interface Review {
  readonly id: string;
  readonly request: DshReviewRequest;
  readonly dir: string;
  readonly child: ChildProcess;
  readonly startedAt: number;
  readonly gone: Promise<void>;
  subject: string;
  baseSubject: string;
  url?: string;
  port?: number;
  target?: PlannotatorTarget;
  answered: boolean;
  answeredStarting: boolean;
  decided: boolean;
  closedByAgent: boolean;
  exited: boolean;
  startError?: Error;
  stdout: string;
  stderr: string;
}

interface HostResult {
  surface?: string;
  decision: string;
  message: string;
  noop: boolean;
  platform?: boolean;
  annotationCount?: number;
  target?: PlannotatorTarget;
  closedBy?: string;
}

function readHostResult(path: string): HostResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const record = raw as Record<string, unknown> | null;
  if (!record || typeof record !== "object" || record.v !== 1) return null;
  if (typeof record.decision !== "string" || typeof record.message !== "string" || typeof record.noop !== "boolean") return null;
  const target = record.target;
  const validTarget = typeof target === "string" || (Array.isArray(target) && target.every((item) => typeof item === "string"));
  return {
    ...(typeof record.surface === "string" && { surface: record.surface }),
    decision: record.decision,
    message: record.message,
    noop: record.noop,
    ...(record.platform === true && { platform: true }),
    ...(typeof record.annotationCount === "number" && { annotationCount: record.annotationCount }),
    ...(validTarget && { target: target as PlannotatorTarget }),
    ...(typeof record.closedBy === "string" && { closedBy: record.closedBy }),
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function dshDecision(
  record: HostResult,
  review: { kind: DshReviewKind; subject: string; id: string; gate: boolean; target?: PlannotatorTarget },
): { send: boolean; text: string } {
  if (record.decision === "dismissed") {
    return { send: false, text: `${review.subject} (${review.id}) was closed with no decision; nothing was sent.` };
  }
  const surface = record.surface ?? (review.kind === "last" ? "annotate-last" : review.kind);
  const target = record.target ?? review.target;
  const subject = plannotatorDecisionSubject(review.subject, review.target, target);
  const body = record.message.trim();
  if (surface === "review" && record.platform === true) {
    const heading = plannotatorDecisionHeading(subject, review.id, PLANNOTATOR_OUTCOME_REVIEW_POSTED, target);
    return { send: true, text: body ? `${heading}\n\n${body}` : heading };
  }
  if (record.noop && !(review.gate && record.decision === "approved")) {
    const what = record.decision === "approved" ? "approved with no notes" : "closed with no annotations";
    return { send: false, text: `${subject} (${review.id}) ${what}; nothing was sent.` };
  }
  const count = record.annotationCount;
  const comments = typeof count === "number" && count > 0 ? ` · ${plural(count, "comment", "comments")}` : "";
  const outcome = record.decision === "approved"
    ? record.noop ? "Approved" : `Approved with notes${comments}`
    : surface === "review" ? `Changes requested${comments}` : `Feedback${comments}`;
  const heading = plannotatorDecisionHeading(subject, review.id, outcome, target);
  return { send: true, text: body ? `${heading}\n\n${body}` : heading };
}

export function dshLateFailureText(subject: string, id: string, message: string): string {
  return [
    plannotatorDecisionHeading(subject, id, "Did not open"),
    "",
    `Plannotator could not start: ${message}`,
    `Nothing more arrives for ${id}; do not wait for it.`,
  ].join("\n");
}

export function dshEndedText(subject: string, id: string, detail: string): string {
  return [
    plannotatorDecisionHeading(subject, id, "Ended with no decision"),
    "",
    `Plannotator stopped before the reviewer decided: ${detail}`,
    `Nothing more arrives for ${id}; do not wait for it.`,
  ].join("\n");
}

export function dshStartFailureText(message: string): string {
  return message === PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT ? message : `Plannotator could not start: ${message}`;
}

const INHERITED_LAUNCH_VARIABLES = [
  "DSH_SESSION_ID",
  "DSH_SHELL",
  "PLANNOTATOR_SESSION_TAG",
  "PLANNOTATOR_SESSION_BRIDGE_TOKEN",
  "PLANNOTATOR_SESSION_BRIDGE_HOST",
  "PLANNOTATOR_SESSION_BRIDGE_MODES",
  "PLANNOTATOR_HOST_RESULT_FILE",
  "PLANNOTATOR_HOST_REVIEW_ID",
  "PLANNOTATOR_READY_FILE",
];

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export class DshReviews {
  private readonly reviews = new Map<string, Review>();
  private disposed = false;

  constructor(private readonly options: DshReviewsOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private nextId(): string {
    for (let attempt = 0; attempt < 64; attempt++) {
      const id = plannotatorSessionId(randomBytes(3).toString("hex"));
      if (!this.reviews.has(id) && !existsSync(join(this.options.dataDir, "dsh", id))) return id;
    }
    throw new Error("could not allocate a Plannotator session id");
  }

  async open(request: DshReviewRequest, signal?: AbortSignal): Promise<DshReviewStart> {
    if (this.disposed) return { state: "failed", message: "the Plannotator plugin is unloading" };
    if (signal?.aborted) throw abortReason(signal);
    const command = this.options.command();
    if (!command || command.length === 0 || !command[0]) {
      return { state: "failed", message: "the plannotator CLI was not found (set the plugin's `binary` or PLANNOTATOR_BIN)" };
    }
    const id = this.nextId();
    const dir = join(this.options.dataDir, "dsh", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cwd = request.cwd && isDirectory(request.cwd) ? request.cwd : undefined;
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env) };
    for (const name of INHERITED_LAUNCH_VARIABLES) delete env[name];
    const dshHome = this.options.dshHome?.();
    Object.assign(env, {
      PLANNOTATOR_ORIGIN: "dsh",
      PLANNOTATOR_DATA_DIR: this.options.dataDir,
      PLANNOTATOR_READY_FILE: join(dir, "ready.jsonl"),
      PLANNOTATOR_HOST_RESULT_FILE: join(dir, "result.json"),
      PLANNOTATOR_HOST_REVIEW_ID: id,
      PLANNOTATOR_SESSION_TAG: `dsh:${request.sessionId}`,
      DSH_SESSION_ID: request.sessionId,
      ...(dshHome && { DSH_HOME: dshHome }),
      ...(cwd && { PLANNOTATOR_CWD: cwd }),
    });
    const subcommand = request.kind === "last" ? "annotate-last" : request.kind;
    const [program, ...prefix] = command;

    let child: ChildProcess;
    try {
      child = spawn(program as string, [...prefix, subcommand, ...request.args], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      return { state: "failed", message: error instanceof Error ? error.message : String(error) };
    }

    let markGone!: () => void;
    const review: Review = {
      id,
      request,
      dir,
      child,
      startedAt: this.now(),
      gone: new Promise<void>((resolve) => {
        markGone = resolve;
      }),
      subject: request.subject,
      baseSubject: request.subject,
      answered: false,
      answeredStarting: false,
      decided: false,
      closedByAgent: false,
      exited: false,
      stdout: "",
      stderr: "",
    };
    this.reviews.set(id, review);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (review.stdout.length < STDOUT_LIMIT) review.stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      review.stderr = (review.stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.once("error", (error) => {
      review.startError = error;
      if (child.pid === undefined) markGone();
    });
    child.once("close", (code) => {
      review.exited = true;
      markGone();
      this.settle(review, code);
    });

    const waits = this.options.readyWaitMs ?? READY_WAIT_MS;
    const deadline = this.now() + (request.kind === "review" ? waits.review : waits.other);
    const pollMs = this.options.pollMs ?? 100;
    for (;;) {
      this.readReady(review);
      if (review.exited || review.startError) {
        review.answered = true;
        this.reviews.delete(id);
        if (!review.exited) rmSync(dir, { recursive: true, force: true });
        if (review.decided && review.url) return this.readyStart(review, review.url);
        return { state: "failed", message: this.failureOf(review) };
      }
      if (review.url) {
        review.answered = true;
        return this.readyStart(review, review.url);
      }
      if (signal?.aborted) {
        review.answered = true;
        review.closedByAgent = true;
        this.stop(review);
        await review.gone;
        throw abortReason(signal);
      }
      if (this.now() >= deadline) {
        review.answered = true;
        review.answeredStarting = true;
        return { state: "starting", id, subject: review.subject };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  private readyStart(review: Review, url: string): DshReviewStart {
    return { state: "ready", id: review.id, subject: review.subject, url, ...(review.target !== undefined && { target: review.target }) };
  }

  private stop(review: Review): boolean {
    if (review.exited || review.child.pid === undefined) return false;
    review.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (!review.exited) review.child.kill("SIGKILL");
    }, KILL_AFTER_MS);
    (timer as { unref?: () => void }).unref?.();
    void review.gone.then(() => clearTimeout(timer));
    return true;
  }

  private readReady(review: Review): void {
    if (review.url) return;
    let text: string;
    try {
      text = readFileSync(join(review.dir, "ready.jsonl"), "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      try {
        const value = JSON.parse(line) as { url?: unknown; port?: unknown; target?: unknown };
        if (typeof value.url !== "string" || !value.url) continue;
        review.url = value.url;
        if (typeof value.port === "number") review.port = value.port;
        const target = value.target;
        if (typeof target === "string" || (Array.isArray(target) && target.every((item) => typeof item === "string"))) {
          review.target = target as PlannotatorTarget;
          const kind = review.request.kind;
          if (kind !== "last" && !(kind === "review" && review.request.subject === DSH_LOCAL_CHANGES_SUBJECT)) {
            review.baseSubject = plannotatorTargetSubject(kind, review.target) ?? review.baseSubject;
          }
          this.relabel(review.request.owner);
        }
        return;
      } catch {
      }
    }
  }

  private relabel(owner: string): void {
    const open = this.openFor(owner);
    const subjects = plannotatorDistinctSubjects(open.map((review) => ({ subject: review.baseSubject, ...(review.target !== undefined && { target: review.target }) })));
    open.forEach((review, index) => {
      review.subject = subjects[index] ?? review.baseSubject;
    });
  }

  private failureOf(review: Review): string {
    if (review.startError) return review.startError.message;
    const text = review.stderr.trim();
    if (isOlderCliBundleRefusal(text)) return PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT;
    return text ? text.split(/\r?\n/).slice(-6).join("\n") : `plannotator exited with code ${review.child.exitCode ?? "unknown"} before opening the page`;
  }

  private settle(review: Review, code: number | null): void {
    this.readReady(review);
    this.reviews.delete(review.id);
    if (this.disposed || review.closedByAgent) {
      rmSync(review.dir, { recursive: true, force: true });
      return;
    }
    const { request, id } = review;
    const resultPath = join(review.dir, "result.json");
    const record = existsSync(resultPath) ? readHostResult(resultPath) : null;
    let message: { send: boolean; text: string };
    if (record) {
      review.decided = true;
      message = dshDecision(record, { kind: request.kind, subject: review.subject, id, gate: request.gate, ...(review.target !== undefined && { target: review.target }) });
    } else if (!review.answered || (!review.url && !review.answeredStarting)) {
      rmSync(review.dir, { recursive: true, force: true });
      return;
    } else if (!review.url) {
      message = { send: true, text: dshLateFailureText(review.subject, id, this.failureOf(review)) };
    } else if (review.stdout.trim()) {
      message = { send: true, text: `${plannotatorDecisionHeading(review.subject, id, "Feedback", review.target)}\n\n${review.stdout.trim()}` };
    } else {
      const detail = review.stderr.trim().split(/\r?\n/).slice(-6).join("\n") || `it exited with code ${code ?? "unknown"}`;
      message = { send: true, text: dshEndedText(review.subject, id, detail) };
    }
    if (!message.send) {
      this.options.log(message.text);
      rmSync(review.dir, { recursive: true, force: true });
      return;
    }
    try {
      this.options.deliver(request.owner, message.text);
      rmSync(review.dir, { recursive: true, force: true });
    } catch (error) {
      this.options.log(`could not send the decision of ${review.subject} (${id}) to its session (${error instanceof Error ? error.message : String(error)}); it is kept in ${review.dir}`);
    }
  }

  private openFor(owner: string): Review[] {
    return [...this.reviews.values()].filter((review) => review.request.owner === owner && !review.closedByAgent);
  }

  list(owner: string): string {
    const now = this.now();
    const sessions: PlannotatorSessionSummary[] = this.openFor(owner).map((review) => {
      this.readReady(review);
      return {
        id: review.id,
        kind: review.request.kind,
        subject: review.subject,
        ...(review.url && { url: review.url }),
        ageMs: now - review.startedAt,
        state: !review.url ? "starting" : existsSync(join(review.dir, "result.json")) ? "decided" : "open",
        unsent: null,
      };
    });
    return plannotatorToolListText(sessions);
  }

  close(owner: string, session: string): string {
    const open = this.openFor(owner);
    const targets = session === "all" ? open : open.filter((review) => review.id === session);
    if (session !== "all" && targets.length === 0) return plannotatorUnknownSessionText(session);
    const outcomes: PlannotatorCloseOutcome[] = targets.map((review) => {
      const { id, subject } = review;
      if (existsSync(join(review.dir, "result.json"))) return { id, subject, closed: false, reason: "decided" };
      if (!this.stop(review)) return { id, subject, closed: false, reason: "failed", detail: "its server process is gone" };
      review.closedByAgent = true;
      return { id, subject, closed: true, unsent: null };
    });
    return plannotatorToolCloseText(outcomes);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const review of this.reviews.values()) this.stop(review);
  }

  get size(): number {
    return this.reviews.size;
  }
}
