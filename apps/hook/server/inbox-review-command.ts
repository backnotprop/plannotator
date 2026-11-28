/**
 * `plannotator inbox --review`: the Inbox for code review (docs/agent-guides/inbox-review-only.md).
 *
 * Where the Inbox was never on (the `turned-on` mark, as a first `plannotator inbox` reads it) and the person never
 * chose a mode (config.json `inboxReviewOnly` unset), it turns Code review on and the Inbox for code review only
 * (config.json `inboxCodeReview`, `inboxReviewOnly`) and asks for the welcome dialog (`inboxReviewWelcome.dueAt`), all
 * before anything starts and each read back, so no agent session ever begins with the full Inbox's words; then turns
 * the Inbox on and reads that back too. Anyone else (someone who uses the full Inbox, or who chose code review only and
 * later switched back to the full Inbox) keeps their mode: only Code review turns on when it was off ("Code review is
 * on."). What it turns is stamped as the person's flip (`inboxCapabilityFlips`), so a linked computer's older flip never
 * turns it back.
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
  /** Turn the Inbox on here (`markInboxTurnedOn`): false when its mark could not be written. */
  markOn: () => boolean;
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
async function turnOnCodeReview(deps: Pick<InboxReviewDeps, "runningInbox" | "fetch" | "timeoutMs" | "save" | "load" | "now">): Promise<boolean> {
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
  deps.save({ inboxCodeReview: true, ...codeReviewFlip(deps) });
  return deps.load().inboxCodeReview === true;
}

/** Code review's flip, stamped now (inbox-capability-set.ts reads it): a linked computer's older flip never turns it back off. */
function codeReviewFlip(deps: Pick<InboxReviewDeps, "now">): Partial<PlannotatorConfig> {
  return { inboxCapabilityFlips: { code_review: { at: (deps.now?.() ?? new Date()).getTime(), by: null } } };
}

/**
 * A first run's save, all or nothing: the welcome (machine state, state.json) first, then the mode, Code review and its
 * flip (config.json), each read back. A save of both at once could land in config.json alone (state.json unwritable),
 * leaving the mode on with no welcome. When the second does not land, the welcome is put back as it was, so a failure
 * leaves the computer as it was ("nothing changed").
 */
function saveFirstRun(deps: Pick<InboxReviewDeps, "load" | "save" | "now">): boolean {
  const before = deps.load();
  const dueAt = (deps.now?.() ?? new Date()).toISOString();
  deps.save({ inboxReviewWelcome: { ...before.inboxReviewWelcome, dueAt } });
  if (deps.load().inboxReviewWelcome?.dueAt !== dueAt) return false;
  deps.save({ inboxCodeReview: true, inboxReviewOnly: true, ...codeReviewFlip(deps) });
  const saved = deps.load();
  if (saved.inboxCodeReview === true && saved.inboxReviewOnly === true && saved.inboxReviewWelcome?.dueAt === dueAt) return true;
  deps.save({ inboxReviewWelcome: before.inboxReviewWelcome });
  return false;
}

/** The Inbox could not be turned on here (its mark not written). */
export const REVIEW_NOT_TURNED_ON = "inbox_not_turned_on: the Inbox could not be turned on here (its data folder could not be written); nothing started.";

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
  // A first run is one where the person never chose a mode either: someone who switched back to the full Inbox (and
  // later turned the Inbox off) is never put back into code review only by this command.
  const firstRun = deps.firstRun && deps.load().inboxReviewOnly === undefined;
  if (firstRun) {
    // Before the Inbox is on, before anything starts: no session ever starts with the full Inbox's words.
    if (!saveFirstRun(deps)) {
      err(NOT_SAVED);
      return 1;
    }
    if (!deps.markOn()) {
      err(REVIEW_NOT_TURNED_ON);
      return 1;
    }
    err(REVIEW_CODE_REVIEW_ON);
  } else if (deps.firstRun && !deps.markOn()) {
    err(REVIEW_NOT_TURNED_ON);
    return 1;
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
