import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPullSessionBridgeClient } from "@plannotator/ai/session-bridge-pull-client";
import { classifyHostCloseAnswer, readHostStatusAnswer, type HostHttpAnswer } from "@plannotator/shared/host-control";
import {
  parsePlannotatorToolInput, plannotatorToolArgs, plannotatorToolOpenedText,
  plannotatorToolListText, plannotatorToolCloseText, plannotatorUnknownSessionText,
  plannotatorTargetSubject,
  type PlannotatorToolInput, type PlannotatorSessionSummary, type PlannotatorCloseOutcome,
} from "@plannotator/shared/plannotator-tool";
import { privateWrite } from "./auth";
import { hostResultSchema, t3Decision } from "./decision";
import { T3Delivery, T3DeliveryRefused } from "./delivery";
import { T3SessionBridge } from "./session-bridge";
import { T3_TERMINAL, pause, type T3ThreadRead } from "./t3-client";

/**
 * The assistant message `last` opens: the newest one from a run that has
 * finished. A run still going is the one that called `last` (its "opening it
 * now" text) or one not done writing, so its messages are skipped.
 */
export function lastFinishedAssistantMessage(snapshot: T3ThreadRead, threadId: string): T3ThreadRead["items"][number] | undefined {
  const unfinished = new Set(snapshot.recentRuns.filter((run) => !T3_TERMINAL.has(run.status)).map((run) => run.runId));
  if (snapshot.thread.activeRunId) unfinished.add(snapshot.thread.activeRunId);
  return snapshot.items.filter((item) => item.type === "assistant_message" && item.sourceThreadId === threadId
    && item.visibility !== "inherited" && item.visibility !== "synthetic" && item.text
    && !(item.runId && unfinished.has(item.runId))).at(-1);
}

/** A launch with no ready line this long after it was made is abandoned (the opening window is 30 s). */
export const T3_OPEN_ABANDONED_MS = 60_000;
/** How long a delivered review's folder is kept (Claude may still Read its feedback.md). */
export const T3_REVIEW_KEEP_MS = 24 * 60 * 60_000;
/** How long a review that failed or was refused keeps its folder (decision and logs, for a person). */
export const T3_FAILED_REVIEW_KEEP_MS = 7 * 24 * 60 * 60_000;

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
}

interface Review {
  id: string;
  kind: "annotate" | "review" | "last";
  subject: string;
  /** A gated annotate session: its bare approval is sent, since Claude was told to wait for it. */
  gate?: boolean;
  target?: string | string[];
  createdAt: number;
  token: string;
  /** When it was delivered or failed for good. */
  settledAt?: number;
  pid?: number;
  port?: number;
  url?: string;
  delivered?: boolean;
  failure?: string;
  retryAt?: number;
  retryCount?: number;
  deliveryError?: string;
}

