/**
 * Routines in the window: the capability switch (Settings → Capabilities, config.json
 * `inboxScheduledThreads`) and the `/api/inbox/scheduled` routes. The contract is in
 * docs/agent-guides/inbox-routines.md. Off, every route answers `routines_off` and nothing is read.
 */
import { inboxScheduledPreview } from "@plannotator/core/inbox-scheduled";
import type { InboxScheduledSchedule } from "@plannotator/core/inbox-scheduled-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { isWindowRequest, INBOX_WINDOW_ONLY_BODY } from "./inbox-cross-site";
import type { InboxLoginItem } from "./inbox-scheduled-login";
import type { InboxScheduled } from "./inbox-scheduled";
import { createOnce } from "./inbox-scheduled-once";

/** Each Inbox's window creates under way, by `idempotency_key` (inbox-scheduled-once.ts). */
const creating = new WeakMap<InboxScheduled, Map<string, Promise<unknown>>>();

/** The switch: three readings like the Board's (unset, true, false). Not offered where launch is not (Windows). */
export function scheduledSwitch(deps: {
  platform: NodeJS.Platform;
  saved: () => boolean | undefined;
  save: (on: boolean) => void;
  login: InboxLoginItem;
  /** The clock and every window follow (the capabilities frame). */
  changed: (on: boolean) => void;
  log?: (line: string) => void;
}) {
  const supported = deps.platform !== "win32";
  const on = () => supported && deps.saved() === true;
  let login: "added" | "unavailable" | null = null;
  const parse = (input: unknown): boolean => {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { on?: unknown }).on !== "boolean" || Object.keys(input).some((key) => key !== "on")) {
      throw new InboxError("validation_error", "scheduled_threads: { on: boolean }.", { field: "scheduled_threads" });
    }
    return (input as { on: boolean }).on;
  };
  const wire = (): { scheduled_threads?: { on: boolean; login?: "added" | "unavailable" } } =>
    supported ? { scheduled_threads: { on: on(), ...(on() && login ? { login } : {}) } } : {};
  /** The login item follows the switch: added while on, removed when it goes off. */
  const syncLogin = async (): Promise<void> => {
    try {
      if (on()) login = await deps.login.add();
      else {
        await deps.login.remove();
        login = null;
      }
    } catch (error) {
      deps.log?.(`Inbox routines: the login item failed (${(error as { code?: unknown })?.code ?? "error"})`);
      login = on() ? "unavailable" : null;
    }
  };
  return {
    on,
    wire,
    syncLogin,
    check(body: { scheduled_threads?: unknown }): void {
      if (body.scheduled_threads === undefined) return;
      if (!supported) throw new InboxError("validation_error", "Routines are not offered on this computer.", { field: "scheduled_threads" });
      parse(body.scheduled_threads);
    },
    async answer(body: { scheduled_threads?: unknown }): Promise<ReturnType<typeof wire>> {
      if (body.scheduled_threads === undefined) return wire();
      const next = parse(body.scheduled_threads);
      const was = on();
      deps.save(next);
      if ((deps.saved() === true) !== next) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
      if (was !== on()) {
        await syncLogin();
        deps.changed(on());
      }
      return wire();
    },
  };
}

type Json = (body: unknown, status?: number) => Response;

/** `/api/inbox/scheduled…`, or null for any other path. */
export async function scheduledRoute(
  req: Request,
  path: string,
  deps: { scheduled: InboxScheduled; on: () => boolean; launchOn: () => boolean; serverSession: string; json: Json; readBody: (req: Request) => Promise<Record<string, unknown>>; now?: () => number },
): Promise<Response | null> {
  if (path !== "/api/inbox/scheduled" && !path.startsWith("/api/inbox/scheduled/")) return null;
  const { scheduled, json } = deps;
  if (!deps.on()) return json({ error: "Routines are off on this computer. Turn them on in Settings, Capabilities.", code: "routines_off" }, 404);
  const parts = path.slice("/api/inbox/scheduled".length).split("/").filter(Boolean);
  if (req.method === "GET") {
    if (parts.length === 0) return json({ scheduled: scheduled.list(), launch_on: deps.launchOn() });
    if (parts.length === 1) return json(scheduled.get(parts[0]!));
    return json({ error: "Not found.", code: "not_found" }, 404);
  }
  if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
  const body = await deps.readBody(req);
  if (checkServerSession(body, deps.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
  if (parts[0] === "preview" && parts.length === 1) return json(inboxScheduledPreview((body.schedule ?? null) as InboxScheduledSchedule, new Date(deps.now?.() ?? Date.now())));
  // Every write is the person's, from their window: an agent uses the routine tool.
  if (!isWindowRequest(req, body, deps.serverSession)) return json({ ...INBOX_WINDOW_ONLY_BODY, error: "A routine is changed in the Inbox window; an agent uses the routine tool." }, 403);
  const person = { kind: "person" } as const;
  if (parts.length === 0) {
    if (!creating.has(scheduled)) creating.set(scheduled, new Map());
    const once = createOnce<Parameters<InboxScheduled["rowOf"]>[0], ReturnType<InboxScheduled["rowOf"]>>(creating.get(scheduled)!);
    const find = (key: string) => {
      const record = scheduled.withCreateKey(key);
      return record ? scheduled.rowOf(record) : null;
    };
    const row = await once(body.idempotency_key, async (key) => (await scheduled.create(body, person, key)).record, find, scheduled.rowOf);
    return json({ scheduled: row }, 201);
  }
  const [id, action] = parts as [string, string | undefined];
  switch (action) {
    case undefined:
      return json({ scheduled: scheduled.rowOf((await scheduled.update(id, { ...body, enabled: undefined }, person)).record) });
    case "on":
    case "off":
      return json({ scheduled: scheduled.rowOf((await scheduled.setOn(id, action === "on", person)).record) });
    case "run": {
      const { message } = await scheduled.runNow(id, person);
      return json({ scheduled: scheduled.get(id).scheduled, message_id: message.id, ...(message.scheduled_run?.failed ? { failed: message.scheduled_run.failed } : {}) }, 202);
    }
    case "stop":
      return json({ scheduled: scheduled.rowOf(await scheduled.stopRun(id)) });
    case "delete":
      await scheduled.remove(id, person);
      return json({ deleted: true });
    case "restore":
      return json({ scheduled: scheduled.rowOf(scheduled.restore(id)) });
    default:
      return json({ error: "Not found.", code: "not_found" }, 404);
  }
}
