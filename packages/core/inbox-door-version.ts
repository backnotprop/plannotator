/**
 * The device door's version handshake (adr/implementation/inbox-mobile.md, section 14 "Versions").
 *
 * An app names itself on every door request with `X-Plannotator-App: <platform> <app version> contract <n>` (and as
 * `app` inside a sealed relay command). Through the door, `health` answers `door: { contract, routes, not_by_relay, grants,
 * min_app_contract }`: what this Inbox can do for that caller's token. The app reads it with `readInboxDoorHealth`,
 * so neither side probes for a 404 and each can tell the other it is too old.
 *
 * Pure: the Inbox (packages/server/inbox-door-version.ts) and any client read the same rules.
 */

/** The request header an app names itself in. Never forwarded to the window's handler. */
export const INBOX_APP_HEADER = "X-Plannotator-App";

/** An app as it names itself: `ios 1.4.0 contract 14`. */
export interface InboxAppVersion {
  platform: string;
  app_version: string;
  contract: number;
}

const APP_HEADER_FORM = /^([a-z][a-z0-9-]{0,31}) ([0-9A-Za-z][0-9A-Za-z.+-]{0,31}) contract (0|[1-9][0-9]{0,5})$/;

/** The header's value, or null when it is absent or not in the form (a malformed header is read as no header). */
export function parseInboxAppHeader(value: string | null | undefined): InboxAppVersion | null {
  if (typeof value !== "string") return null;
  const match = APP_HEADER_FORM.exec(value.trim());
  if (!match) return null;
  return { platform: match[1]!, app_version: match[2]!, contract: Number(match[3]) };
}

export function formatInboxAppHeader(app: InboxAppVersion): string {
  return `${app.platform} ${app.app_version} contract ${app.contract}`;
}

/** `health.door`, through the device door only (the window's own `health` has none). */
export interface InboxDoorHealth {
  /** The wire contract this Inbox speaks: a whole number, raised only by a breaking change (an addition is found in `routes`). */
  contract: number;
  /** Every route this caller's token reaches, in words: `GET threads`, `POST messages/:id/reply`. */
  routes: string[];
  /** Those of `routes` the sealed relay path refuses (`POST pair`, `GET events`, `POST uploads`, `POST markups`). */
  not_by_relay: string[];
  /** The grant groups this caller's token holds (empty until the grant lands). */
  grants: string[];
  /** Below this contract the Inbox answers `426 app_needs_update` on every route but `health`, `pair` and `revoke`. */
  min_app_contract: number;
}

/** What an Inbox before the handshake is read as: contract 0, the routes it had then. 0 is never an app's contract. */
export const INBOX_DOOR_CONTRACT_BEFORE_HANDSHAKE = 0;

/** What a client built against one contract knows about itself. */
export interface InboxDoorClient {
  /** The contract the app was built against. */
  contract: number;
  /** The oldest Inbox contract the app still serves (0: it serves an Inbox from before the handshake). */
  min_inbox_contract: number;
  /** The routes an Inbox from before the handshake answers, in the same words as `routes`. */
  routes_before_door: readonly string[];
  /** Of those, the ones its relay path refused. Default none. */
  not_by_relay_before_door?: readonly string[];
}

/**
 * What the app does with this Inbox:
 * - `ok`: offer exactly what `routes` and `grants` name. A route not listed is never called, so no POST meets a
 *   `404 device_route_not_found` and no write waits under a key for a route that is not there.
 * - `inbox_needs_update`: this Inbox is older than the app serves; its threads are not listed.
 * - `app_needs_update`: this Inbox refuses the app (`426 app_needs_update` everywhere but health, pair and revoke).
 */
export type InboxDoorSkew =
  | { state: "ok"; contract: number; routes: string[]; not_by_relay: string[]; grants: string[] }
  | { state: "inbox_needs_update"; contract: number; min_inbox_contract: number }
  | { state: "app_needs_update"; contract: number; min_app_contract: number };

const wholeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const strings = (value: unknown): string[] | null => (Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : null);

/** The `door` of a `health` answer, or null for an Inbox from before the handshake (absent, or not in this shape). */
export function inboxDoorOf(health: unknown): InboxDoorHealth | null {
  const door = health && typeof health === "object" ? (health as { door?: unknown }).door : undefined;
  if (!door || typeof door !== "object") return null;
  const { contract, routes, not_by_relay, grants, min_app_contract } = door as Record<string, unknown>;
  const routeList = strings(routes);
  if (!wholeNumber(contract) || !wholeNumber(min_app_contract) || !routeList) return null;
  return { contract, routes: routeList, not_by_relay: strings(not_by_relay) ?? [], grants: strings(grants) ?? [], min_app_contract };
}

/**
 * Read a `health` answer from the door. An Inbox newer than the app: its new routes and fields are simply not
 * offered or read. An Inbox older than the app: only what it lists is offered; one from before the handshake (no
 * `door`) offers `routes_before_door`. A floor on either side wins over everything else; the Inbox's floor first,
 * since it refuses the app's every call.
 */
export function readInboxDoorHealth(health: unknown, client: InboxDoorClient): InboxDoorSkew {
  const door = inboxDoorOf(health);
  const contract = door ? door.contract : INBOX_DOOR_CONTRACT_BEFORE_HANDSHAKE;
  if (door && client.contract < door.min_app_contract) return { state: "app_needs_update", contract, min_app_contract: door.min_app_contract };
  if (contract < client.min_inbox_contract) return { state: "inbox_needs_update", contract, min_inbox_contract: client.min_inbox_contract };
  if (door) return { state: "ok", contract, routes: door.routes, not_by_relay: door.not_by_relay, grants: door.grants };
  return { state: "ok", contract, routes: [...client.routes_before_door], not_by_relay: [...(client.not_by_relay_before_door ?? [])], grants: [] };
}

/** Whether the app may call a route (`POST messages/:id/reply`) on this Inbox, on the path it would use. */
export function inboxDoorOffers(skew: InboxDoorSkew, route: string, path: "direct" | "relay" = "direct"): boolean {
  return skew.state === "ok" && skew.routes.includes(route) && (path === "direct" || !skew.not_by_relay.includes(route));
}