export class T3Reviews {
  private readonly reviews = new Map<string, Review>();
  private readonly bridges = new Map<string, AbortController>();
  private readonly sending = new Set<string>();
  private opening = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly directory: string, private readonly command: readonly string[], private readonly cwd: string,
    private readonly dataDir: string, private readonly bridge: T3SessionBridge, private readonly delivery: T3Delivery,
    private readonly notify: (message: string) => void = console.error) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.prune();
    for (const id of readdirSync(directory)) {
      if (!/^pn-[0-9a-f]{6}$/.test(id)) continue;
      try {
        const review = JSON.parse(readFileSync(join(directory, id, "launch.json"), "utf8")) as Review;
        if (review.id === id && !review.delivered && !review.failure) this.reviews.set(id, review);
      } catch { /* An incomplete launch has no review to adopt. */ }
    }
  }

  /**
   * Forget settled reviews (on worker start and idle exit). A settled
   * record's bridge token is dropped at once; its folder (feedback.md that
   * Claude was told to Read, the decision, cli.log) goes after
   * T3_REVIEW_KEEP_MS, or T3_FAILED_REVIEW_KEEP_MS when it never settled cleanly.
   */
  prune(now = Date.now()): void {
    for (const id of readdirSync(this.directory)) {
      if (!/^pn-[0-9a-f]{6}$/.test(id) || this.reviews.has(id)) continue;
      const folder = join(this.directory, id);
      try {
        const path = join(folder, "launch.json");
        const review = JSON.parse(readFileSync(path, "utf8")) as Review;
        if (review.id !== id || !(review.delivered || review.failure)) continue;
        const settledAt = review.settledAt ?? statSync(path).mtimeMs;
        if (now - settledAt > (review.delivered ? T3_REVIEW_KEEP_MS : T3_FAILED_REVIEW_KEEP_MS)) {
          rmSync(folder, { recursive: true, force: true });
        } else if (review.token) {
          privateWrite(path, { ...review, token: "", settledAt });
        }
      } catch { /* Unreadable: leave it for a person to look at. */ }
    }
  }

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    void this.tick();
  }

  private path(review: Review, file: string): string { return join(this.directory, review.id, file); }
  private save(review: Review): void { privateWrite(this.path(review, "launch.json"), review); }

  private ready(review: Review): void {
    if (review.port) return;
    const path = this.path(review, "ready.jsonl");
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").trim().split("\n")) {
      try {
        const value = JSON.parse(line) as { port?: number; isRemote?: boolean; url?: string; target?: string | string[] };
        if (!Number.isInteger(value.port) || !value.port || value.port < 1 || value.port > 65535 || value.isRemote !== false) continue;
        review.port = value.port;
        review.url = value.url;
        review.target = value.target;
        review.subject = plannotatorTargetSubject(review.kind === "review" ? "review" : "annotate", value.target) ?? review.subject;
        this.save(review);
        break;
      } catch { /* A ready file can end in a partially written line. */ }
    }
  }

  private attach(review: Review): void {
    if (!review.port || this.bridges.has(review.id)) return;
    const abort = new AbortController();
    this.bridges.set(review.id, abort);
    void runPullSessionBridgeClient({ baseUrl: `http://127.0.0.1:${review.port}`, token: review.token,
      bridge: this.bridge, signal: abort.signal, log: this.notify }).catch((error: unknown) => this.notify(String(error)));
  }

  private async tick(): Promise<void> {
    for (const review of this.reviews.values()) {
      if (review.delivered || review.failure) continue;
      try {
        this.ready(review);
        const resultPath = this.path(review, "result.json");
        if (existsSync(resultPath)) {
          this.bridges.get(review.id)?.abort();
          if (!this.sending.has(review.id) && (review.retryAt ?? 0) <= Date.now()) {
            this.sending.add(review.id);
            void this.settle(review, resultPath).catch((error: unknown) => {
              if (error instanceof T3DeliveryRefused) {
                // Retrying can never send it; keep the record and say why.
                review.deliveryError = error.message;
                this.finish(review, { failure: error.message });
                this.notify(`T3 delivery refused for ${review.id}: ${error.message} The decision stays in ${resultPath}.`);
                return;
              }
              review.deliveryError = String(error);
              review.retryCount = (review.retryCount ?? 0) + 1;
              review.retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(review.retryCount, 6));
              this.save(review);
              this.notify(`T3 delivery pending for ${review.id}: ${String(error)}`);
            })
              .finally(() => this.sending.delete(review.id));
          }
        } else if (!this.openingIds.has(review.id) && this.abandoned(review) && !existsSync(resultPath)) {
          // Nothing will ever arrive: the review server stopped without a
          // decision (killed, crashed or a reboot), or a launch never came up
          // (a worker killed while opening it). The worker stops waiting, so
          // it can go idle, and no later worker inherits the record.
          this.bridges.get(review.id)?.abort();
          const failure = review.port
            ? "The review server stopped without a decision; its draft is kept."
            : "The review never finished opening.";
          this.finish(review, { failure });
          this.notify(`T3 review ${review.id}: ${failure} See ${this.path(review, "cli.log")}`);
        } else this.attach(review);
      } catch (error) { this.notify(`T3 review ${review.id}: ${String(error)}`); }
    }
  }

  private async settle(review: Review, path: string): Promise<void> {
    const result = hostResultSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
    const decision = t3Decision(result, { kind: review.kind, subject: review.subject, sessionId: review.id,
      target: review.target, gate: review.gate, directory: join(this.directory, review.id) });
    if (decision.action === "send") {
      // Written before the send, so the file Claude is told to Read exists.
      if (decision.overflow) writeFileSync(decision.overflow.path, decision.overflow.text, { mode: 0o600 });
      await this.delivery.send(decision.text, `plannotator-review:${review.id}`);
    } else this.notify(decision.text);
    this.finish(review, { delivered: true });
  }

  /**
   * Settle a record for good: nothing waits on it any more, and its bridge
   * token (useless once settled) is dropped from launch.json.
   */
  private finish(review: Review, outcome: { delivered: true } | { failure: string }): void {
    Object.assign(review, outcome, { token: "", settledAt: Date.now() });
    this.save(review);
    this.reviews.delete(review.id);
  }

  /** A launch nobody will ever finish: its server is gone, or it never came up. */
  private abandoned(review: Review): boolean {
    if (review.port) return !!review.pid && !processAlive(review.pid);
    // No ready line yet: give it the opening window (30 s) and some slack.
    return !review.pid || !processAlive(review.pid) || Date.now() - review.createdAt > T3_OPEN_ABANDONED_MS;
  }

  async call(value: unknown): Promise<string> {
    const parsed = parsePlannotatorToolInput(value);
    if (!parsed.ok) throw new Error(parsed.error);
    const input = parsed.input;
    if (input.action === "list") return this.list();
    if (input.action === "close") return this.close(input.session!);
    return this.open(input as PlannotatorToolInput & { action: Review["kind"] });
  }

  private async open(input: PlannotatorToolInput & { action: Review["kind"] }): Promise<string> {
    this.opening++;
    try { return await this.openReview(input); } finally { this.opening--; }
  }

  /** Reviews this worker is opening right now (not yet abandoned, whatever their age). */
  private readonly openingIds = new Set<string>();

  private async openReview(input: PlannotatorToolInput & { action: Review["kind"] }): Promise<string> {
    let stdin: string | undefined;
    if (input.action === "last") {
      const snapshot = await this.bridge.thread.itemsAfter(undefined);
      const last = lastFinishedAssistantMessage(snapshot, this.bridge.thread.id);
      if (!last) throw new Error("This T3 thread has no finished assistant message to annotate.");
      stdin = await this.bridge.thread.fullText(last);
    }
    let id: string;
    do { id = `pn-${randomBytes(3).toString("hex")}`; } while (existsSync(join(this.directory, id)));
    const review: Review = { id, kind: input.action, subject: input.action === "last" ? "your last message" : plannotatorTargetSubject(input.action, input.target) ?? "local changes",
      ...(input.gate === true ? { gate: true } : {}), createdAt: Date.now(), token: randomBytes(32).toString("base64url") };
    mkdirSync(join(this.directory, id), { mode: 0o700 });
    this.save(review);
    const args = input.action === "last" ? ["annotate-last", "--stdin", "--json"] : [input.action, ...plannotatorToolArgs(input), "--json"];
    const log = openSync(this.path(review, "cli.log"), "a", 0o600);
    this.openingIds.add(id);
    try {
      const [executable, ...prefix] = this.command;
      const child = spawn(executable!, [...prefix, ...args], { cwd: this.cwd, detached: true, stdio: [stdin === undefined ? "ignore" : "pipe", log, log],
        env: { ...process.env, PLANNOTATOR_DATA_DIR: this.dataDir, PLANNOTATOR_CWD: this.cwd,
          PLANNOTATOR_ORIGIN: "claude-code", PLANNOTATOR_REMOTE: "0", PLANNOTATOR_READY_FILE: this.path(review, "ready.jsonl"),
          PLANNOTATOR_HOST_RESULT_FILE: this.path(review, "result.json"), PLANNOTATOR_HOST_REVIEW_ID: id,
          PLANNOTATOR_SESSION_BRIDGE_TOKEN: review.token, PLANNOTATOR_SESSION_BRIDGE_HOST: "t3", PLANNOTATOR_SESSION_BRIDGE_MODES: "turn" } });
      let exited = false;
      let failure: Error | undefined;
      child.once("error", (error) => { failure = error; });
      child.once("exit", () => { exited = true; });
      child.stdin?.end(stdin);
      child.unref();
      review.pid = child.pid;
      this.save(review);
      this.reviews.set(id, review);
      const deadline = Date.now() + 30_000;
      while (!review.port && Date.now() < deadline) {
        this.ready(review);
        if (failure || exited) throw failure ?? new Error(`Plannotator exited before opening. See ${this.path(review, "cli.log")}`);
        if (!review.port) await pause(100);
      }
      if (!review.port) { child.kill(); throw new Error(`Plannotator did not open within 30 seconds. See ${this.path(review, "cli.log")}`); }
      this.attach(review);
      return plannotatorToolOpenedText(review.subject, review.url, review.gate === true, id, review.target);
    } catch (error) {
      this.finish(review, { failure: String(error) });
      throw error;
    } finally { this.openingIds.delete(id); closeSync(log); }
  }

  private async control(review: Review, path: string, method = "GET"): Promise<HostHttpAnswer> {
    if (!review.port) throw new Error("The review is still starting.");
    const response = await fetch(`http://127.0.0.1:${review.port}${path}`, { method, headers: { authorization: `Bearer ${review.token}` }, signal: AbortSignal.timeout(5000) });
    return { status: response.status, text: await response.text() };
  }

  async list(): Promise<string> {
    const sessions = await Promise.all([...this.reviews.values()].map(async (review): Promise<PlannotatorSessionSummary> => {
      const status = readHostStatusAnswer(await this.control(review, "/api/host/status").catch(() => null));
      return { id: review.id, kind: review.kind, subject: review.subject, url: review.url, ageMs: Date.now() - review.createdAt,
        state: existsSync(this.path(review, "result.json")) ? "decided" : review.port ? "open" : "starting",
        unsent: status?.unsent ?? null };
    }));
    const errors = [...this.reviews.values()].filter((review) => review.deliveryError).map((review) => `Delivery pending for ${review.id}: ${review.deliveryError}`);
    return [plannotatorToolListText(sessions), ...errors].join("\n");
  }

  async close(id: string): Promise<string> {
    const reviews = id === "all" ? [...this.reviews.values()] : [this.reviews.get(id)].filter((item): item is Review => !!item);
    if (id !== "all" && reviews.length === 0) return plannotatorUnknownSessionText(id);
    const outcomes: PlannotatorCloseOutcome[] = [];
    for (const review of reviews) {
      try {
        const result = classifyHostCloseAnswer(await this.control(review, "/api/host/close", "POST"));
        if (result.kind === "closed") outcomes.push({ id: review.id, subject: review.subject, closed: true, unsent: result.unsent });
        else if (result.kind === "decided") outcomes.push({ id: review.id, subject: review.subject, closed: false, reason: "decided" });
        else outcomes.push({ id: review.id, subject: review.subject, closed: false, reason: "failed", detail: `Plannotator close: ${result.kind}` });
      } catch (error) { outcomes.push({ id: review.id, subject: review.subject, closed: false, reason: "failed", detail: String(error) }); }
    }
    return plannotatorToolCloseText(outcomes);
  }

  /** Nothing open and nothing waiting to be delivered: the worker may exit. */
  idle(): boolean {
    return this.reviews.size === 0 && this.sending.size === 0 && this.opening === 0;
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const abort of this.bridges.values()) abort.abort();
  }
}
