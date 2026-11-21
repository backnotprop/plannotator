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
  "Uses: PAYMENTS_TEST_KEY",
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

/**
 * The short form, on send_message's `body` description (every tool listing carries it, so it stays short): when
 * to write each block and its shape. The full text is INBOX_RUN_GUIDE, in `plannotator inbox --help` and /llms.
 */
export const INBOX_RUN_TOOL_TEXT = [
  "`:::run` (Inbox only): a command the person runs on their computer with one press (it needs their machine, sign-in or secret). Only these lines: title; why; optional `Folder: <project path>`; optional `Uses: NAME` for a secret the program reads itself; the command in one ``` fence (POSIX shell). You get its exit code and output tail. A command needing typing goes in a plain code block.",
  "`:::secret`, only these lines: NAME; why; optional `Where: <url>`. They save it on their computer; you hear only that. A run gets it only by naming it: `$NAME` in its command or `Uses: NAME`. Details: `plannotator inbox --help`.",
].join("\n");

/** When to write each block, and what comes back: `plannotator inbox --help` and /llms carry it whole. */
export const INBOX_RUN_GUIDE = [
  "A command the person should run on their own computer, as themselves (it needs their machine, their sign-in or a secret you do not have, or they asked to run it): write an Inbox-only `:::run` block. First line: what it does, short. Then one line of why. Optional `Folder: <path>` (relative to the project; default the project folder). Optional `Uses: NAME, OTHER`: saved secrets the program reads from its environment itself. Then the command in one fenced code block (```), exactly as it should run, in POSIX shell syntax (on Windows it runs in Git Bash when Git for Windows is there, else in PowerShell): one command or a short script per block, one block per command. The person sees a Run button and presses it; it runs on their computer in that folder with their login shell's environment, and you get the exit code and the last lines of output in a reply. What it starts in the background (`&`, `nohup`) is stopped when it ends, so a run cannot leave a server going (on Windows, a background process can outlive it). A command that asks for typing (a password, a sign-in, y/n) cannot be answered there: give it as a plain fenced code block for their own terminal, and a `:::run` that checks it worked if you need to know. Use a plain fenced code block too for a command you only show or can run yourself.",
  "When a command needs a secret (an API key, a token, a password), never ask for it in chat, in a :::question or in a file. Write a `:::secret` block: first line its name, env-var style (PAYMENTS_TEST_KEY; not a name programs read to start, like PATH, HOME, NODE_OPTIONS, LD_* or GIT_*, which the person cannot save); then why, in one line; optional `Where: <url or place>` for where to find it. Put it before the `:::run` that uses it, in the same message or an earlier one; a run card that uses a name not saved yet shows the field too. The person saves it on their computer (the Keychain or its like); you get a reply naming it, never the value. The card itself tells the person where it is stored; you do not need to. A `:::run` gets a saved secret only when it names it: `$PAYMENTS_TEST_KEY` in the command, or `Uses: PAYMENTS_TEST_KEY` for a program that reads it itself; no other run gets it. Never print a secret, write it to a file, or put it in a command's text.",
].join("\n");

/** The heading of a run's report, so the agent can find it in a reply. */
export const INBOX_RUN_REPORT_HEADING = "Command you asked the person to run";

export interface InboxRunReportInput {
  title: string;
  command: string;
  /** Where it ran, as the card showed it ("~/projects/x/apps/payments"). */
  folder: string;
  /**
   * `inbox_closed`: the Inbox quit while it ran and stopped it. `inbox_lost`: the Inbox ended without a word (a
   * crash, a kill) and found the run unfinished when it started again.
   */
  outcome: "exited" | "stopped" | "failed_to_start" | "inbox_closed" | "inbox_lost";
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
  /** A lost run's command, looked for when the Inbox started again: still running, ended, or unknown. */
  left_running?: boolean | null;
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
      : run.outcome === "inbox_closed"
        ? `The Inbox closed while it ran, after ${seconds(run.duration_ms)}, and the command was stopped with it. Ask the person to run it again if you still need it.`
        : run.outcome === "inbox_lost"
          ? run.left_running === true
            ? "The Inbox stopped while it ran, so its result was not recorded. It is still running on their computer, and its card lets the person stop it. Ask them to run it again if you need its result."
            : run.left_running === false
              ? "The Inbox stopped while it ran, so its result was not recorded; it has ended since. Ask the person to run it again if you still need it."
              : "The Inbox stopped while it ran, so its result was not recorded; it may have gone on by itself. Ask the person to run it again if you still need it."
          : run.outcome === "stopped"
            ? `The person pressed Stop after ${seconds(run.duration_ms)}${run.waited_for_input ? "; it was waiting for someone to type something" : ""}.`
            : run.exit_code !== null
              ? `It exited with code ${run.exit_code} after ${seconds(run.duration_ms)}.`
              : `It ended on signal ${run.signal ?? "unknown"} after ${seconds(run.duration_ms)}.`;
  const tail = run.tail.slice(-INBOX_RUN_REPORT_LINES);
  const lines = [head, ended];
  if (run.outcome !== "failed_to_start" && (run.outcome !== "inbox_lost" || tail.length > 0)) {
    if (tail.length === 0) lines.push("", "It printed nothing.");
    else {
      const text = tail.join("\n");
      const fence = fenceFor(text);
      const which = tail.length < run.total_lines ? `The last ${tail.length} of ${run.total_lines.toLocaleString("en-US")} lines of output` : run.outcome === "inbox_lost" ? "Its output before the Inbox stopped" : "Its output";
      lines.push("", `${which} (secrets hidden as ••••):`, "", `${fence}text`, text, fence);
    }
  }
  return lines.join("\n");
}

/** The person reply when they stop a run the Inbox lost that was still going: it ended, and its result is still unknown. */
export function inboxRunLostStoppedText(title: string, folder: string): string {
  return `${INBOX_RUN_REPORT_HEADING}: "${title}", in ${folder}.\nThe person stopped it. It had gone on running after the Inbox stopped, so its result was never recorded. Ask them to run it again if you still need it.`;
}

/** The person reply a Save writes: the name, never the value. */
export function inboxSecretSavedText(name: string, replaced: boolean): string {
  return `${replaced ? "Replaced" : "Saved"} ${name} on this computer. A :::run in this project that names $${name} in its command, or has \`Uses: ${name}\`, gets it; its value is never shown to you.`;
}
