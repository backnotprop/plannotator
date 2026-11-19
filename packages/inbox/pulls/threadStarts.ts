/**
 * What a PR's Start a thread keeps between presses, per PR key, in memory while the window is open (never saved):
 *  - `unsent`: the words typed and not sent (a thread that does not exist has no reply draft);
 *  - `attempt`: the exact start request of the last press that did not come back, replayed as it was (its key, body and
 *    name) while the words and To are the same, so a PR list that read new details meanwhile never changes a replay's
 *    body (the Inbox would refuse the key, `idempotency_key_reused`);
 *  - `untied`: the thread that started but is not tied to the PR yet, with the project it started in and the words it
 *    went with. From then on no press starts another: Send only ties that thread (whatever To says now), the words it
 *    went with show as sent, anything typed after goes into the thread's reply box unsent, and the PR's page offers it
 *    (Open the thread). A reload forgets it; the server then finds that thread by its first message (`linkInboxPulls`).
 */
const unsent = new Map<string, string>();
const attempts = new Map<string, PullThreadAttempt>();
const untied = new Map<string, PullThreadUntied>();

export interface PullThreadAttempt {
  /** The words and To it was for. */
  series: string;
  key: string;
  body: string;
  name: string;
}

export interface PullThreadUntied {
  threadId: string;
  /** The project it started in: the owner check's. */
  project: string;
  /** The person's words it went with. */
  sent: string;
}

export const unsentPullWords = (pr: string) => unsent.get(pr) ?? '';
export function keepUnsentPullWords(pr: string, words: string): void {
  if (words.trim()) unsent.set(pr, words);
  else unsent.delete(pr);
}

export const pullThreadAttempt = (pr: string) => attempts.get(pr) ?? null;
export const keepPullThreadAttempt = (pr: string, attempt: PullThreadAttempt | null) => (attempt ? attempts.set(pr, attempt) : attempts.delete(pr));

/** The thread that started for this PR and is not tied to it yet, or null. */
export const untiedPullThread = (pr: string) => untied.get(pr)?.threadId ?? null;
/** That thread with its project and the words it went with, or null. */
export const untiedPullStart = (pr: string) => untied.get(pr) ?? null;
export const keepUntiedPullThread = (pr: string, start: PullThreadUntied | null) => (start ? untied.set(pr, start) : untied.delete(pr));

/** For the tests. */
export function forgetPullThreadStarts(): void {
  unsent.clear();
  attempts.clear();
  untied.clear();
}
