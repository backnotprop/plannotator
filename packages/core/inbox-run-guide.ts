/**
 * Plannotator Inbox: what agents are told about `:::run` and `:::secret`
 * (send_message's `body`, `plannotator inbox --help`, /llms), and what the
 * agent gets back when the person runs a command or saves a secret.
 *
 * Pure: no I/O. The examples parse with the store's own readers
 * (inbox-run-blocks.test.ts).
 */

/** A `:::run` block as agents are shown it. */
export const INBOX_RUN_EXAMPLE = [
  ":::run",
  "Run the payment tests",
  "They call the payments sandbox with your test key; about a minute.",
  "Folder: apps/payments",
  "",
  "```sh",
  "bun test payments",
  "```",
  ":::",
].join("\n");

/** A `:::secret` block as agents are shown it. */
export const INBOX_SECRET_EXAMPLE = [
  ":::secret",
  "PAYMENTS_TEST_KEY",
  "The payment tests need your test-mode secret key.",
  "Where: https://dashboard.stripe.com/test/apikeys",
  ":::",
].join("\n");

/** When to write each block, and what comes back. Rides send_message's `body` description and the agent guide. */
export const INBOX_RUN_GUIDE = [
  "A command the person should run on their own computer, as themselves (it needs their machine, their sign-in or a secret you do not have, or they asked to run it): write an Inbox-only `:::run` block. First line: what it does, short. Then one line of why. Optional `Folder: <path>` (relative to the project; default the project folder). Then the command in one fenced code block (```), exactly as it should run: one command or a short script per block, one block per command. The person sees a Run button and presses it; it runs on their computer in that folder with their login shell's environment, and you get the exit code and the last lines of output in a reply. A command that asks for typing (a password, a sign-in, y/n) cannot be answered there: the person moves it to their own terminal. Use a plain fenced code block instead for a command you only show or can run yourself.",
  "When a command needs a secret (an API key, a token, a password), never ask for it in chat, in a :::question or in a file. Write a `:::secret` block: first line its name, env-var style (PAYMENTS_TEST_KEY); then why, in one line; optional `Where: <url or place>` for where to find it. The person saves it on their computer (the Keychain or its like); you are told only that the name is saved, never the value. From then on every `:::run` in this project has it as `$PAYMENTS_TEST_KEY`. Never print a secret, write it to a file, or put it in a command's text.",
].join("\n");

/** The heading of a run's report, so the agent can find it in a reply. */
export const INBOX_RUN_REPORT_HEADING = "Command you asked the person to run";

export interface InboxRunReportInput {
  title: string;
  command: string;
  /** Where it ran, as the card showed it ("~/projects/x/apps/payments"). */
  folder: string;
  outcome: "exited" | "stopped" | "failed_to_start";
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  /** The output's last lines (saved secrets already hidden). */
  tail: readonly string[];
  /** Every line of output, for "last N of M". */
  total_lines: number;
  /** The run stopped because it waited for typing (it asked for a password, a y/n). */
  waited_for_input: boolean;
  /** Why it could not start (folder gone, no shell), when it did not. */
  error?: string | null;
}

/** How many lines of output the agent gets: enough to see a failure, short enough for its context. */
export const INBOX_RUN_REPORT_LINES = 60;

const seconds = (ms: number): string => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

const fenceFor = (text: string): string => {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return fence;
};

/** The person reply a finished run writes: what ran, where, how it ended, and the output's tail. */
export function inboxRunReportText(run: InboxRunReportInput): string {
  const head = `${INBOX_RUN_REPORT_HEADING}: "${run.title}", in ${run.folder}.`;
  const ended =
    run.outcome === "failed_to_start"
      ? `It did not start: ${run.error ?? "the command could not be started"}.`
      : run.outcome === "stopped"
        ? `The person pressed Stop after ${seconds(run.duration_ms)}${run.waited_for_input ? "; it was waiting for someone to type something" : ""}.`
        : run.exit_code !== null
          ? `It exited with code ${run.exit_code} after ${seconds(run.duration_ms)}.`
          : `It ended on signal ${run.signal ?? "unknown"} after ${seconds(run.duration_ms)}.`;
  const tail = run.tail.slice(-INBOX_RUN_REPORT_LINES);
  const lines = [head, ended];
  if (run.outcome !== "failed_to_start") {
    if (tail.length === 0) lines.push("", "It printed nothing.");
    else {
      const text = tail.join("\n");
      const fence = fenceFor(text);
      const which = tail.length < run.total_lines ? `The last ${tail.length} of ${run.total_lines} lines of output` : "Its output";
      lines.push("", `${which} (saved secrets hidden as ••••):`, "", `${fence}text`, text, fence);
    }
  }
  return lines.join("\n");
}

/** The person reply a Save writes: the name, never the value. */
export function inboxSecretSavedText(name: string, replaced: boolean): string {
  return `${replaced ? "Replaced" : "Saved"} ${name} on this computer. Every :::run in this project now has it as $${name}; its value is never shown to you.`;
}
