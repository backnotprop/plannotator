/**
 * `plannotator inbox --review`: the Inbox for code review (docs/agent-guides/inbox-review-only.md).
 *
 * Where the Inbox was never on (the `turned-on` mark, as a first `plannotator inbox` reads it), it turns Code review
 * on and the Inbox for code review only (config.json `inboxCodeReview`, `inboxReviewOnly`) and asks for the welcome
 * dialog (`inboxReviewWelcome.dueAt`), all before anything starts, so no agent session ever begins with the full
 * Inbox's words; then turns the Inbox on. Where it was on already (someone who uses the full Inbox), nothing of the
 * kind changes: only Code review turns on when it was off ("Code review is on.").
 *
 * Then, as `plannotator plans` shows Plans: starts the Inbox detached when it is not running, shows Reviews in the
 * window used last (else opens a new tab on `#reviews`), and prints the URL on stdout (the line before it on stderr).
 * A first run then connects the agents it finds, as `--open` does on the run that turns the Inbox on.
 */
import type { PlannotatorConfig } from "@plannotator/shared/config";

export interface InboxReviewEntry {
  url: string;
  port: number;
  token?: string;
}

export interface InboxReviewDeps<E extends InboxReviewEntry = InboxReviewEntry> {
  /** The Inbox was never turned on here (`!isInboxTurnedOn(dataDir)`). */
  firstRun: boolean;
  /** Turn the Inbox on here (`markInboxTurnedOn`). */
  markOn: () => void;
  load: () => PlannotatorConfig;
  save: (patch: Partial<PlannotatorConfig>) => unknown;
  /** The running Inbox, else null; never starts one. */
  runningInbox: () => Promise<{ url: string } | null>;
  /** The running Inbox, starting it detached when needed. */
  ensureInbox: () => Promise<E>;
  openUrl: (url: string) => Promise<unknown>;
  remoteHint?: (port: number) => string;
  /** A first run: connect the agents found, as `--open` does on the run that turns the Inbox on. */
  connect?: (entry: E) => Promise<unknown>;
  fetch?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => Date;
  timeoutMs?: number;
}

export const REVIEW_CODE_REVIEW_ON = "Code review is on.";
const NOT_SAVED = "config_not_saved: config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.";

/** Code review on through the running Inbox, so its open windows follow at once; else config.json, which a later start reads. */
async function turnOnCodeReview(deps: Pick<InboxReviewDeps, "runningInbox" | "fetch" | "timeoutMs" | "save" | "load">): Promise<boolean> {
  const running = await deps.runningInbox().catch(() => null);
  if (running) {
    try {
      const answer = await (deps.fetch ?? fetch)(new URL("/api/inbox/settings", running.url).href, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code_review: { on: true } }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
      });
      const body = (await answer.json().catch(() => null)) as { code_review?: { on?: unknown } } | null;
      if (answer.ok && body?.code_review?.on === true) return true;
    } catch {
      // Gone, or not answering: config.json below.
    }
  }
  deps.save({ inboxCodeReview: true });
  return deps.load().inboxCodeReview === true;
}

/** Ask the running Inbox to show Reviews in the window used last; false: no window is open (or no answer). */
async function showReviews(entry: InboxReviewEntry, deps: Pick<InboxReviewDeps, "fetch" | "timeoutMs">): Promise<boolean> {
  if (!entry.token) return false;
  try {
    const answer = await (deps.fetch ?? fetch)(new URL("/api/inbox/control/show", entry.url).href, {
      method: "POST",
      headers: { Authorization: `Bearer ${entry.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ page: "reviews" }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
    });
    const body = (await answer.json().catch(() => null)) as { shown?: unknown } | null;
    return answer.ok && body?.shown === true;
  } catch {
    return false;
  }
}

export async function runInboxReviewCommand<E extends InboxReviewEntry>(deps: InboxReviewDeps<E>): Promise<number> {
  const out = deps.stdout ?? ((text: string) => void process.stdout.write(`${text}\n`));
  const err = deps.stderr ?? ((text: string) => void process.stderr.write(`${text}\n`));
  if (deps.firstRun) {
    // Before the Inbox is on, before anything starts: no session ever starts with the full Inbox's words.
    deps.save({ inboxCodeReview: true, inboxReviewOnly: true, inboxReviewWelcome: { dueAt: (deps.now?.() ?? new Date()).toISOString() } });
    const saved = deps.load();
    if (saved.inboxCodeReview !== true || saved.inboxReviewOnly !== true) {
      err(NOT_SAVED);
      return 1;
    }
    deps.markOn();
    err(REVIEW_CODE_REVIEW_ON);
  } else if (deps.load().inboxCodeReview !== true) {
    if (!(await turnOnCodeReview(deps))) {
      err(NOT_SAVED);
      return 1;
    }
    err(REVIEW_CODE_REVIEW_ON);
  }
  let entry: E;
  try {
    entry = await deps.ensureInbox();
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const url = new URL("#reviews", entry.url).href;
  // An open window goes to Reviews; with none, a new tab opens on it.
  if (!(await showReviews(entry, deps)) && (await deps.openUrl(url)) === "remote" && deps.remoteHint) err(deps.remoteHint(entry.port));
  out(url);
  if (deps.firstRun && deps.connect) await deps.connect(entry).catch(() => undefined);
  return 0;
}
