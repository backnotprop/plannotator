/**
 * `plannotator inbox export-decisions --thread <id> [--format md|html] [--out <file>] [--pr <ref>]` (design brief
 * "export-decisions" step 2; the owner: agents get a command line only, no new tool action). A thin client over the
 * window's own routes on this computer's listener: the download (`GET /api/inbox/threads/:id/decisions`) and Post
 * decisions (`POST /api/inbox/threads/:id/decisions/post`), starting a stopped Inbox detached as `inbox projects`
 * does. No export or forge logic lives here.
 *
 * stdout: the file (no --out), or with --out nothing; with --pr one line, "Decisions posted on <ref>: <url>" (or
 * updated). A refusal goes to stderr as `<code>: <message>` and exits 1; bad usage exits 2.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { hasHelpFlag } from "./cli";
import { writeWholeToStdout } from "./write-whole-stdout";

export const INBOX_EXPORT_DECISIONS_USAGE = [
  "Usage:",
  "  plannotator inbox export-decisions --thread <id> [--format md|html] [--out <file>]",
  "  plannotator inbox export-decisions --thread <id> --pr <ref>",
  "",
  "A thread's decisions as Markdown (default) or HTML, on stdout or into --out.",
  "--pr posts them on one of the thread's pull requests as one comment, and edits",
  "that same comment when run again. <ref>: owner/repo#123, group/project!45 or the URL.",
].join("\n");

/** One request never waits longer: a wedged Inbox (or a slow forge) must not hang the agent. */
const REQUEST_TIMEOUT_MS = 90_000;

export type ParsedExportDecisionsCommand =
  | { ok: true; thread: string; format: "md" | "html"; out: string | null; pr: string | null }
  | { ok: false; error: string };

export function parseExportDecisionsCommand(argv: readonly string[]): ParsedExportDecisionsCommand {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!["--thread", "--format", "--out", "--pr"].includes(arg)) return { ok: false, error: `Unknown inbox export-decisions argument: ${arg}.` };
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `${arg} takes a value.` };
    if (flags.has(arg)) return { ok: false, error: `${arg} given twice.` };
    flags.set(arg, value);
  }
  const thread = flags.get("--thread");
  if (!thread) return { ok: false, error: "inbox export-decisions takes --thread <id>." };
  const format = flags.get("--format") ?? "md";
  if (format !== "md" && format !== "html") return { ok: false, error: "--format: md or html." };
  const pr = flags.get("--pr") ?? null;
  if (pr && (flags.has("--format") || flags.has("--out"))) return { ok: false, error: "--pr posts the decisions; --format and --out are for a file." };
  return { ok: true, thread, format, out: flags.get("--out") ?? null, pr };
}

export interface ExportDecisionsCommandDeps {
  cwd: string;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  out?: (text: string) => void | Promise<void>;
  err?: (text: string) => void;
  /** Tests: how long one request may take. */
  timeoutMs?: number;
}

/** This computer's zone, so the file's dates read as the person's. */
function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Run `plannotator inbox export-decisions …`; resolves to the exit code. */
export async function runInboxExportDecisionsCommand(argv: readonly string[], deps: ExportDecisionsCommandDeps): Promise<number> {
  const out = deps.out ?? writeWholeToStdout;
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  if (hasHelpFlag([...argv])) {
    await out(`${INBOX_EXPORT_DECISIONS_USAGE}\n`);
    return 0;
  }
  const parsed = parseExportDecisionsCommand(argv);
  if (!parsed.ok) {
    err(`usage: ${parsed.error}\n${INBOX_EXPORT_DECISIONS_USAGE}\n`);
    return 2;
  }
  const refused = (code: string, message: string) => {
    err(`${code}: ${message}\n`);
    return 1;
  };
  let entry: InboxRegistryEntry;
  try {
    entry = await deps.ensureRunning();
  } catch (error) {
    return refused("inbox_not_running", `Plannotator Inbox is not running: ${error instanceof Error ? error.message : String(error)}`);
  }
  const base = `http://127.0.0.1:${entry.port}/api/inbox/threads/${encodeURIComponent(parsed.thread)}/decisions`;
  const signal = AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = parsed.pr
      ? await fetch(`${base}/post`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pull: parsed.pr, tz: localZone() }), signal })
      : await fetch(`${base}?${new URLSearchParams({ format: parsed.format, tz: localZone() })}`, { signal });
  } catch (error) {
    return refused("inbox_no_answer", `Plannotator Inbox did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    let body: { error?: string; code?: string } = {};
    try {
      body = JSON.parse(text);
    } catch {
      // Not the Inbox's JSON refusal: its status says enough.
    }
    return refused(body.code ?? `http_${response.status}`, body.error ?? `The Inbox answered ${response.status}.`);
  }
  if (parsed.pr) {
    const answer = JSON.parse(text) as { action: "created" | "updated"; ref: string; url: string };
    await out(`Decisions ${answer.action === "updated" ? "updated" : "posted"} on ${answer.ref}: ${answer.url}\n`);
    return 0;
  }
  if (parsed.out) {
    try {
      writeFileSync(resolve(deps.cwd, parsed.out), text);
    } catch (error) {
      return refused("write_failed", `Couldn't write ${parsed.out}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 0;
  }
  await out(text);
  return 0;
}
