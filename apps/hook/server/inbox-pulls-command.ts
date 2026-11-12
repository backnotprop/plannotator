/**
 * `plannotator inbox pulls ls|add|rm` (approval "inbox-pr-binding",
 * 2026-11-08): a thread's PRs from a shell (Pi, OpenCode, Codex, any
 * script). Sugar over `plannotator inbox call thread_pulls`
 * (inbox-call-command.ts), so who is calling, the result on stdout and the
 * exit codes are that command's: no PR logic lives here.
 */

import { hasHelpFlag } from "./cli";
import { runInboxCallCommand, type CallCommandDeps } from "./inbox-call-command";
import { writeWholeToStdout } from "./write-whole-stdout";

export const INBOX_PULLS_USAGE = [
  "Usage:",
  "  plannotator inbox pulls ls  [--session <id>] <thread>",
  "  plannotator inbox pulls add [--session <id>] <thread> <ref>...",
  "  plannotator inbox pulls rm  [--session <id>] <thread> <ref>... | --all",
  "",
  "A thread's pull/merge requests: list them with live state and who added each, add, or remove.",
  "You own your thread's list: add a PR when you open or take on one for this work, and remove one",
  "when it stops being part of the work; merged ones stay. The person can add and remove too.",
  "",
  "<ref>: owner/repo#123 (GitHub), group/sub/project!45 (GitLab), or the PR's URL (Bitbucket: the URL only).",
  "<thread>: the thread id, or a message id in it.",
  "--all (rm): takes off every PR on the thread.",
  "--session <id>: as for 'plannotator inbox call'.",
  "",
  "stdout is the result as one JSON value, and nothing on failure. Exit 0 ok, 1 refused or no Inbox, 2 bad usage.",
].join("\n");

export type ParsedPullsCommand =
  | { ok: true; op: "ls" | "add" | "rm"; thread: string; refs: string[]; all: boolean; session: string | null }
  | { ok: false; error: string };

export function parsePullsCommand(argv: readonly string[]): ParsedPullsCommand {
  const positional: string[] = [];
  let session: string | null = null;
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--session") {
      const value = argv[++i];
      if (value === undefined) return { ok: false, error: "--session takes a value." };
      session = value;
    } else if (arg === "--all") all = true;
    else if (arg.startsWith("--")) return { ok: false, error: `Unknown inbox pulls option: ${arg}.` };
    else positional.push(arg);
  }
  const [op, thread, ...refs] = positional;
  if (op !== "ls" && op !== "add" && op !== "rm") return { ok: false, error: "inbox pulls takes ls, add or rm." };
  if (!thread) return { ok: false, error: `inbox pulls ${op} takes a thread id.` };
  if (op === "ls" && (refs.length > 0 || all)) return { ok: false, error: "inbox pulls ls takes only a thread id." };
  if (op === "add" && (refs.length === 0 || all)) return { ok: false, error: "inbox pulls add takes one or more PRs after the thread id." };
  if (op === "rm" && (refs.length === 0) === !all) return { ok: false, error: "inbox pulls rm takes one or more PRs after the thread id, or --all." };
  return { ok: true, op, thread, refs, all, session };
}

/** Run `plannotator inbox pulls …`; resolves to the exit code. */
export async function runInboxPullsCommand(argv: readonly string[], deps: CallCommandDeps): Promise<number> {
  const out = deps.out ?? writeWholeToStdout;
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  if (hasHelpFlag([...argv])) {
    await out(`${INBOX_PULLS_USAGE}\n`);
    return 0;
  }
  const parsed = parsePullsCommand(argv);
  if (!parsed.ok) {
    err(`usage: ${parsed.error}\n${INBOX_PULLS_USAGE}\n`);
    return 2;
  }
  const call = JSON.stringify({
    thread_id: parsed.thread,
    ...(parsed.op === "add" ? { add: parsed.refs } : {}),
    ...(parsed.op === "rm" ? { remove: parsed.all ? ["all"] : parsed.refs } : {}),
  });
  return runInboxCallCommand([...(parsed.session ? ["--session", parsed.session] : []), "thread_pulls", call], { ...deps, out, err });
}
