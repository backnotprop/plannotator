import { randomBytes } from "node:crypto";
import { INBOX_LAUNCH_FULL_PERMISSIONS_ENV, inboxPermissionDecisionFor, inboxPermissionHookOutput, isPassThroughTool, readInboxPermissionEvent } from "@plannotator/core/inbox-permission";
import { readInboxRegistry } from "@plannotator/shared/inbox/registry";

export const PERMISSION_HOOK_RETRY_MS = 2_000;
export const PERMISSION_HOOK_CALL_TIMEOUT_MS = 35_000;
const REFUSED_TOKEN_TRIES = 15;

export interface PermissionHookDeps {
  stdin: string;
  env: Readonly<Record<string, string | undefined>>;
  dataDir: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  registry?: () => { port: number; token: string } | null;
  log?: (line: string) => void;
}

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
      await sleep(PERMISSION_HOOK_RETRY_MS);
      continue;
    }
    if (response.status >= 500) {
      await sleep(PERMISSION_HOOK_RETRY_MS);
      continue;
    }
    if (response.status === 401) {
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
    if (body.status === "decided" && body.choice === "terminal") {
      log("plannotator inbox permission-hook: approve this prompt in Claude Code (Terminal).");
      return null;
    }
    if (body.status === "decided") {
      const decision = inboxPermissionDecisionFor(event, body, { fullPermissions: deps.env[INBOX_LAUNCH_FULL_PERMISSIONS_ENV] === "1" });
      return decision ? inboxPermissionHookOutput(decision) : null;
    }
    return null;
  }
}

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
