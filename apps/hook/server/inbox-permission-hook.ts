/**
 * `plannotator inbox permission-hook`: the PermissionRequest hook of a Claude
 * Code session the Inbox launched (launch PR 2; the settings file written by
 * packages/server/inbox-launch.ts installs it with matcher `*`).
 *
 * 1. Read Claude Code's stdin JSON.
 * 2. ExitPlanMode: exit at once with no output, so plan review (the plugin's
 *    own PermissionRequest hook) works exactly as before. The same for a
 *    session the Inbox did not launch (no PLANNOTATOR_LAUNCH in its env).
 * 3. Long-poll the Inbox (`POST /api/inbox/launch/<id>/permission`, the port
 *    and token from `<dataDir>/inbox/inbox.json`, read again on every try) with
 *    the launch's key. The Inbox asks the person in the launch thread.
 * 4. Print the person's decision in the shape Claude Code reads.
 *
 * The Inbox down: try again every 2 s, and keep waiting (Claude Code's hook
 * timeout, four days, is the only limit). Refused (a wrong key, a deleted
 * launch, launch off) or withdrawn: exit with no output, so Claude Code's own
 * dialog decides. Any crash: no output too.
 */

import { randomBytes } from "node:crypto";
import { inboxPermissionHookOutput, isPlanModeExit, readInboxPermissionEvent, type InboxPermissionDecision } from "@plannotator/core/inbox-permission";
import { readInboxRegistry } from "@plannotator/shared/inbox/registry";

export const PERMISSION_HOOK_RETRY_MS = 2_000;

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
  if (!event || isPlanModeExit(event)) return null;
  const launchId = deps.env.PLANNOTATOR_LAUNCH;
  const key = deps.env.PLANNOTATOR_LAUNCH_KEY;
  if (!launchId || !/^lch_[0-9A-HJKMNP-TV-Z]{26}$/.test(launchId) || !key) return null;

  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const registry = deps.registry ?? (() => readInboxRegistry(deps.dataDir));
  const log = deps.log ?? (() => {});
  const requestId = randomBytes(12).toString("hex");
  let messageId: string | null = null;

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
      });
    } catch {
      // The Inbox is down or restarting: keep waiting.
      await sleep(PERMISSION_HOOK_RETRY_MS);
      continue;
    }
    // A restarting Inbox, or another one on the port for a moment: try again. A refusal: Claude Code's dialog decides.
    if (response.status >= 500 || response.status === 401) {
      await sleep(PERMISSION_HOOK_RETRY_MS);
      continue;
    }
    const body = (await response.json().catch(() => null)) as { status?: string; message_id?: string; decision?: InboxPermissionDecision } | null;
    if (!response.ok || !body) {
      log(`permission-hook: refused (${response.status})`);
      return null;
    }
    if (body.status === "waiting" && typeof body.message_id === "string") {
      messageId = body.message_id;
      continue;
    }
    if (body.status === "decided" && body.decision && (body.decision.behavior === "allow" || body.decision.behavior === "deny")) {
      return inboxPermissionHookOutput(body.decision);
    }
    return null;
  }
}

/** The subcommand: stdin in, the decision (or nothing) out, exit 0 always. */
export async function runPermissionHook(dataDir: string): Promise<never> {
  let output: string | null = null;
  try {
    const stdin = await new Response(Bun.stdin.stream()).text();
    output = await permissionHookOutput({ stdin, env: process.env, dataDir });
  } catch {
    output = null;
  }
  if (output) process.stdout.write(`${output}\n`);
  process.exit(0);
}
