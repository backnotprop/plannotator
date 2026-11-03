/**
 * The reviews the DSH plugin opens without blocking: the `plannotator` tool's
 * annotate, review and last, and the `/plannotator-*` commands (tool.ts).
 *
 * Each review is a `plannotator` CLI child the plugin starts and owns, not the
 * tool call or command that asked for it. The call waits only until the page
 * is up (the CLI's ready file), bounded, and answers with the URL; the session
 * then ends its turn. When the person decides, the CLI writes its decision to
 * the host result file (`PLANNOTATOR_HOST_RESULT_FILE`, composed from the
 * `dsh` prompts) and exits, and the plugin sends it to the session that opened
 * the review as a new turn, `agent.followup(...)` (through `deliver`). Nothing
 * here waits inside a tool call for a person.
 *
 * Each review has a folder `<data dir>/dsh/<pn-id>/` (0700) for its ready and
 * result files, removed once the decision is delivered. `list` and `close`
 * see only the reviews the asking session opened. Close stops the plugin's own
 * child with SIGTERM (the CLI keeps the reviewer's draft): the CLI's host
 * close needs the session-bridge token, which comes with "Ask this session".
 *
 * No key or token is involved: these launches carry no session bridge yet.
 */

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

/** The subject of a review of the session's own working tree (no target typed). */
export const DSH_LOCAL_CHANGES_SUBJECT = "local changes";

/** The subject of `last`. */
export const DSH_LAST_SUBJECT = "your last message";

/** One review to open. */
export interface DshReviewRequest {
  kind: DshReviewKind;
  /** The CLI's arguments after the subcommand (`annotate <these>`). */
  args: string[];
  /** How it is named until the CLI says what it opened. */
  subject: string;
  /** Deliver a bare approval too: the agent was told to wait for the sign-off. */
  gate: boolean;
  /** The session that gets the decision, lists and closes it (the top-level agent's id). */
  owner: string;
  /** That session's DSH session id (its header id): `last` reads its log, and the CLI tags its children with it. */
  sessionId: string;
  /** The session's working directory: the review's project root. */
  cwd?: string;
}

/** What `open` saw by the time it answered. */
export type DshReviewStart =
  | { state: "ready"; id: string; subject: string; url: string; target?: PlannotatorTarget }
  /** Still starting when the wait ran out: the decision still arrives, or a message saying it did not open. */
  | { state: "starting"; id: string; subject: string }
  | { state: "failed"; message: string };

export interface DshReviewsOptions {
  /** The program and the arguments before the subcommand (`[binary]`; tests pass a fake CLI). */
  command: () => string[] | undefined;
  /** Plannotator's data dir: where each review's folder goes. */
  dataDir: string;
  /** The environment the CLI starts from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** DSH's home (`profileContext.home`), so `last` finds the session's log; else the CLI's default. */
  dshHome?: () => string | undefined;
  /** Put a decision into the session as a new turn. Throws when it cannot (the session is gone). */
  deliver(owner: string, text: string): void;
  /** One line for DSH's log. */
  log(message: string): void;
  /** How long a call waits for the page before answering "starting" (a review prepares a diff). */
  readyWaitMs?: { review: number; other: number };
  /** How often the ready file is looked at while waiting. */
  pollMs?: number;
  now?: () => number;
}

/** The Claude Code mod's and OpenCode's waits. */
const READY_WAIT_MS = { review: 45_000, other: 15_000 };
const STDOUT_LIMIT = 4 * 1024 * 1024;
const STDERR_LIMIT = 16 * 1024;

interface Review {
  readonly id: string;
  readonly request: DshReviewRequest;
  readonly dir: string;
  readonly child: ChildProcess;
  readonly startedAt: number;
  subject: string;
  baseSubject: string;
  url?: string;
  port?: number;
  target?: PlannotatorTarget;
  /** The call that opened it answered "starting". */
  answeredStarting: boolean;
  closedByAgent: boolean;
  exited: boolean;
  startError?: Error;
  stdout: string;
  stderr: string;
}

/** The CLI's host result record (apps/hook/server/host-result.ts): the fields read here. */
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

/**
 * What a decision sends to the session, worded as the Claude Code mod and T3
 * word it: `Plannotator: <subject> (pn-…) — <outcome>.`, its Target line, then
 * the composed message. A Close, a Done with nothing to send and a bare
 * approval send nothing (only logged), except a bare approval of a gated
 * review, which the agent waits for. A review posted to the PR platform is
 * sent (`Review posted`).
 */
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

/** The message a review that answered "starting" sends once its CLI fails after all. */
export function dshLateFailureText(subject: string, id: string, message: string): string {
  return [
    plannotatorDecisionHeading(subject, id, "Did not open"),
    "",
    `Plannotator could not start: ${message}`,
    `Nothing more arrives for ${id}; do not wait for it.`,
  ].join("\n");
}

/** The words a startup failure is reported with: an older CLI's refusal of several files gets the update text. */
export function dshStartFailureText(message: string): string {
  return message === PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT ? message : `Plannotator could not start: ${message}`;
}

