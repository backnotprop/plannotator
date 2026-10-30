/**
 * `plannotator inbox permission-hook`: the PermissionRequest hook of a Claude
 * Code session the Inbox launched (launch PR 2; the settings file written by
 * packages/server/inbox-launch.ts installs it with matcher `*`).
 *
 * 1. Read Claude Code's stdin JSON.
 * 2. ExitPlanMode and AskUserQuestion: exit at once with no output, so plan
 *    review and Claude Code's own question dialog work exactly as before. The
 *    same for a session the Inbox did not launch (no PLANNOTATOR_LAUNCH).
 * 3. Long-poll the Inbox (`POST /api/inbox/launch/<id>/permission`, the port
 *    and token from `<dataDir>/inbox/inbox.json`, read again on every try) with
 *    the launch's key. The Inbox asks the person in the launch thread.
 * 4. Print the decision in the shape Claude Code reads, built HERE from this
 *    hook's own event: the Inbox only says once, session, deny (and the
 *    reason), auto or full. Whatever answers on the port can never pick the
 *    tool input or a permission update: a session rule is only the one Claude
 *    suggested, a mode switch only `auto` or `bypassPermissions` built from this
 *    hook's own literals, and bypass mode only when this hook's own launch
 *    settings carry PLANNOTATOR_LAUNCH_FULL_PERMISSIONS=1.
 *
 * The Inbox down (no answer, a refused connection, 5xx, a call cut off after
 * 35 s): try again every 2 s, and keep waiting (Claude Code's hook timeout,
 * four days, is the only limit). A token the Inbox keeps refusing (401 with
 * the same token for 30 s), a refusal (a wrong key, a deleted launch, launch
 * off) or a withdrawn question: exit with no output, so Claude Code's own
 * dialog decides, and say why on stderr. Any crash: no output too.
 */

import { randomBytes } from "node:crypto";
import { INBOX_LAUNCH_FULL_PERMISSIONS_ENV, inboxPermissionDecisionFor, inboxPermissionHookOutput, isPassThroughTool, readInboxPermissionEvent } from "@plannotator/core/inbox-permission";
import { readInboxRegistry } from "@plannotator/shared/inbox/registry";

export const PERMISSION_HOOK_RETRY_MS = 2_000;
/** One call's limit: the Inbox holds a call 25 s; past this it is hung (a half-open socket after sleep), and the hook calls again. */
export const PERMISSION_HOOK_CALL_TIMEOUT_MS = 35_000;
/** A token the Inbox refuses this many times in a row, unchanged in inbox.json (30 s): not this Inbox's; give up. */
const REFUSED_TOKEN_TRIES = 15;

export interface PermissionHookDeps {
  stdin: string;
  env: Readonly<Record<string, string | undefined>>;
  dataDir: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The Inbox's port and token (default: `<dataDir>/inbox/inbox.json`). */
  registry?: () => { port: number; token: string } | null;
  log?: (line: string) => void;
}

/** The hook's stdout: the decision JSON, or null for none (Claude Code's own dialog decides). */
export async function permissionHookOutput(deps: PermissionHookDeps): Promise<string | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(deps.stdin);
  } catch {
    return null;
  }
  const event = readInboxPermissionEvent(raw);
  if (!event || isPassThroughTool(event)) return null;
  const launchId = deps.env.PLANNOTATOR_LAUNCH;
  const key = deps.env.PLANNOTATOR_LAUNCH_KEY;
  if (!launchId || !/^lch_[0-9A-HJKMNP-TV-Z]{26}$/.test(launchId) || !key) return null;

  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const registry = deps.registry ?? (() => readInboxRegistry(deps.dataDir));
  const log = deps.log ?? (() => {});
  const requestId = randomBytes(12).toString("hex");
  let messageId: string | null = null;
  let refused: { token: string; tries: number } | null = null;

  for (;;) {
    const entry = registry();
    if (!entry) {
      await sleep(PERMISSION_HOOK_RETRY_MS);
      continue;
    }
    let response: Response;
    try {
      response = await doFetch(`http://127.0.0.1:${entry.port}/api/inbox/launch/${launchId}/permission`, {
        method: "POST",
        headers: { authorization: `Bearer ${entry.token}`, "content-type": "application/json" },
        body: JSON.stringify({ key, request_id: requestId, event: raw, ...(messageId ? { message_id: messageId } : {}) }),
        signal: AbortSignal.timeout(PERMISSION_HOOK_CALL_TIMEOUT_MS),
      });
    } catch {
      // The Inbox is down, restarting or hung: keep waiting.
      await sleep(PERMISSION_HOOK_RETRY_MS);
      continue;
    }
    // A restarting Inbox, or another one on the port for a moment: try again.
    if (response.status >= 500) {
      await sleep(PERMISSION_HOOK_RETRY_MS);
      continue;
    }
    if (response.status === 401) {
      // Counted per token: a restarted Inbox writes a new one, and the count starts over.
      const before: { token: string; tries: number } | null = refused;
      const tries: number = before !== null && before.token === entry.token ? before.tries + 1 : 1;
      refused = { token: entry.token, tries };
      if (tries >= REFUSED_TOKEN_TRIES) {
        log("plannotator inbox permission-hook: the Inbox refuses this data dir's token; answer this prompt in Terminal.");
        return null;
      }
      await sleep(PERMISSION_HOOK_RETRY_MS);
      continue;
    }
    refused = null;
    const body = (await response.json().catch(() => null)) as { status?: string; message_id?: string; choice?: unknown; reason?: unknown; code?: string } | null;
    if (!response.ok || !body) {
      log(`plannotator inbox permission-hook: the Inbox refused this prompt (${response.status}${body?.code ? ` ${body.code}` : ""}); answer it in Terminal.`);
      return null;
    }
    if (body.status === "waiting" && typeof body.message_id === "string") {
      messageId = body.message_id;
      continue;
    }
    if (body.status === "decided") {
      // Only the choice comes from the Inbox: the decision is built from this hook's own event, and Full
      // permissions only when this session's own settings file says its launch allows them.
      const decision = inboxPermissionDecisionFor(event, body, { fullPermissions: deps.env[INBOX_LAUNCH_FULL_PERMISSIONS_ENV] === "1" });
      return decision ? inboxPermissionHookOutput(decision) : null;
    }
    return null;
  }
}

/** The subcommand: stdin in, the decision (or nothing) out, exit 0 always. */
export async function runPermissionHook(dataDir: string): Promise<never> {
  let output: string | null = null;
  try {
    const stdin = await new Response(Bun.stdin.stream()).text();
    output = await permissionHookOutput({ stdin, env: process.env, dataDir, log: (line) => process.stderr.write(`${line}\n`) });
  } catch {
    output = null;
  }
  if (output) process.stdout.write(`${output}\n`);
  process.exit(0);
}
