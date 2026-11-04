/**
 * `plannotator inbox steps <thread> --json '<list>'` (approval
 * "inbox-thread-steps", 2026-11-03): an agent's steps in a thread, from a
 * shell. Sugar over `plannotator inbox call steps` (inbox-call-command.ts),
 * so who is calling, the result on stdout and the exit codes are that
 * command's: no steps logic lives here.
 *
 * Works only while the person has steps on (config.json `inboxSteps`); off,
 * the Inbox answers `steps_off` and writes nothing (exit 1).
 */

import { INBOX_STEPS_LEAD } from "@plannotator/shared/inbox/connection";
import { hasHelpFlag } from "./cli";
import { runInboxCallCommand, type CallCommandDeps } from "./inbox-call-command";

export const INBOX_STEPS_USAGE = [
  "Usage:",
  "  plannotator inbox steps [--session <id>] <thread> --json '<list>'",
  "  plannotator inbox steps [--session <id>] <thread> --json -      (the list from stdin)",
  "",
  `steps: ${INBOX_STEPS_LEAD}`,
  "",
  "<list>: [{\"step\":\"Replay the failures in staging\",\"status\":\"doing\",\"note\":\"38 of 40 recovered\"}, ...];",
  "[] clears your list. At most 12 steps, 80 characters per step and per note.",
  "<thread>: the thread id (or a message id in it), from send_message's result.",
  "--session <id>: as for 'plannotator inbox call'.",
  "",
  "Works only while the person has steps on (Inbox Settings → Capabilities); off, it exits 1 with steps_off.",
  "stdout is the result as one JSON value, and nothing on failure. Exit 0 ok, 1 refused or no Inbox, 2 bad usage.",
].join("\n");

export type ParsedStepsCommand = { ok: true; thread: string; json: string | null; stdin: boolean; session: string | null } | { ok: false; error: string };

export function parseStepsCommand(argv: readonly string[]): ParsedStepsCommand {
  const positional: string[] = [];
  let json: string | undefined;
  let session: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      const value = argv[++i];
      if (value === undefined) return { ok: false, error: "--json takes the list (quote it), or - to read it from stdin." };
      if (json !== undefined) return { ok: false, error: "--json given twice." };
      json = value;
    } else if (arg === "--session") {
      const value = argv[++i];
      if (value === undefined) return { ok: false, error: "--session takes a value." };
      session = value;
    } else if (arg.startsWith("--")) return { ok: false, error: `Unknown inbox steps option: ${arg}.` };
    else positional.push(arg);
  }
  if (positional.length !== 1) return { ok: false, error: "inbox steps takes one thread id." };
  if (json === undefined) return { ok: false, error: "inbox steps needs --json with the whole list." };
  return { ok: true, thread: positional[0]!, json: json === "-" ? null : json, stdin: json === "-", session };
}

/** Run `plannotator inbox steps …`; resolves to the exit code. */
export async function runInboxStepsCommand(argv: readonly string[], deps: CallCommandDeps): Promise<number> {
  const out = deps.out ?? ((text: string) => new Promise<void>((done) => void process.stdout.write(text, () => done())));
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  if (hasHelpFlag([...argv])) {
    await out(`${INBOX_STEPS_USAGE}\n`);
    return 0;
  }
  const parsed = parseStepsCommand(argv);
  if (!parsed.ok) {
    err(`usage: ${parsed.error}\n${INBOX_STEPS_USAGE}\n`);
    return 2;
  }
  const text = parsed.stdin ? await (deps.stdin ?? (() => Bun.stdin.text()))() : parsed.json!;
  let steps: unknown;
  try {
    steps = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    err(`invalid_json: The list is not JSON: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!Array.isArray(steps)) {
    err("invalid_json: The list must be a JSON array of { step, status, note? }.\n");
    return 2;
  }
  const call = JSON.stringify({ thread_id: parsed.thread, steps });
  return runInboxCallCommand([...(parsed.session ? ["--session", parsed.session] : []), "steps", call], { ...deps, out, err });
}
