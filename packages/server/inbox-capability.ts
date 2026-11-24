/**
 * The Inbox's capability seam: a capability is a switch the person turns on, with routes the Inbox mounts only while
 * it is on. The Inbox core (packages/server/inbox.ts) knows each one only by its key: it routes, answers the
 * settings and starts them through the list below, and never imports a capability's records, routes or text.
 *
 * Plans is the only one on it (packages/server/plans-capability.ts). Shape, Routines, the Board and code review are
 * still wired by hand in inbox.ts; each may move here later, one at a time, once this holds.
 *
 * A capability's agent tool (`tools`) and the window's capability rows come with the first capability that has
 * them; none does yet.
 */
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { createPlansCapability } from "./plans-capability";

export interface InboxCapability {
  /** The settings key and the name in `event: capabilities` ("plans"). */
  key: string;
  /** Read on every request (config.json). */
  on(): boolean;
  /** Turn it on or off; false when config.json could not be saved (nothing changed). */
  save(on: boolean): boolean;
  /** The path it owns, and every path under it ("/api/plans"). */
  prefix?: string;
  /** A Response for one of its paths, else null. Called only while on(), behind the guards (`routeInboxCapabilities`). */
  route?(req: Request, url: URL): Promise<Response | null>;
  /** What `GET /api/inbox/settings` says of it; `{}` adds nothing. */
  settingsWire?(): Record<string, unknown>;
  /** The Inbox is up (it runs any background work it needs while on). */
  started?(): void;
  /** The Inbox is going down: it ends what it has going (runs, listeners, watches). */
  stopped?(): void;
}

/** What a capability may use of the Inbox core: only this. */
export interface InboxCore {
  dataDir: string;
  /** A switch changed: every window hears `event: capabilities`. */
  changed(): void;
}

/** The Inbox's capabilities, in order. */
export function inboxCapabilities(core: InboxCore): InboxCapability[] {
  return [createPlansCapability(core)];
}

/** The request's standing, as the Inbox's guards decide it. */
export interface InboxCapabilityGuard {
  /** The window's own port on this computer: not the tailnet, a phone's door or a linked machine's. */
  local: boolean;
  /** Another site's request: the refusal; else null. */
  crossSite(): Response | null;
  serverSession: string;
}

const NOT_FOUND = () => Response.json({ error: "Not found", code: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

const owns = (prefix: string, pathname: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * A capability's path, behind the guards Shape's routes have: off, or reached any way but the owner's window on this
 * computer, it is the unknown-route 404, as if absent (reads included: a plan names files and folders); another site
 * is refused; a POST must carry the page's server session (or none). Null: no capability owns the path.
 */
export async function routeInboxCapabilities(list: readonly InboxCapability[], req: Request, url: URL, guard: InboxCapabilityGuard): Promise<Response | null> {
  const capability = list.find((c) => c.route && c.prefix && owns(c.prefix, url.pathname));
  if (!capability) return null;
  if (!guard.local || !capability.on()) return NOT_FOUND();
  const refused = guard.crossSite();
  if (refused) return refused;
  if (req.method === "POST") {
    const body = await req.clone().json().catch(() => null);
    if (checkServerSession(body, guard.serverSession) === "mismatch") {
      return Response.json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), { status: 409, headers: { "Cache-Control": "no-store" } });
    }
  }
  return (await capability.route!(req, url)) ?? NOT_FOUND();
}

/**
 * Every capability's part of `GET /api/inbox/settings`. `local`: the window is the owner's on this computer, the only
 * place a capability's routes answer (`routeInboxCapabilities`); any other window (the tailnet, a phone) is told
 * nothing of them, so it draws no row that would lead to a 404.
 */
export function capabilitiesWire(list: readonly InboxCapability[], local = true): Record<string, unknown> {
  return local ? Object.assign({}, ...list.map((c) => c.settingsWire?.() ?? {})) : {};
}

/**
 * Every capability's part of `event: capabilities`: its settings wire while on, and `{ [key]: { on: false } }` to
 * the frame of the change that turned it off (`changed`: a switch on this seam changed), so a window drops it at
 * once and a frame names nothing of it otherwise. `local`: as for `capabilitiesWire`, a window anywhere else hears
 * nothing of them.
 */
export function capabilitiesFrame(list: readonly InboxCapability[], changed: boolean, local = true): Record<string, unknown> {
  if (!local) return {};
  return Object.assign({}, ...list.map((c) => (c.on() ? (c.settingsWire?.() ?? {}) : changed ? { [c.key]: { on: false } } : {})));
}

/** The settings POST names a capability's switch. */
export function namesInboxCapability(list: readonly InboxCapability[], body: Record<string, unknown>): boolean {
  return list.some((c) => body[c.key] !== undefined);
}

const parseSwitch = (key: string, input: unknown): boolean => {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { on?: unknown }).on !== "boolean" || Object.keys(input).some((k) => k !== "on")) {
    throw new InboxError("validation_error", `${key}: { on: boolean }.`, { field: key });
  }
  return (input as { on: boolean }).on;
};

/** Validate every capability switch the POST names, before anything is saved. */
export function checkInboxCapabilities(list: readonly InboxCapability[], body: Record<string, unknown>): void {
  for (const c of list) if (body[c.key] !== undefined) parseSwitch(c.key, body[c.key]);
}

/**
 * Save the switches the POST names and answer them: each one's settings wire, and `{ [key]: { on } }` to the save
 * that named it even when its wire is empty (as the held switches answer the save that set them).
 */
export function answerInboxCapabilities(list: readonly InboxCapability[], body: Record<string, unknown>): Record<string, unknown> {
  const answer: Record<string, unknown> = {};
  for (const c of list) {
    if (body[c.key] !== undefined) {
      const next = parseSwitch(c.key, body[c.key]);
      if (!c.save(next)) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
    }
    Object.assign(answer, c.settingsWire?.() ?? {}, body[c.key] !== undefined ? { [c.key]: { on: c.on() } } : {});
  }
  return answer;
}

/** The Inbox is going down: each capability ends what it has going. */
export function stopInboxCapabilities(list: readonly InboxCapability[]): void {
  for (const c of list) {
    try {
      c.stopped?.();
    } catch {
      // A capability that cannot end cleanly never holds the Inbox's own stop.
    }
  }
}

/** The Inbox is up: each capability that is on starts its background work. */
export function startInboxCapabilities(list: readonly InboxCapability[]): void {
  for (const c of list) c.started?.();
}
