/**
 * `plannotator inbox antigravity`: an Antigravity CLI conversation hands its
 * agent API to the Inbox, so the person's replies start a turn in it.
 *
 * The agy CLI gives its agent API (the language server's address and its
 * CSRF token) only to the commands its agent runs: not to its MCP servers,
 * not to its hooks, and not in any file (the App and the IDE publish theirs
 * in a hub file the Inbox reads itself). So the agent runs this once per agy
 * launch, in its own shell. It writes `inbox/antigravity/links/<conversation
 * id>.json` in the Plannotator data folder (folder 0700, file 0600) and exits:
 * nothing keeps running in the conversation (packages/server/
 * inbox-antigravity-wake.ts reads the file).
 *
 * The token is a secret: it is written to that one file only, never printed.
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { antigravityLoopbackAddress, INBOX_ANTIGRAVITY_DATA_DIRS, INBOX_ANTIGRAVITY_LINKS_FOLDER, isAntigravityConversationId, isAntigravityToken, type InboxAntigravityLink } from "@plannotator/core/inbox-types";
import { childEnv } from "@plannotator/shared/child-env";
import { pruneAntigravityLinks } from "@plannotator/shared/inbox/antigravity-links";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_ANTIGRAVITY_USAGE = [
  "Usage: plannotator inbox antigravity",
  "",
  "Run inside an Antigravity CLI (agy) conversation, by its agent, once per agy launch.",
  "Hands this conversation's agent API to the Plannotator Inbox, so the person's replies start a turn here.",
  "The Antigravity App and IDE need no step: the Inbox reaches their conversations by itself.",
].join("\n");

/** Proposed words (agent-facing): the owner approves them word for word. */
export const INBOX_ANTIGRAVITY_LINKED_TEXT =
  "Done: the person's replies in the Plannotator Inbox now start a turn in this conversation while this agy runs. End your turn, or go on with other work; if a reply has not arrived when you next work, call read_thread with its thread_id.";
export const INBOX_ANTIGRAVITY_APP_TEXT =
  "Nothing to do: the Plannotator Inbox reaches this conversation by itself. The person's replies start a turn here.";
export const INBOX_ANTIGRAVITY_PRINT_TEXT =
  "This agy run (agy -p) ends after its turn, so the person's reply can't start a turn in it. Call read_thread with the thread_id later instead.";
export const INBOX_ANTIGRAVITY_OUTSIDE_TEXT =
  "Run this from a command your Antigravity agent runs: it needs the ANTIGRAVITY_* variables Antigravity gives those commands.";

/** A print-mode agy run among the arguments of an agy process (`-p`, `--print`, `--prompt`, with or without `=`). */
export function agyArgsPrint(args: readonly string[]): boolean {
  if (args.length === 0 || basename(args[0]!) !== "agy") return false;
  for (const arg of args.slice(1)) {
    if (arg === "--") return false;
    const flag = arg.split("=")[0]!;
    if (flag === "-p" || flag === "--print" || flag === "--prompt") return true;
  }
  return false;
}

/** A process above this one: its pid and its argv as `ps` gives it (split on spaces). */
export interface AgyAncestor {
  pid: number;
  args: string[];
}

/** The agy process this command runs under (the nearest `agy` above it), or null. */
export function agyPidOf(ancestors: readonly AgyAncestor[]): number | null {
  return ancestors.find((one) => one.args.length > 0 && basename(one.args[0]!) === "agy")?.pid ?? null;
}

/** The process tree above this one, nearest first. */
function ancestorsArgv(startPid: number, maxDepth = 12): AgyAncestor[] {
  const out: AgyAncestor[] = [];
  let pid = startPid;
  for (let depth = 0; depth < maxDepth && pid > 1; depth++) {
    const run = Bun.spawnSync(["ps", "-o", "ppid=,command=", "-p", String(pid)], { env: childEnv(), stdout: "pipe", stderr: "ignore", windowsHide: true });
    const line = run.stdout.toString().trim();
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (!match) break;
    out.push({ pid, args: match[2]!.split(/\s+/) });
    pid = Number(match[1]);
  }
  return out;
}

export async function runInboxAntigravityCommand(
  args: readonly string[],
  options: {
    env: Readonly<Record<string, string | undefined>>;
    dataDir: string;
    write?: (line: string) => void;
    writeError?: (line: string) => void;
    /** The processes above this one, nearest first (tests pass them). */
    ancestors?: () => AgyAncestor[];
  },
): Promise<number> {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const writeError = options.writeError ?? ((line: string) => void process.stderr.write(`${line}\n`));
  if (args.includes("--help") || args.includes("-h")) {
    write(INBOX_ANTIGRAVITY_USAGE);
    return 0;
  }
  if (args.length > 0) {
    writeError(INBOX_ANTIGRAVITY_USAGE);
    return 2;
  }
  const { env } = options;
  const conversation = env.ANTIGRAVITY_CONVERSATION_ID;
  const address = antigravityLoopbackAddress(env.ANTIGRAVITY_LS_ADDRESS);
  const token = env.ANTIGRAVITY_CSRF_TOKEN;
  if (!isAntigravityConversationId(conversation) || !address || !isAntigravityToken(token)) {
    writeError(INBOX_ANTIGRAVITY_OUTSIDE_TEXT);
    return 1;
  }
  // The App and the IDE publish their agent API themselves: the Inbox reads it there, fresh at each send.
  const dataFolder = env.ANTIGRAVITY_APP_DATA_DIR ? basename(env.ANTIGRAVITY_APP_DATA_DIR.replace(/[\\/]+$/, "")) : INBOX_ANTIGRAVITY_DATA_DIRS.cli;
  if (dataFolder !== INBOX_ANTIGRAVITY_DATA_DIRS.cli) {
    write(INBOX_ANTIGRAVITY_APP_TEXT);
    return 0;
  }
  const ancestors = options.ancestors ?? (() => (process.platform === "win32" ? [] : ancestorsArgv(process.ppid)));
  const above = ancestors();
  if (above.some((one) => agyArgsPrint(one.args))) {
    write(INBOX_ANTIGRAVITY_PRINT_TEXT);
    return 1;
  }
  const dir = join(inboxDir(options.dataDir), ...INBOX_ANTIGRAVITY_LINKS_FOLDER);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // Hand-overs from agy launches that have ended hold tokens for servers that are gone: removed now.
  await pruneAntigravityLinks(dir, conversation);
  const pid = agyPidOf(above);
  const link: InboxAntigravityLink = { conversation: conversation.toLowerCase(), address, token, at: new Date().toISOString(), ...(pid ? { pid } : {}) };
  const path = join(dir, `${conversation.toLowerCase()}.json`);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(link)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  write(INBOX_ANTIGRAVITY_LINKED_TEXT);
  return 0;
}
