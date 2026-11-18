/**
 * The device door's version (adr/implementation/inbox-mobile.md, section 14 "Versions"): the contract this Inbox
 * speaks, the oldest app contract it serves, and `health.door`. The rules a client reads them by are in
 * packages/core/inbox-door-version.ts; the route list comes from the door's own table (`doorRouteTable` and
 * `doorReachOf` in inbox-devices.ts, next to the allowlist).
 *
 * `DOOR_CONTRACT` is the one contract number: the contract kit's apps/mobile/contract/VERSION is generated from it. It
 * rises only for a breaking change to the wire a phone reads: a field or route removed or renamed, or a changed meaning.
 * An added optional field or route never raises it: an app finds a new route in `health.door.routes` and decodes
 * unknown fields tolerantly. Raise `MIN_APP_CONTRACT` only when this Inbox stops serving an older contract's meaning.
 */

import { type InboxAppVersion, type InboxDoorHealth } from "@plannotator/core/inbox-door-version";

export { INBOX_APP_HEADER as APP_HEADER, parseInboxAppHeader as parseAppHeader } from "@plannotator/core/inbox-door-version";

/**
 * The one wire contract number (apps/mobile/contract/VERSION is generated from it); breaking changes only, see above.
 * 0 is reserved: it means "before the handshake" (an Inbox with no `health.door`). The first app is contract 1.
 */
export const DOOR_CONTRACT = 1;
/**
 * An app built against an older contract gets `426 app_needs_update` on every route but `health`, `pair` and `revoke`.
 * A well-formed `contract 0` is below it by design: no app is built against "before the handshake".
 */
export const MIN_APP_CONTRACT = 1;
/** The 426's `Upgrade` header (RFC 9110 asks for one): the app contract this Inbox needs at least. */
export const APP_UPGRADE = `plannotator-app/${MIN_APP_CONTRACT}`;

/** The routes an app below the floor still reaches: it learns the floor from `health`, and can still remove itself. */
const BELOW_FLOOR_ROUTES = new Set(["health", "revoke"]);

/** `health.door` for one caller: what its token reaches (`doorReachOf` in inbox-devices.ts), and its grant groups. */
export function doorHealth(reach: { routes: readonly string[]; not_by_relay: readonly string[] }, grants: readonly string[] = []): InboxDoorHealth {
  return { contract: DOOR_CONTRACT, routes: [...reach.routes], not_by_relay: [...reach.not_by_relay], grants: [...grants], min_app_contract: MIN_APP_CONTRACT };
}

/** An app that named itself below the floor, on a route it may not use: the door's refusal body. Null: served. */
export function appBelowFloor(app: InboxAppVersion | null, route: string): { error: string; code: "app_needs_update"; min_app_contract: number } | null {
  if (!app || app.contract >= MIN_APP_CONTRACT || BELOW_FLOOR_ROUTES.has(route)) return null;
  return { error: "Update Plannotator on your phone.", code: "app_needs_update", min_app_contract: MIN_APP_CONTRACT };
}

/** What the door remembers of a device's app, in memory, from its last request that named one (the devices list's `app`). */
export interface DoorDeviceApp {
  app_version: string;
  contract: number;
  seen_at: string;
}
