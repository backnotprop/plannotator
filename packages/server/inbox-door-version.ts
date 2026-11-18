/**
 * The device door's version (adr/implementation/inbox-mobile.md, section 14 "Versions"): the contract this Inbox
 * speaks, the oldest app contract it serves, and `health.door`. The rules a client reads them by are in
 * packages/core/inbox-door-version.ts; the route list comes from the door's own table (`doorRoutesFor` in
 * inbox-devices.ts, next to the allowlist).
 *
 * Raise `DOOR_CONTRACT` for any change to the wire a phone reads: a route, a field, a record kind, a block kind, a
 * code. Raise `MIN_APP_CONTRACT` only for a change of meaning; an additive change never raises it.
 */

import { type InboxAppVersion, type InboxDoorHealth } from "@plannotator/core/inbox-door-version";

export { INBOX_APP_HEADER as APP_HEADER, parseInboxAppHeader as parseAppHeader } from "@plannotator/core/inbox-door-version";

/** The wire contract this Inbox speaks (apps/mobile/contract/VERSION holds the same number once it exists). */
export const DOOR_CONTRACT = 1;
/** An app built against an older contract gets `426 app_needs_update` on every route but `health`, `pair` and `revoke`. */
export const MIN_APP_CONTRACT = 1;

/** The routes an app below the floor still reaches: it learns the floor from `health`, and can still remove itself. */
const BELOW_FLOOR_ROUTES = new Set(["health", "revoke"]);

/** `health.door` for one caller: the routes its token reaches (`doorRoutesFor`), and its grant groups. */
export function doorHealth(routes: readonly string[], grants: readonly string[] = []): InboxDoorHealth {
  return { contract: DOOR_CONTRACT, routes: [...routes], grants: [...grants], min_app_contract: MIN_APP_CONTRACT };
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