/** The variables a child must not inherit from the DSH process: they name another session or launch. */
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

  /**
   * Start one review and answer once its page is up, its start failed, or the
   * wait ran out. Never waits for the person. An abort of `signal` while it
   * waits stops the child and rejects with the signal's reason.
   */
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
      // DSH's process environment is shared by every session: name this one explicitly.
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

    const review: Review = {
      id,
      request,
      dir,
      child,
      startedAt: this.now(),
      subject: request.subject,
      baseSubject: request.subject,
      answeredStarting: false,
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
    });
    child.once("close", (code) => {
      review.exited = true;
      this.settle(review, code);
    });

    const waits = this.options.readyWaitMs ?? READY_WAIT_MS;
    const deadline = this.now() + (request.kind === "review" ? waits.review : waits.other);
    const pollMs = this.options.pollMs ?? 100;
    while (!review.url) {
      this.readReady(review);
      if (review.url) break;
      if (review.exited || review.startError) {
        // Forgotten here too: a child that never started may not emit `close`.
        this.reviews.delete(id);
        if (!review.exited) rmSync(dir, { recursive: true, force: true });
        return { state: "failed", message: this.failureOf(review) };
      }
      if (signal?.aborted) {
        review.closedByAgent = true;
        child.kill("SIGTERM");
        throw abortReason(signal);
      }
      if (this.now() >= deadline) {
        review.answeredStarting = true;
        return { state: "starting", id, subject: review.subject };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return { state: "ready", id, subject: review.subject, url: review.url, ...(review.target !== undefined && { target: review.target }) };
  }

  /** Read the ready file once: the url, port and full target, once the CLI wrote them. */
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
          // Named by what the CLI opened, not the typed words. A review typed with no target stays "local changes".
          const kind = review.request.kind;
          if (kind !== "last" && !(kind === "review" && review.request.subject === DSH_LOCAL_CHANGES_SUBJECT)) {
            review.baseSubject = plannotatorTargetSubject(kind, review.target) ?? review.baseSubject;
          }
          this.relabel(review.request.owner);
        }
        return;
      } catch {
        // A partly written line: read it next time.
      }
    }
  }

  /** Tell the owner's same-named open reviews apart by enough of their paths. */
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

  /** The child exited: send its decision (or say it did not open), then forget it. */
  private settle(review: Review, code: number | null): void {
    // A page that came up just before the exit still counts as opened.
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
      message = dshDecision(record, { kind: request.kind, subject: review.subject, id, gate: request.gate, ...(review.target !== undefined && { target: review.target }) });
    } else if (!review.url) {
      // The call that opened it already reported the failure, unless it answered "starting".
      if (!review.answeredStarting) {
        rmSync(review.dir, { recursive: true, force: true });
        return;
      }
      message = { send: true, text: dshLateFailureText(review.subject, id, this.failureOf(review)) };
    } else if (review.stdout.trim()) {
      // A CLI older than this plugin writes no result file here: its stdout is the feedback.
      message = { send: true, text: `${plannotatorDecisionHeading(review.subject, id, "Feedback", review.target)}\n\n${review.stdout.trim()}` };
    } else {
      message = { send: false, text: `${review.subject} (${id}) ended with no decision (exit code ${code ?? "unknown"}); nothing was sent.` };
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
      // The decision is kept on disk for the person.
      this.options.log(`could not send the decision of ${review.subject} (${id}) to its session (${error instanceof Error ? error.message : String(error)}); it is kept in ${review.dir}`);
    }
  }

  /** The reviews `owner` opened that are still open. */
  private openFor(owner: string): Review[] {
    return [...this.reviews.values()].filter((review) => review.request.owner === owner && !review.closedByAgent);
  }

  /** `list`'s text for `owner`. */
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
        // The CLI's unsent count needs host control (the session-bridge token), which these launches do not carry yet.
        unsent: null,
      };
    });
    return plannotatorToolListText(sessions);
  }

  /** `close`'s text for `owner`: one review by id, or "all". */
  close(owner: string, session: string): string {
    const open = this.openFor(owner);
    const targets = session === "all" ? open : open.filter((review) => review.id === session);
    if (session !== "all" && targets.length === 0) return plannotatorUnknownSessionText(session);
    const outcomes: PlannotatorCloseOutcome[] = targets.map((review) => {
      const { id, subject } = review;
      if (existsSync(join(review.dir, "result.json"))) return { id, subject, closed: false, reason: "decided" };
      if (!review.url) return { id, subject, closed: false, reason: "failed", detail: "its server has not started yet; try again in a moment" };
      if (review.exited || !review.child.kill("SIGTERM")) return { id, subject, closed: false, reason: "failed", detail: "its server process is gone" };
      review.closedByAgent = true;
      return { id, subject, closed: true, unsent: null };
    });
    return plannotatorToolCloseText(outcomes);
  }

  /** The plugin unloads: stop every open review (the CLI keeps each draft); nothing more is sent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const review of this.reviews.values()) {
      if (!review.exited) review.child.kill("SIGTERM");
    }
  }

  /** How many reviews are open (tests). */
  get size(): number {
    return this.reviews.size;
  }
}
