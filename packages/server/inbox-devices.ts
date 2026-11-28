/**
 * Plannotator Inbox: phones (adr/implementation/inbox-mobile.md, sections 1,
 * 2 and 6). Mounted by packages/server/inbox.ts: the door at the top of its
 * `fetch`, the window routes at the end of its route table.
 *
 * Pairing. `POST /api/inbox/pairing` (a window route behind the window's
 * guards) opens one offer: a 256-bit secret for the QR link and six digits
 * for typing. One offer is open at a time, kept in memory only. It closes
 * when redeemed, when the window makes another, after 10 minutes, or after 5
 * wrong codes: the two limits pairing cannot work without.
 *
 * The door. Every phone request is `/api/inbox/device/<route>`: no Origin, a
 * bearer token whose SHA-256 names a device that is not revoked, a route on
 * the allowlist below, and, for a POST, an `idempotency_key`. The request is
 * then handed to the window's own handler under the window's path, through
 * the server's own `fetch` on loopback; the door adds and strips nothing. A
 * POST's answer is kept per device and key (inbox/device-commands.jsonl), so
 * a retry over another path answers the same without writing again. A
 * command up through the relay enters at `asDevice`, in-process, past the
 * bearer check: the up key that opened it names the device.
 *
 * The tailnet. "Reach from my tailnet" opens a second loopback listener that
 * serves the door and nothing else, and publishes THAT port at
 * `https://<MagicDNS name>:8443` through `tailscale serve` (never funnel).
 * When another mapping holds 8443 at the first publish, the next free port up
 * to 8450; that port then sticks (the address carries it), and a later start
 * that finds it held refuses rather than move (inbox-tailnet-door.ts).
 * `tailscale serve` passes the client's Host header through, so the socket,
 * not a header, keeps tailnet requests on the door. The switch is kept in
 * inbox.json as `tailnet: { https_port, door_port }`; the port and the
 * mapping the Inbox made, and only that, in `inbox/tailnet-door.json`.
 * Published at each start, taken down (listener and mapping) when the switch
 * goes off and at each clean stop.
 *
 * The Wi-Fi. "Reach from this Wi-Fi" opens a TLS listener on every interface
 * that serves the same door-only handler, with a pinned self-signed
 * certificate and a Bonjour record (inbox-lan.ts, contract section 3).
 *
 * Machines (inbox-machines.ts). Another Plannotator Inbox links through the
 * same door as a device with platform `machine`, redeemed from a machine
 * offer. That works with Phones off: then the door answers only a machine's
 * token (anything else is the unknown-route 404, as before), pairing takes
 * only a machine offer, and the tailnet door publishes at start only while a
 * machine is linked. A machine may never ask for the merged view
 * (`machines=1`), so two Inboxes linked both ways cannot echo each other.
 */

import { childEnv } from "@plannotator/shared/child-env";
import { INBOX_CAPABILITY_SWITCH_KEYS } from "@plannotator/core/inbox-types";
import { CAPABILITY_NOTE_FIELD } from "./inbox-capability-note";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { checkInboxThreadName, inboxId } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import {
  INBOX_DEVICE_COMMANDS_FILE,
  InboxDevices,
  JsonLines,
  publicDevice,
  type InboxDevice,
} from "@plannotator/shared/inbox/devices";
import { readInboxRegistry, updateOwnInboxRegistry, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { INBOX_DEVICE_MARKUP_MAX_BYTES } from "@plannotator/shared/inbox/markups";
import { inboxDiskFullError, INBOX_UPLOAD_MAX_BYTES } from "@plannotator/shared/inbox/uploads";
import { describeTailscaleFailure, runTailscale, serveStatusProxy, TAILSCALE_CLI_TIMEOUT_MS, TAILSCALE_SERVE_TIMEOUT_MS, type TailscaleRunner, type TailscaleRunResult } from "@plannotator/shared/tailscale";
import { MACHINE_WINDOW_HEADER } from "./inbox-outbox";
import { INBOX_SENT_FROM_HEADER, inboxSentFromPlaceOf, type InboxSentFromPlace } from "@plannotator/core/inbox-types";
import { formatInboxAppHeader } from "@plannotator/core/inbox-door-version";
import { APP_HEADER, APP_UPGRADE, appBelowFloor, parseAppHeader, type DoorDeviceApp } from "./inbox-door-version";
import { INBOX_SNOOZE_HELD } from "./inbox-snooze";
import { commandTimeRefusal, NOT_AFTER_HEADER } from "./inbox-not-after";
import { createInboxLan, LanUnavailableError } from "./inbox-lan";
import {
  PAIRING_CHECKS_DEADLINE_MS,
  parseTailscaleBackend,
  readPairingChecks,
  runTailscaleQuietly,
  type PairingChecks,
  type PairingProbes,
  type PairingTailscaleRunner,
} from "./inbox-pairing-checks";
import { syncSection } from "./inbox-perf";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { enableTailscaleServe, runTailscaleStepsAsync, TailscaleServeError, takeDownOwnServeMapping, takeDownOwnServeSteps, type TakeDownAnswer } from "./tailscale-serve";
import {
  adoptLegacyTailnetDoor,
  chooseTailnetDoorPort,
  clearTailnetDoorRecord,
  hasTailnetDoorRecord,
  INBOX_TAILNET_HTTPS_PORTS,
  INBOX_TAILNET_PORT_RANGE,
  legacyTailnetDoorRecord,
  loopbackTargetDead,
  ownLeftoverTarget,
  readTailnetDoorRecord,
  withMadeTargets,
  writeTailnetDoorRecord,
  type TailnetDoorPort,
  type TailnetDoorRecord,
} from "./inbox-tailnet-door";

/** The pairing offer's lifetime (limit, contract section 1): long enough to fetch a phone. */
export const PAIRING_OFFER_MS = 10 * 60_000;

/**
 * The tailnet door publishing again by itself, while it should be up (Phones on with the switch on, or a machine
 * linked, or a refusal owed). Tailscale not running (at start, or later): only `tailscale status --json` is read, after
 * each wait in turn, the last one repeated, and the door is published as a start publishes it once it runs. Published:
 * a look every `checkMs` that the mapping still points at this run's door listener, and the same publish when it does
 * not. Tailscale running and the door still not published (a port another mapping holds, a refused serve): the next
 * look after each of `stuckMs`, the last one repeated.
 */
export const INBOX_DOOR_REPUBLISH = {
  waitMs: [30_000, 60_000, 120_000, 240_000, 300_000] as readonly number[],
  checkMs: 10 * 60_000,
  stuckMs: [10 * 60_000, 30 * 60_000] as readonly number[],
};

/** The door's look-again clock: tests pass their own. The default never keeps the process alive. */
export interface InboxDoorTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultDoorTimers: InboxDoorTimers = {
  set: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Wrong six-digit codes before the offer closes (limit, contract section 1). */
export const PAIRING_CODE_TRIES = 5;
/** The tailnet HTTPS port the door takes first (contract section 1, ruling 8); the next free one up to 8450 when it is taken. */
export const INBOX_TAILNET_HTTPS_PORT = INBOX_TAILNET_HTTPS_PORTS[0]!;
/**
 * Phones off: how long the tailnet door stays published for a machine that
 * was unlinked here while it could not be told (asleep, away), so that its
 * next contact is refused (`401 device_revoked`) and it removes its side. A
 * week: a laptop closed for a trip or a holiday still hears it when it opens,
 * and a machine silent for longer is likely gone (wiped, sold), so the door
 * does not stay published for nobody. The outbox keeps settled writes as long.
 */
export const UNLINKED_REFUSAL_KEPT_MS = 7 * 24 * 60 * 60_000;
/** After that refusal has been answered, the door comes down once the answer has left (as `UNLINKED_DOOR_CLOSE_MS`). */
const REFUSED_DOOR_CLOSE_MS = 1_000;

export const DOOR_PREFIX = "/api/inbox/device/";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function refuse(status: number, code: string, error: string, details: Record<string, unknown> = {}): Response {
  return json({ error, code, ...details }, status);
}

/**
 * A raw command (a file to `uploads` or `markups`) carries its key in the query, which rides on whole: the door's
 * refusal when it has none, before a byte of the file is taken. Null: it has one. Exported so a stand-in door in a
 * test refuses exactly what this door refuses (inbox-far-reply-files.test.ts).
 */
export function rawCommandKeyRefusal(search: URLSearchParams): Response | null {
  const key = search.get("idempotency_key");
  if (key !== null && key.trim()) return null;
  return refuse(422, "validation_error", "idempotency_key: required on a phone's command (in the query for a file).", { field: "idempotency_key" });
}

/**
 * A path the door does not open to this caller: `404 device_route_not_found`. Clients act on the code (a linked
 * machine reads it as "needs an update"), never the words. A linked machine's own Inbox gets words for a computer;
 * a phone, and a caller not known yet, "Not a phone route."
 */
function routeNotFound(device: Pick<InboxDevice, "platform"> | null = null): Response {
  return refuse(404, "device_route_not_found", device?.platform === MACHINE_PLATFORM ? "This isn't available from another computer." : "Not a phone route.");
}

/**
 * The allowlist (contract section 2): door route to the window's route. A
 * door path outside it is `404 device_route_not_found`; the window, `/mcp`,
 * the bridge, control, settings (but Capabilities' switches, for a linked machine), restart, the raw text route
 * (`attachments/<id>`; text reaches the phone through `view`), project
 * deletion, drafts, recent searches, launching an app ("Open in"),
 * pairing and the device list are never on it. A linked computer's window
 * reads through the same list: its `machineOnly` entries are the reads a
 * phone does not make (a referenced file, a guided review's whole files, a
 * thread's steps), never a launch or this computer's settings. An attachment's bytes reach
 * the phone only through the window's own `image` and `download` routes, so
 * the dotenv refusal, the size checks and the headers are the window's. The
 * images a message's body shows come the same way, through the window's
 * `messages/<id>/image`.
 *
 * `raw`: the two routes whose body is a file, not JSON (an upload, a
 * drawing). The door streams the body as it came and passes the query on;
 * the idempotency key rides the query (`?idempotency_key=`). The relay does
 * not carry them (`413 relay_upload_unavailable`): v1 sends files over the
 * Wi-Fi or the tailnet only.
 */
interface DoorRoute {
  method: "GET" | "POST";
  route: RegExp;
  window: (m: RegExpExecArray) => string;
  /** A raw body (a file), at most `max` bytes, refused past it with `413 <code>`. */
  raw?: { max: number; code: string; what: string };
  /** Body fields the door refuses (`422`): what the window takes and the phone may not use. */
  refuse?: readonly { field: string; message: string }[];
  /** The window route's query when a linked machine asks: its write may have waited in that machine's outbox. */
  fromMachine?: string;
  /** Only a linked machine's token reaches it (a phone gets the unknown-route 404): starting and stopping agents from another machine. */
  machineOnly?: true;
  /** The only body fields it takes (with `idempotency_key`); any other is refused (`422`) before the window route runs. */
  only?: readonly string[];
  /** A field the door takes besides `only` and never hands to the window route: the caller's note, told after it applies. */
  note?: string;
  /**
   * `draft`: its body or answer carries draft text (words a person is still typing). Such a command is never written
   * to the command log (inbox/device-commands.jsonl, appended to and never compacted) nor kept in memory as a
   * command, whatever its answer: a replay is answered by the window route again, a compare-and-set. DOOR_WRITES calls
   * it `draft` (inbox-outbox.ts; inbox-draft-routes.test.ts holds the two tables together).
   */
  carries?: "draft";
  /** Body fields it must name (`422` without; null counts): a Discard names the version it throws away, `base`. */
  requires?: readonly string[];
}

const ALLOWLIST: readonly DoorRoute[] = [
  { method: "GET", route: /^health$/, window: () => "/api/inbox/health" },
  { method: "GET", route: /^threads$/, window: () => "/api/inbox/threads" },
  { method: "GET", route: /^projects$/, window: () => "/api/inbox/projects" },
  // What's new (public release notes, read only): the release list, a release's notes and their saved images, so a
  // phone reads them as the window does (owner ruling 2026-11-11: one person, the same app on every device).
  { method: "GET", route: /^whats-new$/, window: () => "/api/inbox/whats-new" },
  { method: "GET", route: /^whats-new\/releases$/, window: () => "/api/inbox/whats-new/releases" },
  { method: "GET", route: /^whats-new\/image$/, window: () => "/api/inbox/whats-new/image" },
  // A project's picture (a logo, read only): a linked machine's window shows that machine's project rows with it.
  { method: "GET", route: /^projects\/([^/]+)\/picture$/, window: (m) => `/api/inbox/projects/${m[1]}/picture` },
  // The archived threads (Settings' Archived block), read only; before threads/:id, which would also match it.
  { method: "GET", route: /^threads\/archived$/, window: () => "/api/inbox/threads/archived" },
  { method: "GET", route: /^threads\/([^/]+)$/, window: (m) => `/api/inbox/threads/${m[1]}` },
  { method: "POST", route: /^threads\/([^/]+)\/seen$/, window: (m) => `/api/inbox/threads/${m[1]}/seen` },
  // Grid's look at this Inbox's threads (approval "inbox-agent-grid", inbox-grid-seen.ts): a phone's or a linked machine's.
  { method: "POST", route: /^grid\/seen$/, window: () => "/api/inbox/grid/seen" },
  // Mark read, its Undo (`unread`: Move back) and Mark unread (`mark-unread`).
  { method: "POST", route: /^threads\/([^/]+)\/(read|unread|mark-unread)$/, window: (m) => `/api/inbox/threads/${m[1]}/${m[2]}` },
  // Snooze and Unsnooze (approval "inbox-snooze"): a snooze lives on the thread's home machine.
  { method: "POST", route: /^threads\/([^/]+)\/snooze$/, window: (m) => `/api/inbox/threads/${m[1]}/snooze`, fromMachine: `?${INBOX_SNOOZE_HELD}` },
  // Star and Unstar (`threads/:id/pin`), and the stars' order or Unstar's Undo (`pins`): contract 7.65, approval
  // "inbox-starred-pills". A linked machine sends the same two for this Inbox's threads (approval "inbox-linked-marks").
  { method: "POST", route: /^threads\/([^/]+)\/pin$/, window: (m) => `/api/inbox/threads/${m[1]}/pin` },
  { method: "POST", route: /^pins$/, window: () => "/api/inbox/pins" },
  // Add to Priority, Remove from Priority and their Undo (contract 7.66). A linked machine sends the same for this
  // Inbox's threads (approval "inbox-linked-marks").
  { method: "POST", route: /^threads\/([^/]+)\/priority$/, window: (m) => `/api/inbox/threads/${m[1]}/priority` },
  // An agent's face or given name (approval "inbox-linked-marks"): a linked machine's window sets them for this Inbox's agents.
  { method: "POST", route: /^agent-faces$/, window: () => "/api/inbox/agent-faces", machineOnly: true },
  // A thread's tags, and a tag's rename, delete and Undo (approval "inbox-thread-tags"): a linked machine's window
  // tags this Inbox's threads by a tag's name and changes the tag of that name here. Phones do not take tags.
  { method: "POST", route: /^threads\/([^/]+)\/tags$/, window: (m) => `/api/inbox/threads/${m[1]}/tags`, machineOnly: true },
  { method: "POST", route: /^initiatives\/([^/]+)$/, window: (m) => `/api/inbox/initiatives/${m[1]}`, machineOnly: true },
  // A project's tags (project-tags.ts, mark `project-tags`): a linked machine's window tags this Inbox's projects by a
  // tag's name, as it tags its threads. Phones do not take them.
  { method: "POST", route: /^projects\/([^/]+)\/tags$/, window: (m) => `/api/inbox/projects/${m[1]}/tags`, machineOnly: true },
  // A tag's row colour and "Show tag colors" (mark `tag-colours`): a linked machine's window sets them here too, so
  // every machine shows the same colours, and a phone sets them as the window does (its list ⋮ has the switch).
  { method: "POST", route: /^tag-colours$/, window: () => "/api/inbox/tag-colours" },
  // The Board's cards (mark `cards`): a linked machine's window lists this Inbox's cards, opens one, and moves,
  // edits, links and tags it here; the look and "Got it" are this store's too. Phones have no Board.
  { method: "GET", route: /^cards$/, window: () => "/api/inbox/cards", machineOnly: true },
  { method: "GET", route: /^cards\/(crd_[^/]+)$/, window: (m) => `/api/inbox/cards/${m[1]}`, machineOnly: true },
  { method: "GET", route: /^cards\/(crd_[^/]+)\/refs$/, window: (m) => `/api/inbox/cards/${m[1]}/refs`, machineOnly: true },
  { method: "POST", route: /^cards\/(crd_[^/]+)$/, window: (m) => `/api/inbox/cards/${m[1]}`, machineOnly: true },
  { method: "POST", route: /^cards\/seen$/, window: () => "/api/inbox/cards/seen", machineOnly: true },
  { method: "POST", route: /^cards\/dropped\/seen$/, window: () => "/api/inbox/cards/dropped/seen", machineOnly: true },
  // The PR board (mark `pulls`): a linked machine's window lists the PRs this Inbox's gh / glab lists, opens one (its
  // diff, files, details, pictures), closes, reopens or merges one of them here, as this computer's signed-in
  // account, and ties PRs to a review thread it started here (`owner`, after the thread's start through
  // `messages`). Those four run only with the window's mark (`window`), which stops a bare call, the relay and a phone
  // (no PR board), not a program on that machine that imitates its window (inbox-launch.md "Accepted, not defended").
  { method: "GET", route: /^pulls$/, window: () => "/api/inbox/pulls", machineOnly: true },
  // Branch reviews (mark `branches`): a linked machine's Reviews lists the branches agents reported here.
  { method: "GET", route: /^reviews\/branches$/, window: () => "/api/inbox/reviews/branches", machineOnly: true },
  // `pull`: one PR for a page open on it after it left that window's board (merged or closed here): this Inbox's kept copy or the forge's answer.
  { method: "GET", route: /^pulls\/(risk|pull|details|diff|file|repo-files|repo-file|avatar|media|media\/sizes)$/, window: (m) => `/api/inbox/pulls/${m[1]}`, machineOnly: true },
  { method: "POST", route: /^pulls\/(close|reopen|merge|owner)$/, window: (m) => `/api/inbox/pulls/${m[1]}`, machineOnly: true },
  // Ship (approval "inbox-ship-mode"): a ship lives on the machine of its agent's thread; a window on either ships,
  // reads and stops it there.
  { method: "GET", route: /^ships$/, window: () => "/api/inbox/ships", machineOnly: true },
  { method: "GET", route: /^ships\/log$/, window: () => "/api/inbox/ships/log", machineOnly: true },
  { method: "POST", route: /^ships$/, window: () => "/api/inbox/ships", machineOnly: true },
  { method: "POST", route: /^ships\/stop$/, window: () => "/api/inbox/ships/stop", machineOnly: true },
  // A linked computer's Inbox started shipping a pull request: an older ship of it here stops (one ship per PR).
  { method: "POST", route: /^ships\/newer$/, window: () => "/api/inbox/ships/newer", machineOnly: true },
  // "Changed since you looked" (approval "inbox-pr-dashboard"): the look at a PR lives on the machine that lists it.
  { method: "POST", route: /^pulls\/looked$/, window: () => "/api/inbox/pulls/looked", machineOnly: true },
  // A thread's PRs (approval "inbox-pr-binding"): read, added and removed on the thread's own machine.
  { method: "GET", route: /^threads\/([^/]+)\/pulls$/, window: (m) => `/api/inbox/threads/${m[1]}/pulls`, machineOnly: true },
  { method: "POST", route: /^threads\/([^/]+)\/pulls$/, window: (m) => `/api/inbox/threads/${m[1]}/pulls`, machineOnly: true },
  // Pinned artifacts (mark `artifact-pins`, approval "inbox-artifact-stars"): a linked machine's window pins and unpins
  // this Inbox's threads' artifacts here, and reads this Inbox's Artifacts wall. A phone never sees artifact pins.
  { method: "POST", route: /^artifact-pins$/, window: () => "/api/inbox/artifact-pins", machineOnly: true },
  { method: "GET", route: /^artifacts$/, window: () => "/api/inbox/artifacts", machineOnly: true },
  { method: "GET", route: /^events$/, window: () => "/api/inbox/events" },
  // `to`: Send to another session (7.41), a person message no session took yet. `ack`: 👍 Looks good and its Undo (7.56).
  // `reask`: Re-ask, the agent asks its open questions again in one message (7.61).
  { method: "POST", route: /^messages\/([^/]+)\/(picks|reply|resolve|to|ack|send-now|take-back|reask)$/, window: (m) => `/api/inbox/messages/${m[1]}/${m[2]}` },
  // A hand-off's Undo inside its window (approval "inbox-tag-handoff", contract 7.64): the reply goes as an Ask.
  { method: "POST", route: /^messages\/([^/]+)\/handoff\/undo$/, window: (m) => `/api/inbox/messages/${m[1]}/handoff/undo` },
  // Remove an agent from a thread, and its Undo (approval "inbox-remove-agent-from-thread", mark `remove-agent`).
  { method: "POST", route: /^threads\/([^/]+)\/remove-agent$/, window: (m) => `/api/inbox/threads/${m[1]}/remove-agent` },
  { method: "POST", route: /^threads\/([^/]+)\/remove-agent\/undo$/, window: (m) => `/api/inbox/threads/${m[1]}/remove-agent/undo` },
  // An action item's Done or Can't do it, and its Undo (approval "inbox-next-actions", contract 7.63).
  { method: "POST", route: /^messages\/([^/]+)\/actions\/(a-[0-9a-f]{8}(?:-\d{1,3})?)$/, window: (m) => `/api/inbox/messages/${m[1]}/actions/${m[2]}` },
  // Run on a `:::run` block, its Stop and Open in terminal, and Save or Remove on a `:::secret` block: the person on
  // their phone, or a press in a window on their linked machine (inbox-run-routes.ts checks which; never held).
  { method: "GET", route: /^messages\/([^/]+)\/run$/, window: (m) => `/api/inbox/messages/${m[1]}/run` },
  { method: "POST", route: /^messages\/([^/]+)\/run$/, window: (m) => `/api/inbox/messages/${m[1]}/run` },
  { method: "POST", route: /^messages\/([^/]+)\/secret$/, window: (m) => `/api/inbox/messages/${m[1]}/secret` },
  { method: "POST", route: /^threads\/([^/]+)\/delete$/, window: (m) => `/api/inbox/threads/${m[1]}/delete` },
  // The thread's reply draft (the words typed on the computer and not sent), read only: contract 7.62.
  { method: "GET", route: /^threads\/([^/]+)\/draft$/, window: (m) => `/api/inbox/threads/${m[1]}/draft` },
  // A linked machine's window saves and discards the reply draft of this Inbox's thread here (mark `reply-drafts`), so
  // the draft is one on every window of both machines. A phone writes none (7.62): the unknown-route 404, as before.
  // Draft text: never in the command log. A save replayed under its key is answered by the store (`last_key`); a
  // Discard always names the version it throws away (`base`), so a replay never deletes words typed after it.
  { method: "POST", route: /^threads\/([^/]+)\/draft$/, window: (m) => `/api/inbox/threads/${m[1]}/draft`, machineOnly: true, carries: "draft" },
  { method: "POST", route: /^threads\/([^/]+)\/draft\/delete$/, window: (m) => `/api/inbox/threads/${m[1]}/draft/delete`, machineOnly: true, carries: "draft", requires: ["base"] },
  { method: "GET", route: /^threads\/([^/]+)\/attachments$/, window: (m) => `/api/inbox/threads/${m[1]}/attachments` },
  // Export decisions: the thread's decisions as a download (`?format=md|html|json&tz=`), read only, from what the thread read serves.
  { method: "GET", route: /^threads\/([^/]+)\/decisions$/, window: (m) => `/api/inbox/threads/${m[1]}/decisions` },
  { method: "GET", route: /^attachments\/([^/]+)\/view$/, window: (m) => `/api/inbox/attachments/${m[1]}/view` },
  // An image's bytes, a video's or a recording's (by Range) and any kind's download (by Range
  // too): the window's own routes, so the phone gets the same dotenv refusal,
  // sniffed type and headers. Of the phone's request headers the door forwards
  // Range, If-Range and If-None-Match (and Last-Event-ID to the event stream).
  { method: "GET", route: /^attachments\/([^/]+)\/(image|video|audio|download)$/, window: (m) => `/api/inbox/attachments/${m[1]}/${m[2]}` },
  // A Markdown file's own pictures and a document next to an attached file (approval "linked computers only",
  // 2026-11-16): a linked machine's window shows them as for a file of its own. The window's own routes, so the same
  // rules (by the attachment's id, inside its folder, pictures the file shows, sniffed, capped) and headers. Not a
  // phone's: a phone reads them through the tailnet as the owner.
  { method: "GET", route: /^attachments\/([^/]+)\/(markdown-image|linked-page)$/, window: (m) => `/api/inbox/attachments/${m[1]}/${m[2]}`, machineOnly: true },
  { method: "GET", route: /^markups\/([^/]+)$/, window: (m) => `/api/inbox/markups/${m[1]}` },
  // An image a message's body shows (`?path=<src as written>`, a question
  // block's context included): the window's own route, so the phone gets the
  // same rules (referenced by that body, inside its project, sniffed, capped)
  // and the same headers. The query rides through as the door received it.
  { method: "GET", route: /^messages\/([^/]+)\/image$/, window: (m) => `/api/inbox/messages/${m[1]}/image` },
  { method: "GET", route: /^html-assets\/([^/]+)\/(.+)$/, window: (m) => `/api/html-assets/${m[1]}/${m[2]}` },
  { method: "POST", route: /^annotations$/, window: () => "/api/inbox/annotations" },
  { method: "POST", route: /^annotations\/([^/]+)\/remove$/, window: (m) => `/api/inbox/annotations/${m[1]}/remove` },
  { method: "GET", route: /^messages\/([^/]+)\/guide$/, window: (m) => `/api/inbox/messages/${m[1]}/guide` },
  { method: "POST", route: /^messages\/([^/]+)\/guide\/reviewed$/, window: (m) => `/api/inbox/messages/${m[1]}/guide/reviewed` },
  // A comment on a guided review's diff (7.53), new or edited (same annotation id); removed through annotations/:id/remove.
  { method: "POST", route: /^messages\/([^/]+)\/guide\/annotations$/, window: (m) => `/api/inbox/messages/${m[1]}/guide/annotations` },
  // A guided review on a linked machine's window (mark `linked-reads`): a changed file's whole text (the expand arrows),
  // an image's sides, a changed Markdown file's pictures, the package changes card, and the files ticked Viewed. The
  // window's own routes, so the same rules (the guide's own patch and project) and headers. Not a phone's.
  { method: "GET", route: /^messages\/([^/]+)\/guide\/(file|review-image|review-markdown-image|package-changes)$/, window: (m) => `/api/inbox/messages/${m[1]}/guide/${m[2]}`, machineOnly: true },
  { method: "POST", route: /^messages\/([^/]+)\/guide\/viewed$/, window: (m) => `/api/inbox/messages/${m[1]}/guide/viewed`, machineOnly: true },
  // A thread's steps (approval "inbox-thread-steps"), read only, for a linked machine's window (mark `linked-reads`).
  { method: "GET", route: /^threads\/([^/]+)\/steps$/, window: (m) => `/api/inbox/threads/${m[1]}/steps`, machineOnly: true },
  // A comment on the text of an agent's message (7.59), new or edited (same annotation id); removed through annotations/:id/remove.
  { method: "POST", route: /^messages\/([^/]+)\/annotations$/, window: (m) => `/api/inbox/messages/${m[1]}/annotations` },
  { method: "GET", route: /^threads\/([^/]+)\/sessions$/, window: (m) => `/api/inbox/threads/${m[1]}/sessions` },
  // Tags (7.60): who the person can tag with `@`; the tags ride the reply's `tags`, forwarded unchanged.
  { method: "GET", route: /^threads\/([^/]+)\/taggable$/, window: (m) => `/api/inbox/threads/${m[1]}/taggable` },
  { method: "POST", route: /^threads\/([^/]+)\/message$/, window: (m) => `/api/inbox/threads/${m[1]}/message` },
  // Compose (7.39, 7.40): every live session, and a thread the person starts (the body's key is also the store's own).
  { method: "GET", route: /^sessions$/, window: () => "/api/inbox/sessions" },
  // `draft_id` deletes a shared draft, and drafts stay on the computer (never seen by phones).
  {
    method: "POST",
    route: /^messages$/,
    window: () => "/api/inbox/messages",
    refuse: [{ field: "draft_id", message: "draft_id: drafts stay on the computer; a phone sends without one." }],
  },
  // Search (7.42), read only; the query rides through. The door sends no Origin, so the route's cross-site check passes.
  { method: "GET", route: /^search$/, window: () => "/api/inbox/search" },
  // The project menu (7.43 to 7.45): Mark all as read, Archive all, and their Undo. The door's log replays a batch's answer.
  { method: "POST", route: /^projects\/([^/]+)\/(read|unread|resolve)$/, window: (m) => `/api/inbox/projects/${m[1]}/${m[2]}` },
  // The skill catalog (7.46, 7.47), read only.
  { method: "GET", route: /^skills$/, window: () => "/api/inbox/skills" },
  { method: "GET", route: /^skills\/content$/, window: () => "/api/inbox/skills/content" },
  // Uploads and drawings (7.48, 7.49): raw bodies, the key in the query; never through the relay.
  // A file the phone can already see, for the message being written: no bytes, so an ordinary JSON route.
  { method: "POST", route: /^uploads\/reuse$/, window: () => "/api/inbox/uploads/reuse" },
  { method: "POST", route: /^uploads$/, window: () => "/api/inbox/uploads", raw: { max: INBOX_UPLOAD_MAX_BYTES, code: "upload_too_large", what: "a file" } },
  { method: "POST", route: /^markups$/, window: () => "/api/inbox/markups", raw: { max: INBOX_DEVICE_MARKUP_MAX_BYTES, code: "markup_too_large", what: "a drawing" } },
  // A pending pasted-text upload's words (approval "inbox-paste-attachment"), read only: a linked machine's
  // window puts a long paste back in a reply to this machine's thread, as it uploaded it here.
  { method: "GET", route: /^uploads\/([^/]+)\/text$/, window: (m) => `/api/inbox/uploads/${m[1]}/text` },
  { method: "GET", route: /^uploads\/([^/]+)\/image$/, window: (m) => `/api/inbox/uploads/${m[1]}/image` },
  // Tidy and Combine on this Inbox's threads from a linked machine's window (approval "inbox-multi-select", marks `tidy`
  // and `combine`): its own sessions are asked, since only they can read its threads. Phones have no Tidy.
  { method: "GET", route: /^tidy$/, window: () => "/api/inbox/tidy", machineOnly: true },
  { method: "POST", route: /^tidy$/, window: () => "/api/inbox/tidy", machineOnly: true },
  { method: "GET", route: /^combine$/, window: () => "/api/inbox/combine", machineOnly: true },
  { method: "POST", route: /^combine$/, window: () => "/api/inbox/combine", machineOnly: true },
  { method: "POST", route: /^combine\/(cmb_[^/]+)\/(cancel|undo)$/, window: (m) => `/api/inbox/combine/${m[1]}/${m[2]}`, machineOnly: true },
  // A linked computer's Combine that holds some of this Inbox's threads marks them busy here while it waits, and lets go
  // (approval "inbox-combine-across-computers"; inbox-combine-across.ts). A machine's token only: the route knows which.
  { method: "POST", route: /^combine\/hold$/, window: () => "/api/inbox/combine/hold", machineOnly: true },
  // A launched agent's Stop, Try again, Trust folder and Delete from a linked machine's window (remote launch). Open in
  // Terminal and the launch settings never cross: they are this computer's.
  { method: "POST", route: /^launch\/([^/]+)\/(stop|retry|trust|delete)$/, window: (m) => `/api/inbox/launch/${m[1]}/${m[2]}`, machineOnly: true },
  // Show in Rex for one of this Inbox's agents, from a linked machine's window (inbox-rex-far.ts): the Rex apps
  // attached to this computer's Rex from elsewhere go to its pane.
  { method: "POST", route: /^rex\/show$/, window: () => "/api/inbox/rex/show", machineOnly: true },
  // A file an agent's message names, read only (approval "inbox-file-refs-open-viewer"): its view and an image's or a
  // film's bytes (by Range), for a linked machine's window. The window's own routes, so the same refusals and headers.
  // Not a phone's: a phone reads them through the tailnet as the owner.
  { method: "GET", route: /^open-in\/file\/(view|raw)$/, window: (m) => `/api/inbox/open-in/file/${m[1]}`, machineOnly: true },
  // A code span's hover text (mark `linked-reads`): held to the thread's own folders for a linked machine (inbox-open-in.ts).
  { method: "GET", route: /^open-in\/file\/code$/, window: () => "/api/inbox/open-in/file/code", machineOnly: true },
  // Whether that file is there, and its path there (the hover's and a diff header's Copy path), held the same way.
  // Only the GET: launching an app (its POST) is never on the door.
  { method: "GET", route: /^open-in\/file$/, window: () => "/api/inbox/open-in/file", machineOnly: true },
  // And attached to its message there when the person comments on it from a linked machine's window.
  { method: "POST", route: /^open-in\/file\/attach$/, window: () => "/api/inbox/open-in/file/attach", machineOnly: true },
  // "Another folder on <machine>…": folder names under that machine's home, for a linked machine's window only.
  { method: "GET", route: /^launch\/folders$/, window: () => "/api/inbox/launch/folders", machineOnly: true },
  // Clone from a git URL: where a URL would be cloned on that machine, and whether its git can read it.
  { method: "GET", route: /^launch\/(clone|clone-check)$/, window: (m) => `/api/inbox/launch/${m[1]}`, machineOnly: true },
  // Routines (mark `routines`): a linked computer's window lists, opens, previews, makes, edits, turns on or off, runs,
  // stops, deletes and brings back this Inbox's routines here, which run here as ever. The window's own routes, so the
  // same checks: a write only with the window's mark (`scheduledRoute`'s `farWindow`), Routines off answers
  // `routines_off`. Phones have no Routines.
  { method: "GET", route: /^scheduled$/, window: () => "/api/inbox/scheduled", machineOnly: true },
  { method: "GET", route: /^scheduled\/(sch_[A-Za-z0-9_-]{1,80})$/, window: (m) => `/api/inbox/scheduled/${m[1]}`, machineOnly: true },
  { method: "POST", route: /^scheduled$/, window: () => "/api/inbox/scheduled", machineOnly: true },
  { method: "POST", route: /^scheduled\/preview$/, window: () => "/api/inbox/scheduled/preview", machineOnly: true },
  { method: "POST", route: /^scheduled\/(sch_[A-Za-z0-9_-]{1,80})$/, window: (m) => `/api/inbox/scheduled/${m[1]}`, machineOnly: true },
  { method: "POST", route: /^scheduled\/(sch_[A-Za-z0-9_-]{1,80})\/(on|off|run|stop|delete|restore)$/, window: (m) => `/api/inbox/scheduled/${m[1]}/${m[2]}`, machineOnly: true },
  // Settings → Capabilities' switches (mark `capabilities`, core inbox-capability-switches.ts): a linked computer's
  // window reads them, and turns one on or off through the settings route with those keys alone. No other setting.
  { method: "GET", route: /^capabilities$/, window: () => "/api/inbox/capabilities", machineOnly: true },
  // `capability_note`: which agent there turned it, so this computer posts its own line (inbox-capability-note.ts).
  { method: "POST", route: /^capabilities$/, window: () => "/api/inbox/settings", machineOnly: true, only: INBOX_CAPABILITY_SWITCH_KEYS, note: CAPABILITY_NOTE_FIELD },
];

/**
 * The door's own routes, beside the allowlist: `pair` (no token, answered before the token is read), `revoke`, and a
 * linked machine's own (never on the allowlist, so no phone reaches them): its link-back and unlink (inbox-machines.ts
 * answers them), this computer's update, read and started for a linked machine's window, this computer's accounts,
 * and its agents' reads of this computer's threads and their files (`agent-read`, `agent-file`), search and list (`agent-search`, `agent-threads`). `serve` answers the machine's through `machineOwn`, typed by this list, so a route here without an answer,
 * or an answer not here, does not compile. `needs`: answered only while this Inbox has it, and only then listed.
 */
const DOOR_OWN_ROUTES = [
  { method: "POST", route: "pair", grant: "phone" },
  { method: "POST", route: "revoke", grant: "phone" },
  { method: "GET", route: "accounts", grant: "machine" },
  // A linked machine's agent reads this Inbox's threads and fetches the files they list (inbox-far-read.ts, mark `agent-read`).
  { method: "GET", route: "agent-read", grant: "machine", needs: "machines" },
  { method: "GET", route: "agent-file", grant: "machine", needs: "machines" },
  // Its agent's search and thread list of this Inbox's threads (inbox-far-find.ts, mark `agent-search`).
  { method: "GET", route: "agent-search", grant: "machine", needs: "machines" },
  { method: "GET", route: "agent-threads", grant: "machine", needs: "machines" },
  // Tag an agent on another computer (inbox-far-tags.ts, mark `tag-across`): this Inbox's agents for that computer's
  // `@` list, a wake that computer hands one of them, one of its sessions' answer in a thread here, and its delivery.
  { method: "GET", route: "taggable-agents", grant: "machine", needs: "machines" },
  { method: "POST", route: "far-wake", grant: "machine", needs: "machines" },
  { method: "POST", route: "agent-reply", grant: "machine", needs: "machines" },
  { method: "POST", route: "far-delivered", grant: "machine", needs: "machines" },
  { method: "POST", route: "link-back", grant: "machine", needs: "machines" },
  { method: "POST", route: "unlink", grant: "machine", needs: "machines" },
  // Link two computers through a third (inbox-link-through.ts, mark `link-through`): a linked computer asks this one to
  // broker, a broker asks this one for a link code for another of its links, or hands this one another's code.
  { method: "POST", route: "link-through-ask", grant: "machine", needs: "machines" },
  { method: "POST", route: "link-through-offer", grant: "machine", needs: "machines" },
  { method: "POST", route: "link-through-introduce", grant: "machine", needs: "machines" },
  { method: "GET", route: "update", grant: "machine", needs: "machine_update" },
  { method: "POST", route: "update", grant: "machine", needs: "machine_update" },
] as const satisfies readonly { method: "GET" | "POST"; route: string; grant: "phone" | "machine"; needs?: DoorOwnNeeds }[];

/** What an own route needs from this Inbox to be answered: linked machines, or Update from another machine. */
type DoorOwnNeeds = "machines" | "machine_update";
type DoorOwnRoute = (typeof DOOR_OWN_ROUTES)[number];
/** A linked machine's own routes by name (`POST link-back`). */
type OwnName<R> = R extends { method: infer M extends string; route: infer P extends string } ? `${M} ${P}` : never;
type MachineOwnName = OwnName<Extract<DoorOwnRoute, { grant: "machine" }>>;

/** Of an answer, only the named fields (a route with `only`). */
function onlyFields(answer: unknown, only: readonly string[]): Record<string, unknown> {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return {};
  return Object.fromEntries(Object.entries(answer).filter(([field]) => only.includes(field)));
}

/** Door routes the sealed relay path never carries (`asDevice`): `pair`, and the event stream. Raw bodies neither. */
const NOT_BY_RELAY = new Set(["pair", "events"]);

/**
 * The window route a door request goes to, or null: the allowlist's first entry for its method and route, skipping a
 * linked machine's own entries for a phone.
 */
export function doorRouteOf(method: string, route: string, machine: boolean): { entry: (typeof ALLOWLIST)[number]; windowPath: string } | null {
  for (const entry of ALLOWLIST) {
    if (entry.method !== method) continue;
    if (entry.machineOnly && !machine) continue;
    const match = entry.route.exec(route);
    if (match) return { entry, windowPath: entry.window(match) };
  }
  return null;
}

/**
 * For rule 8's test (inbox-outbox.test.ts): every door route in words (`GET threads`, `POST messages/:id/(picks|reply|…)`),
 * then a linked machine's own (the same rows as `doorRouteTable`).
 */
export function doorRouteNames(): string[] {
  const words = (route: RegExp) => route.source.replace(/^\^|\$$/g, "").replaceAll("([^/]+)", ":id").replaceAll("\\/", "/");
  const own = DOOR_OWN_ROUTES.filter((row) => row.grant === "machine").map((row) => `${row.method} ${row.route}`);
  return [...ALLOWLIST.map((entry) => `${entry.method} ${words(entry.route)}`), ...own];
}

/** For rule 8's test: the door's POST routes, which take a raw body (a file), and which carry draft text. */
export function doorWriteRoutes(): { route: string; raw: boolean; carries: "draft" | null }[] {
  return ALLOWLIST.filter((entry) => entry.method === "POST").map((entry) => ({ route: entry.route.source, raw: entry.raw !== undefined, carries: entry.carries ?? null }));
}

/**
 * One route the door answers, in words (`health.door.routes`, and apps/mobile/contract's door table). `route` has
 * every alternation written out (`messages/:id/reply`); `:id` is one path segment, `:path` the rest of the path.
 */
export interface DoorRouteRow {
  method: "GET" | "POST";
  route: string;
  /** `<method> <route>`: what `health.door.routes` lists. */
  name: string;
  /** The pattern it comes from, a RegExp source relative to `DOOR_PREFIX`. */
  pattern: string;
  /** Whose token reaches it: a phone's reaches `phone`; a linked computer's reaches both. */
  grant: "phone" | "machine";
  /** The body is a file and the key rides the query; never carried by the relay. */
  raw: boolean;
  /**
   * The sealed relay path carries it (`asDevice`). False for `pair`, the event stream and the two raw-body routes. A
   * carried byte route answers the whole file (no Range through the relay), or `413 result_too_large`.
   */
  relay: boolean;
}

/** A route pattern in words: `(a|b)` of plain words written out, `(.+)` as `:path`, any other group as `:id`. */
function routeWords(source: string): string[] {
  const body = source.replace(/^\^/, "").replace(/\$$/, "");
  let out = [""];
  for (let i = 0; i < body.length; ) {
    if (body[i] === "\\") {
      out = out.map((words) => words + body[i + 1]);
      i += 2;
      continue;
    }
    if (body[i] !== "(") {
      out = out.map((words) => words + body[i]);
      i += 1;
      continue;
    }
    let depth = 0;
    let end = i;
    for (; end < body.length; end++) {
      if (body[end] === "\\") end += 1;
      else if (body[end] === "(") depth += 1;
      else if (body[end] === ")" && --depth === 0) break;
    }
    const inner = body.slice(i + 1, end);
    const options = /^[a-z-]+(?:\\\/[a-z-]+)*(?:\|[a-z-]+(?:\\\/[a-z-]+)*)*$/.test(inner) ? inner.replaceAll("\\/", "/").split("|") : [inner === ".+" ? ":path" : ":id"];
    out = out.flatMap((words) => options.map((option) => words + option));
    i = end + 1;
  }
  return out;
}

let table: readonly DoorRouteRow[] | null = null;

/** Every route the door answers, one row per route in words: the one source `health.door` and the contract kit read. */
export function doorRouteTable(): readonly DoorRouteRow[] {
  if (table) return table;
  const rows: DoorRouteRow[] = ALLOWLIST.flatMap((entry) =>
    routeWords(entry.route.source).map((route) => ({
      method: entry.method,
      route,
      name: `${entry.method} ${route}`,
      pattern: entry.route.source,
      grant: entry.machineOnly ? ("machine" as const) : ("phone" as const),
      raw: entry.raw !== undefined,
      relay: entry.raw === undefined && !NOT_BY_RELAY.has(route),
    })),
  );
  for (const own of DOOR_OWN_ROUTES) {
    rows.push({ method: own.method, route: own.route, name: `${own.method} ${own.route}`, pattern: `^${own.route}$`, grant: own.grant, raw: false, relay: !NOT_BY_RELAY.has(own.route) });
  }
  table = rows;
  return rows;
}

const OWN_NEEDS = new Map<string, DoorOwnNeeds>(DOOR_OWN_ROUTES.flatMap((own) => ("needs" in own ? [[`${own.method} ${own.route}`, own.needs] as const] : [])));

/**
 * What a caller's token reaches (`health.door`): a phone's token the `phone` rows; a linked computer's every row.
 * `has`: whether this Inbox answers an own route that needs something (`createInboxDevices` asks its context).
 * `not_by_relay`: those of `routes` the sealed relay path refuses.
 */
export function doorReachOf(platform: string, has: (needs: DoorOwnNeeds) => boolean = () => true): { routes: string[]; not_by_relay: string[] } {
  const machine = platform === MACHINE_PLATFORM;
  const rows = doorRouteTable().filter((row) => (machine || row.grant === "phone") && (!OWN_NEEDS.has(row.name) || has(OWN_NEEDS.get(row.name)!)));
  return { routes: rows.map((row) => row.name), not_by_relay: rows.filter((row) => !row.relay).map((row) => row.name) };
}

/** Where a pairing attempt reached the door: the Wi-Fi's listener, the tailnet's, or this computer's own port (the simulator). */
export type PairingVia = "wifi" | "tailnet" | "local";

/**
 * What reached the door while an offer showed (design of record
 * `.product/approved/inbox-settings-tabs/`, section 4.1): the window says it
 * live, and when the code expires with nothing seen it shows the
 * troubleshooting list instead.
 */
export interface PairingAttempt {
  via: PairingVia;
  /**
   * `wrong_code`: six digits that did not match. `code_over_wifi`: digits
   * typed over the Wi-Fi, which pairs by the QR only. `old_code`: the secret
   * of an earlier code. `expired`: a phone came after the code closed.
   * `redeemed`: the phone paired.
   */
  result: "wrong_code" | "code_over_wifi" | "old_code" | "expired" | "redeemed";
  at: string;
  /** `wrong_code`: tries left on this code. */
  tries_left?: number;
  /** `redeemed`: the phone's name. */
  device?: string;
}

/** How long one read of Pair a phone's checks answers again: the flow asks on open, on Check again and after each switch. */
export const PAIRING_CHECKS_FRESH_MS = 3_000;

/** The most attempts one offer keeps (a phone retrying in a loop must not grow it without end). */
const PAIRING_ATTEMPTS_KEPT = 20;

interface Offer {
  secret: string;
  code: string;
  expiresAt: number;
  wrong: number;
  redeemed: boolean;
  attempts: PairingAttempt[];
}

interface CommandLine {
  v: 1;
  at: string;
  device_id: string;
  key: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export interface TailnetState {
  /** The person's switch, as inbox.json keeps it. */
  on: boolean;
  /** `host:port` the phone reaches, while the publication works. */
  address: string | null;
  /** Why the publication is not working, in the window's words. */
  error: string | null;
}

export interface InboxDevicesContext {
  dataDir: string;
  serverSession: string;
  /** This run's loopback port. */
  port: () => number;
  registry: () => InboxRegistryEntry;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  /** The server's own `fetch`: the door hands each allowed request to it on loopback, saying which device asked. */
  dispatch: (req: Request, from: InboxDoorCaller) => Promise<Response>;
  now?: () => Date;
  /** Tests: how long the door stays up for a machine unlinked while it could not be told. Default `UNLINKED_REFUSAL_KEPT_MS`. */
  refusalKeptMs?: number;
  tailscale?: TailscaleRunner;
  /** Tests: how step 1's checks run `tailscale` (may be asynchronous). Default: `tailscale` when given, else the CLI as a child process. */
  checksTailscale?: PairingTailscaleRunner;
  /** Tests: the checks' deadline. Default `PAIRING_CHECKS_DEADLINE_MS`. */
  checksDeadlineMs?: number;
  /** Step 1 of Pair a phone: how its checks are read (inbox-pairing-checks.ts). Default: this computer's own tools. */
  probes?: Partial<PairingProbes>;
  /** The relay (packages/server/inbox-relay.ts): told of each pairing, whose answer carries the mailbox, and of each removal. */
  relay?: {
    paired: (device: InboxDevice) => Promise<{ url: string; mailbox_id: string } | null>;
    revoked: (device: InboxDevice) => void;
  };
  /** Phones on (PLANNOTATOR_INBOX_PHONES): the whole phone surface. Off: the door serves linked machines only. Default true. */
  phones?: boolean;
  /** Linked machines (inbox-machines.ts): the two door routes only a machine calls. Bound after both exist. */
  machines?: () => InboxDoorMachines | null;
  /** A door write's note (`DoorRoute.note`), once its write applied: the device that sent it, the note as sent, the write. */
  noted?: (device: InboxDevice, note: unknown, written: Record<string, unknown>) => void;
  /** A linked machine's agents' reads of this Inbox's threads and their files (inbox-far-read.ts). */
  agentRead?: { read: (url: URL, device: InboxDevice) => Response; file: (url: URL) => Promise<Response> };
  /** A linked machine's agents' search and thread list of this Inbox's threads (inbox-far-find.ts). */
  agentFind?: { search: (url: URL) => Promise<Response>; threads: (url: URL) => Response | Promise<Response> };
  /** Tag an agent on another computer (inbox-far-tags.ts, inbox-far-wakes.ts): each write named by the machine whose token sent it. */
  farTags?: {
    agents: () => Response;
    wake: (machine: string, body: Record<string, unknown>) => unknown;
    reply: (machine: string, body: Record<string, unknown>) => Promise<unknown>;
    delivered: (machine: string, body: Record<string, unknown>) => unknown;
  };
  /** A linked machine's Update (inbox-updates.ts). */
  machineUpdate?: { read: () => unknown; start: () => Promise<{ outcome: string }> };
  /** Tests: the door's look-again clock (`INBOX_DOOR_REPUBLISH`). Default: unref'd timers. */
  doorTimers?: InboxDoorTimers;
  /** The door was published again by itself (Tailscale came back, or its mapping was lost): the windows hear it. */
  onDoorRepublished?: () => void;
}

/**
 * Who a request the door hands on came from. `window`: a linked machine says the person pressed it in a window
 * there (`X-Plannotator-Window`), which its own Inbox checked; only a machine's word counts, a phone's never asks.
 */
export interface InboxDoorCaller {
  device_id: string;
  name: string;
  platform: string;
  window: boolean;
  /** A linked machine says where the person was when not at its own window (`X-Plannotator-Sent-From`); a phone's never counts. */
  place?: InboxSentFromPlace | null;
}

/** What the door hands to inbox-machines.ts. */
export interface InboxDoorMachines {
  /** The other machine handed this Inbox a code for its own door: link back (both ways). */
  linkBack: (deviceId: string, body: Record<string, unknown>) => Promise<Response>;
  /** The other machine unlinked this one: forget it here too. */
  unlinkedBy: (deviceId: string) => Response;
  /** A machine is linked: publish the tailnet door at start even with Phones off. */
  hasLinks: () => boolean;
  /** The linked machine a door device belongs to, or null. */
  machineOfDevice?: (deviceId: string) => { machine: string; name: string } | null;
  /** Linking through a third (inbox-link-through.ts): one of its three door routes, with the machine's window mark. */
  linkThroughDoor?: (route: string, deviceId: string, window: boolean, body: Record<string, unknown>) => Promise<Response>;
}

/** The platform a linked Inbox pairs as. */
export const MACHINE_PLATFORM = "machine";
/** A paired cloud agent's device (section 13 of the contract): minted by this computer, served by the agent door only. */
export const AGENT_PLATFORM = "agent";
/** Machine offers kept, open or redeemed (a CLI offer and a link-back can be open at once). */
const MACHINE_OFFERS_KEPT = 8;
/**
 * Introductions' offers open per computer introducing them, in their own list: however many a linked computer asks
 * for, the person's own link codes and an ordinary link's way back keep their slots. A newer one replaces its oldest.
 */
const INTRODUCTION_OFFERS_PER_BROKER = 2;
/**
 * An introduction's link code (inbox-link-through.ts) lives this long by this computer's clock: the computer it is for
 * redeems it the moment the broker hands it over, so this is its freshness, whatever the other clocks say.
 */
export const INTRODUCTION_OFFER_MS = 2 * 60_000;
/**
 * A device an introduction's code made is provisional this long: revoked unless the link-back of the computer it was
 * made for saved its link first. The ordinary link's own steps take at most a minute (its health read, 15 s, then its
 * link-back, 30 s, inside which this computer pairs back and reads health, 15 s each), so twice that leaves room for a
 * slow line and none for a pass nobody uses.
 */
export const INTRODUCED_DEVICE_MS = 2 * 60_000;
/** The door routes a provisional device reaches: the ordinary link's health read, the link-back that completes it, and its own unlink. */
const INTRODUCED_ROUTES = new Set(["GET health", "POST link-back", "POST unlink"]);

/**
 * The computer's name as a phone and a linked machine show it: PLANNOTATOR_MACHINE_NAME when set (a headless box
 * whose host name says nothing, two Inboxes on one computer in a test), else macOS's ComputerName, else the host
 * name's first label.
 */
function computerName(): string {
  // Control characters stripped: the name is echoed by another machine's CLI and must never carry a terminal escape.
  const named = process.env.PLANNOTATOR_MACHINE_NAME?.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (named) return named.slice(0, 64);
  if (process.platform === "darwin") {
    try {
      // windows-hide-guard: macOS only (scutil).
      const out = spawnSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000, env: childEnv() });
      const name = out.status === 0 ? out.stdout.trim() : "";
      if (name) return name;
    } catch {
      // Fall through.
    }
  }
  return hostname().split(".")[0] || "Computer";
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** How much of a file the door reads and drops after a replay or a refusal before it closes the connection instead. */
export const DOOR_DRAIN_MAX_BYTES = 1024 * 1024;
export const DOOR_DRAIN_MAX_MS = 2_000;

/**
 * A raw body (a file) on its way to the window, counted. The window reads
 * `stream`; past `max` bytes the stream errors and the client's body is
 * cancelled, so nothing past the bound is read or buffered, whatever the
 * Content-Length said (a chunked body declares none). The window's handler
 * is called in-process, so Bun's request size bound does not apply to it.
 *
 * `settle()` after the answer: true when the client's body was read to its
 * end, reading and dropping what is left up to `DOOR_DRAIN_MAX_BYTES` within
 * `DOOR_DRAIN_MAX_MS` (an HTTP/1.1 client still sending waits for its body to
 * be read); false when it stopped short, and the answer then closes the
 * connection.
 */
function meteredBody(body: ReadableStream<Uint8Array>, max: number, tooLarge: () => Error) {
  const reader = body.getReader();
  let seen = 0;
  let done = false;
  let stopped = false;
  let over = false;
  const stop = async () => {
    if (stopped || done) return;
    stopped = true;
    await reader.cancel().catch(() => {});
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          done = true;
          controller.close();
          return;
        }
        seen += next.value.byteLength;
        if (seen > max) {
          over = true;
          await stop();
          controller.error(tooLarge());
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        stopped = true;
        controller.error(error);
      }
    },
    cancel: () => stop(),
  });
  const settle = async (): Promise<boolean> => {
    if (done) return true;
    if (stopped) return false;
    const deadline = Date.now() + DOOR_DRAIN_MAX_MS;
    let dropped = 0;
    while (dropped <= DOOR_DRAIN_MAX_BYTES) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read().catch(() => null),
        new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), left))),
      ]);
      clearTimeout(timer);
      if (next === "late" || next === null) break;
      if (next.done) {
        done = true;
        return true;
      }
      dropped += next.value.byteLength;
    }
    await stop();
    return false;
  };
  return { stream, over: () => over, settle };
}

/** The same answer, closing the connection after it (a request body left unread past the drain bound). */
function withClose(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Connection", "close");
  return new Response(response.body, { status: response.status, headers });
}

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  return match ? match[1]! : null;
}

/**
 * Take down the door mapping this Inbox recorded (inbox-tailnet-door.ts),
 * only while it still points exactly where the record says: anything else on
 * that port is someone else's and is never touched. With no record yet, an
 * older build's inbox.json `tailnet` is read as one, once
 * (`adoptLegacyTailnetDoor`). The record keeps the port and says the mapping
 * is gone once it is down or found gone; it is unchanged when Tailscale could
 * not say or could not remove it, or is not running ("later"). Nothing is spawned when there is nothing
 * recorded. Also `uninstall --purge`, with the Inbox stopped (`legacy`: that
 * data dir's inbox.json `tailnet`).
 */
export function takeDownInboxTailnet(
  dataDir: string,
  run: TailscaleRunner = runTailscale,
  legacy: InboxRegistryEntry["tailnet"] = readInboxRegistry(dataDir)?.tailnet,
): TakeDownAnswer {
  let record = readTailnetDoorRecord(dataDir);
  if (!record && !hasTailnetDoorRecord(dataDir)) {
    if (!legacy?.door_port) return "none";
    const status = run(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
    if (status.error || status.status !== 0) return "failed";
    record = adoptLegacyTailnetDoor(dataDir, legacy, status.stdout);
  }
  if (!record?.published) return "none";
  const result = takeDownOwnServeMapping(run, record.https_port, [record.target]);
  if (result === "removed" || result === "none") writeTailnetDoorRecord(dataDir, { ...record, published: false });
  return result;
}

/** Why the door's port could not be taken (inbox-tailnet-door.ts), in the window's words. */
class DoorPortError extends Error {
  constructor(
    readonly code: "tailnet_port_taken" | "tailnet_port_held" | "tailnet_port_raced",
    message: string,
  ) {
    super(message);
  }
}

export function createInboxDevices(context: InboxDevicesContext) {
  const now = () => (context.now ? context.now() : new Date());
  const runTailscaleAtOnce = context.tailscale ?? runTailscale;
  // The door's publish still waits on the CLI (Pair a phone, Link a machine): named for the loop watch.
  const tailscale: TailscaleRunner = (args, timeoutMs) => syncSection(`tailscale:${args.slice(0, 2).join(" ")}`, () => runTailscaleAtOnce(args, timeoutMs));
  const devices = InboxDevices.open(context.dataDir);
  const commandLog = new JsonLines<CommandLine>(join(inboxDir(context.dataDir), INBOX_DEVICE_COMMANDS_FILE));
  const commands = new Map<string, CommandLine>();
  for (const line of commandLog.read()) {
    if (line.v === 1 && typeof line.device_id === "string" && typeof line.key === "string") commands.set(`${line.device_id}\n${line.key}`, line);
  }
  const inFlight = new Map<string, Promise<unknown>>();
  /** Each device's open event streams, closed when it is removed. */
  const streams = new Map<string, Set<AbortController>>();
  /** The app each device last named (`X-Plannotator-App`), in memory only: the devices list's `app`. */
  const apps = new Map<string, DoorDeviceApp>();
  let offer: Offer | null = null;
  /** The last offer made, kept after it closes so the window can say what reached the door while it showed. */
  let lastOffer: Offer | null = null;
  const phonesOn = context.phones !== false;
  /** Machine offers (inbox-machines.ts), newest last, with the device each was redeemed for. */
  const machineOffers: (Offer & { deviceId: string | null; for?: string; by?: string })[] = [];
  /**
   * Introductions' offers (inbox-link-through.ts), newest last, apart from `machineOffers`: each carries the computer it
   * is for and the one that introduced it (`for`, `by`), and no six digits (`code` empty).
   */
  let introOffers: (typeof machineOffers)[number][] = [];
  // A provisional device outlives no restart: the link-back that would complete it ended with the last run.
  for (const device of devices.list()) if (device.introduced) devices.revoke(device.id, now().toISOString());
  let name: string | null = null;
  const tailnet: TailnetState = { on: false, address: null, error: null };

  const computer = () => ({ name: (name ??= computerName()) });
  const addresses = () => {
    const wifi = lan.state();
    return { tailnet: tailnet.address, lan: wifi.address, fingerprint: wifi.address ? wifi.fingerprint : null };
  };

  const openOffer = (): Offer | null => {
    if (offer && offer.expiresAt <= now().getTime()) offer = null;
    return offer;
  };

  const revoke = (device: InboxDevice): InboxDevice => {
    const revoked = devices.revoke(device.id, now().toISOString()) ?? device;
    apps.delete(device.id);
    for (const stream of streams.get(device.id) ?? []) stream.abort();
    streams.delete(device.id);
    if (device.platform !== MACHINE_PLATFORM) context.relay?.revoked(revoked);
    return revoked;
  };

  // ── Pairing (contract section 1) ──

  const makeOffer = () => {
    const secret = randomBytes(32).toString("base64url");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = now().getTime() + PAIRING_OFFER_MS;
    offer = { secret, code, expiresAt, wrong: 0, redeemed: false, attempts: [] };
    lastOffer = offer;
    const reach = addresses();
    const params = [`v=1`, `name=${encodeURIComponent(computer().name)}`];
    if (reach.tailnet) params.push(`tailnet=${encodeURIComponent(reach.tailnet)}`);
    if (reach.lan && reach.fingerprint) params.push(`lan=${encodeURIComponent(reach.lan)}`, `fp=${reach.fingerprint}`);
    params.push(`secret=${secret}`, `code=${code}`);
    return {
      offer: { code, expires_at: new Date(expiresAt).toISOString() },
      link: `plannotator://pair?${params.join("&")}`,
      computer: computer(),
      addresses: reach,
      // A phone can use the code only through an address it carries; the window never shows a code without one.
      reachable: reach.tailnet !== null || (reach.lan !== null && reach.fingerprint !== null),
    };
  };

  /** A one-time offer another Inbox redeems as a machine (Phones on or off). */
  const openMachineOffer = () => {
    const made = {
      secret: randomBytes(32).toString("base64url"),
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      expiresAt: now().getTime() + PAIRING_OFFER_MS,
      wrong: 0,
      redeemed: false,
      attempts: [],
      deviceId: null,
    };
    keepMachineOffer(made);
    return { secret: made.secret, code: made.code, expires_at: new Date(made.expiresAt).toISOString() };
  };
  const keepMachineOffer = (made: (typeof machineOffers)[number]) => {
    machineOffers.push(made);
    if (machineOffers.length > MACHINE_OFFERS_KEPT) machineOffers.splice(0, machineOffers.length - MACHINE_OFFERS_KEPT);
  };
  /**
   * An introduction's offer (inbox-link-through.ts): its secret only, no six digits, for one computer (`forId`), from
   * the computer that introduced it (`by`). The device it makes is provisional (`INTRODUCED_DEVICE_MS`).
   */
  const openIntroductionOffer = (forId: string, by: string) => {
    const made = {
      secret: randomBytes(32).toString("base64url"),
      code: "",
      expiresAt: now().getTime() + INTRODUCTION_OFFER_MS,
      wrong: 0,
      redeemed: false,
      attempts: [],
      deviceId: null,
      for: forId,
      by,
    };
    // Its own list: a closed one goes, and `by` keeps at most INTRODUCTION_OFFERS_PER_BROKER open, its oldest replaced.
    introOffers = introOffers.filter(isOpen);
    const mine = introOffers.filter((o) => o.by === by);
    const replaced = new Set(mine.slice(0, Math.max(mine.length - INTRODUCTION_OFFERS_PER_BROKER + 1, 0)));
    introOffers = [...introOffers.filter((o) => !replaced.has(o)), made];
    return { secret: made.secret, expires_at: new Date(made.expiresAt).toISOString() };
  };
  const isOpen = (o: Offer) => !o.redeemed && o.wrong < PAIRING_CODE_TRIES && o.expiresAt > now().getTime();
  const openMachineOffers = () => [...machineOffers, ...introOffers].filter(isOpen);
  const offerDevice = (secret: string) => machineOffers.find((o) => sameSecret(o.secret, secret))?.deviceId ?? null;

  /** A provisional device still unsettled when its time is up is revoked. */
  const expireIntroduced = (id: string) => {
    const device = devices.get(id);
    if (device?.introduced && device.revoked_at === null) revoke(device);
  };

  /** A machine redeems a machine offer: the same limits as a phone's (10 minutes, 5 wrong codes), its own slots. */
  const redeemMachine = (name: string, secret: string | null, code: string | null): Response => {
    // Six digits never reach an introduction's offer: it has none.
    const open = openMachineOffers().filter((o) => secret !== null || o.code !== "");
    const match = open.find((o) => (secret ? sameSecret(secret, o.secret) : code === o.code));
    if (!match) {
      if (!secret) for (const o of open) o.wrong += 1;
      if (secret || open.length === 0) return refuse(410, "offer_expired", "This link code is no longer open. Make a new one on the other machine.");
      return refuse(401, "pairing_code_wrong", "That code is not the one on the other machine.", {
        tries_left: Math.max(PAIRING_CODE_TRIES - Math.max(...open.map((o) => o.wrong)), 0),
      });
    }
    match.redeemed = true;
    const token = `tok_${randomBytes(32).toString("base64url")}`;
    const at = now().toISOString();
    const introduced = match.for && match.by ? { for: match.for, by: match.by, until: new Date(now().getTime() + INTRODUCED_DEVICE_MS).toISOString() } : undefined;
    const device = devices.add({ id: inboxId("dev"), name, platform: MACHINE_PLATFORM, token, secret: match.secret, at, ...(introduced ? { introduced } : {}) });
    // A machine is never a phone: no relay carriage, no pushes.
    devices.setCarriage(device.id, false, at);
    match.deviceId = device.id;
    if (introduced) {
      const timer = setTimeout(() => expireIntroduced(device.id), INTRODUCED_DEVICE_MS + 50);
      (timer as { unref?: () => void }).unref?.();
    }
    return json({ device: publicDevice(devices.get(device.id) ?? device), token, computer: computer() }, 201);
  };

  const attempt = (target: Offer | null, entry: Omit<PairingAttempt, "at">) => {
    if (!target) return;
    target.attempts.push({ ...entry, at: now().toISOString() });
    if (target.attempts.length > PAIRING_ATTEMPTS_KEPT) target.attempts.splice(0, target.attempts.length - PAIRING_ATTEMPTS_KEPT);
  };

  /** The last offer as the window reads it: never its secret or its code. */
  const offerView = () => {
    if (!lastOffer) return null;
    const state = lastOffer.redeemed
      ? "redeemed"
      : lastOffer.wrong >= PAIRING_CODE_TRIES
        ? "closed"
        : lastOffer.expiresAt <= now().getTime()
          ? "expired"
          : offer === lastOffer
            ? "open"
            : "closed";
    return {
      expires_at: new Date(lastOffer.expiresAt).toISOString(),
      state,
      tries_left: Math.max(PAIRING_CODE_TRIES - lastOffer.wrong, 0),
      attempts: lastOffer.attempts,
    };
  };

  /**
   * `secretOnly`: the LAN listener. Over the Wi-Fi the phone pins the
   * certificate whose fingerprint the QR carried from this computer's screen;
   * a fingerprint learned from the network (a Bonjour record anyone on the
   * Wi-Fi can publish) would let a listener in the middle relay the person's
   * own six digits. So the LAN takes the QR secret only (contract section 3).
   */
  const redeem = async (req: Request, via: PairingVia): Promise<Response> => {
    const secretOnly = via === "wifi";
    const body = await context.readBody(req);
    const byName = checkInboxThreadName(body.name);
    if (!byName.ok) throw new InboxError("validation_error", `name: ${byName.message}`, { field: "name" });
    const platform = checkInboxThreadName(body.platform);
    if (!platform.ok) throw new InboxError("validation_error", `platform: ${platform.message}`, { field: "platform" });
    const secret = typeof body.secret === "string" && body.secret ? body.secret : null;
    const code = typeof body.code === "string" && body.code ? body.code : null;
    if (platform.name === MACHINE_PLATFORM) {
      // Machines link over the tailnet only: never by a code, or at all, over the Wi-Fi.
      if (via === "wifi") return refuse(403, "machine_not_accepted_here", "Machines link over the tailnet, not the Wi-Fi.");
      if (!secret && !code) throw new InboxError("validation_error", "secret or code: one is required.", { field: "secret" });
      return redeemMachine(byName.name, secret, code);
    }
    if (secretOnly && !secret && code) {
      attempt(openOffer() ?? lastOffer, { via, result: "code_over_wifi" });
      return refuse(400, "code_not_accepted_here", "Over the Wi-Fi, pair by scanning the QR code on your computer's screen.");
    }
    if (!secret && !code) throw new InboxError("validation_error", "secret or code: one is required.", { field: "secret" });
    const open = openOffer();
    const expired = () => refuse(410, "offer_expired", "This pairing code is no longer open. Make a new one on your computer.");
    if (!open) {
      attempt(lastOffer, { via, result: "expired" });
      return expired();
    }
    if (secret ? !sameSecret(secret, open.secret) : code !== open.code) {
      if (secret) {
        attempt(open, { via, result: "old_code" });
        return expired();
      }
      open.wrong += 1;
      const triesLeft = Math.max(PAIRING_CODE_TRIES - open.wrong, 0);
      attempt(open, { via, result: "wrong_code", tries_left: triesLeft });
      if (triesLeft === 0) offer = null;
      return refuse(401, "pairing_code_wrong", "That code is not the one on your computer.", { tries_left: triesLeft });
    }
    offer = null;
    open.redeemed = true;
    attempt(open, { via, result: "redeemed", device: byName.name });
    const token = `tok_${randomBytes(32).toString("base64url")}`;
    const device = devices.add({ id: inboxId("dev"), name: byName.name, platform: platform.name, token, secret: open.secret, at: now().toISOString() });
    // The relay (section 4): the mailbox, made at the first pairing, and this phone registered there; null when it cannot be reached.
    const relay = (await context.relay?.paired(device)) ?? null;
    return json({ device: publicDevice(device), token, secret: open.secret, computer: computer(), addresses: addresses(), relay }, 201);
  };

  // ── The door (contract section 2) ──

  /** Hand one allowed request to the window's handler, on loopback, as the window would send it. */
  const toWindow = (
    req: Request,
    device: InboxDevice,
    windowPath: string,
    search: string,
    body: string | ReadableStream<Uint8Array> | null,
    signal: AbortSignal,
    raw = false,
  ): Promise<Response> => {
    const headers = new Headers({ Accept: "application/json" });
    if (raw) {
      // A file's bytes (an upload, a drawing): its type and length as the phone sent them, so the window's own 413 check runs first.
      headers.set("Content-Type", req.headers.get("content-type") ?? "application/octet-stream");
      const length = req.headers.get("content-length");
      if (length) headers.set("Content-Length", length);
    } else if (body !== null) headers.set("Content-Type", "application/json");
    const lastEventId = req.headers.get("last-event-id");
    if (lastEventId) headers.set("Last-Event-ID", lastEventId);
    // Of the phone's own headers the door forwards exactly three, and the
    // window's answer comes back unchanged: If-None-Match, the image routes'
    // validator (attachments/<id>/image, messages/<id>/image: a phone that
    // cached the bytes revalidates and gets the window's 304); and a GET's
    // Range and If-Range, a player's byte range (the `video` and `download`
    // routes answer 206 with Content-Range, Accept-Ranges and ETag).
    const ifNoneMatch = req.headers.get("if-none-match");
    if (ifNoneMatch) headers.set("If-None-Match", ifNoneMatch);
    if (req.method === "GET") {
      const range = req.headers.get("range");
      if (range) headers.set("Range", range);
      const ifRange = req.headers.get("if-range");
      if (ifRange) headers.set("If-Range", ifRange);
    }
    const from: InboxDoorCaller = {
      device_id: device.id,
      name: device.name,
      platform: device.platform,
      window: device.platform === MACHINE_PLATFORM && req.headers.get(MACHINE_WINDOW_HEADER) === "1",
      place: device.platform === MACHINE_PLATFORM ? inboxSentFromPlaceOf(req.headers.get(INBOX_SENT_FROM_HEADER)) : null,
    };
    return context.dispatch(new Request(`http://127.0.0.1:${context.port()}${windowPath}${search}`, { method: req.method, headers, body, signal }), from);
  };

  /** A POST through the door: answered once per device and key, then replayed. */
  /** A POST through the door: answered once per device and key, then replayed. */
  const command = async (req: Request, device: InboxDevice, url: URL, windowPath: string, entry: DoorRoute): Promise<Response> => {
    const doorPath = url.pathname;
    const raw = entry.raw ?? null;
    // A raw body (a file): the key in the query, which rides on whole; the body streams through, counted.
    // JSON: the key in the body, no query.
    if (raw) {
      const tooLarge = () =>
        refuse(413, raw.code, `Not accepted: ${raw.what} is at most ${Math.round(raw.max / (1024 * 1024))} MB.`, { max_bytes: raw.max });
      const declared = Number(req.headers.get("content-length") ?? "");
      // Declared past the bound: refused before a byte is read, and the connection closes rather than read the rest.
      if (Number.isFinite(declared) && declared > raw.max) {
        await req.body?.cancel().catch(() => {});
        return withClose(tooLarge());
      }
      const metered = req.body ? meteredBody(req.body, raw.max, () => new InboxError(raw.code, `${raw.what} is too large.`)) : null;
      /** Every raw answer: what is left of the file read and dropped (bounded), else the connection closes. */
      const finish = async (response: Response) => ((await metered?.settle()) === false ? withClose(response) : response);
      const missing = rawCommandKeyRefusal(url.searchParams);
      if (missing) return finish(missing);
      const key = url.searchParams.get("idempotency_key")!;
      return claim(req, device, doorPath, key, entry.carries, finish, async () => {
        const response = await toWindow(req, device, windowPath, url.search, metered?.stream ?? null, req.signal, true);
        const answer = await response.text();
        // Past the bound: the door's own refusal (nothing kept, nothing recorded), whatever the window made of the cut stream.
        if (metered?.over()) return { response: withClose(tooLarge()), record: false };
        return { response: await finish(new Response(answer, { status: response.status, headers: response.headers })), answer, status: response.status, record: true };
      });
    }
    let text: string;
    let body: unknown;
    try {
      text = await req.text();
      body = JSON.parse(text);
    } catch {
      throw new InboxError("validation_error", "body: expected a JSON object.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new InboxError("validation_error", "body: expected a JSON object.");
    const fields = body as Record<string, unknown>;
    const key = fields.idempotency_key;
    if (typeof key !== "string" || !key.trim()) {
      throw new InboxError("validation_error", "idempotency_key: required on a phone's command.", { field: "idempotency_key" });
    }
    for (const refused of entry.refuse ?? []) {
      if (fields[refused.field] !== undefined) throw new InboxError("validation_error", refused.message, { field: refused.field });
    }
    const outside = entry.only ? Object.keys(fields).find((field) => field !== "idempotency_key" && field !== entry.note && !entry.only!.includes(field)) : undefined;
    if (outside !== undefined) throw new InboxError("validation_error", `${outside}: not taken here; only ${entry.only!.join(", ")}.`, { field: outside });
    const missing = entry.requires?.find((field) => !(field in fields));
    if (missing !== undefined) throw new InboxError("validation_error", `${missing}: required here.`, { field: missing });
    // The caller's note goes no further than here: the window route gets the write alone.
    const note = entry.note && fields[entry.note] !== undefined ? fields[entry.note] : undefined;
    if (entry.note && note !== undefined) {
      const { [entry.note]: _note, ...rest } = fields;
      text = JSON.stringify(rest);
    }
    return claim(req, device, doorPath, key, entry.carries, async (response) => response, async () => {
      const response = await toWindow(req, device, windowPath, device.platform === MACHINE_PLATFORM ? (entry.fromMachine ?? "") : "", text, req.signal);
      if (note !== undefined && response.ok) context.noted?.(device, note, JSON.parse(text) as Record<string, unknown>);
      // A route that takes only some fields answers only those: the settings route's answer says every setting.
      const answer = entry.only && response.ok ? JSON.stringify(onlyFields(await response.json().catch(() => ({})), entry.only)) : await response.text();
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return { response: new Response(answer, { status: response.status, headers }), answer, status: response.status, record: true };
    });
  };

  /**
   * One command under its key: a replay answers the recorded status and body
   * (`finish` settles a raw body first); otherwise `apply` runs once, and an
   * answer under 500 is recorded. Replays match on method and door path, never
   * on the query or the body. A route that carries draft text (`carries`) is
   * never recorded, on disk or in memory, whatever it answered.
   */
  const claim = async (
    req: Request,
    device: InboxDevice,
    doorPath: string,
    key: string,
    carries: DoorRoute["carries"],
    finish: (response: Response) => Promise<Response>,
    apply: () => Promise<{ response: Response; answer?: string; status?: number; record: boolean }>,
  ): Promise<Response> => {
    const slot = `${device.id}\n${key}`;
    // Wait while the same command runs; no await when none does, so the check and the claim below happen in one turn.
    while (inFlight.has(slot)) await inFlight.get(slot);
    const seen = commands.get(slot);
    if (seen) {
      if (seen.method !== req.method || seen.path !== doorPath) {
        return finish(refuse(409, "idempotency_key_reused", "This idempotency_key was already used on another route.", { field: "idempotency_key" }));
      }
      // A replayed file is not kept: the answer names the upload or drawing the first one made.
      return finish(json(seen.body, seen.status, { "Idempotent-Replayed": "true" }));
    }
    // A "now" write the app queued (section 4, "not_after"), by the door or the relay: a key already answered replays
    // its answer above, whatever the time; a first arrival past its time is refused, never applied, and not kept.
    const late = commandTimeRefusal(req.headers.get(NOT_AFTER_HEADER) ?? undefined, now().getTime());
    if (late) return finish(json(late.body, late.status));
    const run = (async () => {
      const result = await apply();
      if (carries !== "draft" && result.record && result.status !== undefined && result.status < 500) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(result.answer ?? "");
        } catch {
          parsed = result.answer ?? null;
        }
        const line: CommandLine = { v: 1, at: now().toISOString(), device_id: device.id, key, method: req.method, path: doorPath, status: result.status, body: parsed };
        commandLog.append(line);
        commands.set(slot, line);
      }
      return result.response;
    })();
    inFlight.set(slot, run.catch(() => {}));
    try {
      return await run;
    } finally {
      inFlight.delete(slot);
    }
  };

  const caught = (error: unknown): Response => {
    if (error instanceof InboxError) return json({ error: error.message, code: error.code, ...error.details }, error.code === "validation_error" ? 422 : 400);
    const full = inboxDiskFullError(error);
    if (full) return json({ error: full.message, code: full.code }, 507);
    return refuse(500, "internal_error", "Internal error.");
  };

  /** Whether this Inbox answers an own route that needs something: linked machines, or Update from another machine. */
  const hasOwn = (needs: DoorOwnNeeds): boolean => (needs === "machines" ? (context.machines?.() ?? null) !== null : context.machineUpdate !== undefined);

  /** A far tag's write from a linked machine (inbox-far-tags.ts): the machine its token belongs to, and its answer or refusal. */
  const farTagWrite = async (device: InboxDevice, body: () => Promise<Record<string, unknown>>, run: (machine: string, body: Record<string, unknown>) => unknown): Promise<Response> => {
    const machine = context.machines?.()?.machineOfDevice?.(device.id)?.machine ?? null;
    if (!machine) return routeNotFound(device);
    try {
      return json(await run(machine, await body()));
    } catch (error) {
      if (error instanceof InboxError && (error.code === "message_not_found" || error.code === "thread_not_found")) return json({ error: error.message, code: error.code }, 404);
      if (error instanceof InboxError && error.code === "not_your_session") return json({ error: error.message, code: error.code }, 403);
      return caught(error);
    }
  };

  /** Linking through a third (inbox-link-through.ts): answered by inbox-machines.ts, an older wiring's unknown route. */
  const linkThroughOwn = async (req: Request, device: InboxDevice, route: string): Promise<Response> => {
    const door = context.machines?.()?.linkThroughDoor;
    if (!door) return routeNotFound(device);
    return await door(route, device.id, req.headers.get(MACHINE_WINDOW_HEADER) === "1", await context.readBody(req));
  };

  /** A linked machine's own routes (`DOOR_OWN_ROUTES`), each answered only when `hasOwn` says so. */
  const machineOwn: Record<MachineOwnName, (req: Request, url: URL, device: InboxDevice) => Promise<Response>> = {
    // Only this Inbox's own read, so it never passes on a third machine's. Of the query, only Refresh's `fresh`.
    "GET accounts": (req, url, device) => toWindow(req, device, "/api/inbox/accounts", url.searchParams.get("fresh") === "1" ? "?fresh=1" : "", null, req.signal),
    // read_thread's read of one of this Inbox's threads, and a file it lists: reads only, as a guest's.
    "GET agent-read": async (_req, url, device) => context.agentRead?.read(url, device) ?? routeNotFound(device),
    "GET agent-file": async (_req, url, device) => (context.agentRead ? await context.agentRead.file(url) : routeNotFound(device)),
    // Its agent's search and thread list here: reads only, as a guest's.
    "GET agent-search": async (_req, url, device) => (context.agentFind ? await context.agentFind.search(url) : routeNotFound(device)),
    "GET agent-threads": async (_req, url, device) => (context.agentFind ? await context.agentFind.threads(url) : routeNotFound(device)),
    // Tag an agent on another computer (inbox-far-tags.ts): who the machine asking is comes from its token only.
    "GET taggable-agents": async (_req, _url, device) => (context.farTags ? context.farTags.agents() : routeNotFound(device)),
    "POST far-wake": async (req, _url, device) => (context.farTags ? await farTagWrite(device, () => context.readBody(req), context.farTags.wake) : routeNotFound(device)),
    "POST agent-reply": async (req, _url, device) => (context.farTags ? await farTagWrite(device, () => context.readBody(req), context.farTags.reply) : routeNotFound(device)),
    "POST far-delivered": async (req, _url, device) => (context.farTags ? await farTagWrite(device, () => context.readBody(req), context.farTags.delivered) : routeNotFound(device)),
    "POST link-back": async (req, _url, device) => context.machines?.()?.linkBack(device.id, await context.readBody(req)) ?? routeNotFound(device),
    "POST unlink": async (_req, _url, device) => context.machines?.()?.unlinkedBy(device.id) ?? routeNotFound(device),
    // Who asks is its token's linked computer only; a press in its window, its `X-Plannotator-Window` (a machine's word).
    "POST link-through-ask": (req, _url, device) => linkThroughOwn(req, device, "link-through-ask"),
    "POST link-through-offer": (req, _url, device) => linkThroughOwn(req, device, "link-through-offer"),
    "POST link-through-introduce": (req, _url, device) => linkThroughOwn(req, device, "link-through-introduce"),
    // The body is never read, so a machine cannot name a version or a place to download from.
    "GET update": async (_req, _url, device) => (context.machineUpdate ? json(context.machineUpdate.read()) : routeNotFound(device)),
    "POST update": async (_req, _url, device) => (context.machineUpdate ? json(await context.machineUpdate.start()) : routeNotFound(device)),
  };

  /** `health.door` for a caller's platform, as this Inbox answers now. */
  const doorReach = (platform: string) => doorReachOf(platform, hasOwn);

  /** One request from a known, live device: its own revoke, or an allowlisted route handed to the window. */
  const serve = async (req: Request, url: URL, route: string, device: InboxDevice): Promise<Response> => {
    const at = now().toISOString();
    devices.touch(device.id, at);
    // The app names itself (section 14); the header is never handed to the window. Below the floor: 426, but it
    // still reads `health` (where it learns the floor) and can remove itself.
    const app = parseAppHeader(req.headers.get(APP_HEADER));
    if (app) apps.set(device.id, { app_version: app.app_version, contract: app.contract, seen_at: at });
    const belowFloor = appBelowFloor(app, route);
    if (belowFloor) return json(belowFloor, 426, { Upgrade: APP_UPGRADE });
    if (route === "revoke" && req.method === "POST") return json({ device: publicDevice(revoke(device)) });
    if (device.platform === MACHINE_PLATFORM) {
      // A machine reads this Inbox's own threads only (PLAN rule 3): never the merged view, so links both ways cannot echo.
      if (url.searchParams.has("machines")) return refuse(403, "machines_view_refused", "A linked machine reads this Inbox's own threads only.");
      const name = `${req.method} ${route}`;
      // An introduction's device is provisional: past its time it is revoked; until then it reaches only what completes its link.
      if (device.introduced) {
        if (Date.parse(device.introduced.until) <= now().getTime()) {
          revoke(device);
          return refuse(401, "device_revoked", "This phone was removed from the Inbox. Pair it again.");
        }
        if (!INTRODUCED_ROUTES.has(name)) return refuse(403, "introduction_pending", "This link is not complete yet.");
      }
      const own = DOOR_OWN_ROUTES.find((row) => row.grant === "machine" && `${row.method} ${row.route}` === name);
      if (own && (!("needs" in own) || hasOwn(own.needs))) return await machineOwn[name as MachineOwnName](req, url, device);
    }
    const door = doorRouteOf(req.method, route, device.platform === MACHINE_PLATFORM);
    if (door) {
      const { entry, windowPath } = door;
      if (req.method === "POST") return await command(req, device, url, windowPath, entry);
      if (route !== "events") return await toWindow(req, device, windowPath, url.search, null, req.signal);
      // The event stream lives until the phone leaves or is removed.
      const stream = new AbortController();
      req.signal.addEventListener("abort", () => stream.abort());
      const open = streams.get(device.id) ?? new Set();
      open.add(stream);
      streams.set(device.id, open);
      stream.signal.addEventListener("abort", () => open.delete(stream));
      return await toWindow(req, device, windowPath, url.search, null, stream.signal);
    }
    return routeNotFound(device);
  };

  /**
   * Phones off: whether the door answers this request at all (it is there
   * for linked machines only). A machine's pairing while a machine offer is
   * open, and a machine's token, are answered. So is a token this door does
   * not know, once machines link here (through the tailnet's listener, or
   * when any machine device exists): `401 device_token_invalid` tells a
   * machine whose link was wiped here (a reinstall) to re-pair, and ends the
   * writes it holds with their notice. Anything else gets the unknown-route
   * 404 it always got, Origin header or not.
   */
  const answersWithPhonesOff = (req: Request, route: string, via: PairingVia, token: string | null, device: InboxDevice | null): boolean => {
    if (route === "pair" && req.method === "POST") return openMachineOffers().length > 0;
    if (device) return device.platform === MACHINE_PLATFORM;
    return token !== null && (via === "tailnet" || devices.list().some((d) => d.platform === MACHINE_PLATFORM));
  };

  /** `via`: the listener the request reached (the window's own port when the caller says nothing). */
  /** Null: Phones are off and this is no machine's request (the caller answers its unknown-route 404). */
  const door = async (req: Request, url: URL, via: PairingVia = "local"): Promise<Response | null> => {
    try {
      const route = url.pathname.startsWith(DOOR_PREFIX) ? url.pathname.slice(DOOR_PREFIX.length) : "";
      const token = bearer(req);
      const device = token ? devices.byToken(token) : null;
      if (!phonesOn && !answersWithPhonesOff(req, route, via, token, device)) return null;
      if (req.headers.get("origin") !== null) return refuse(403, "origin_not_allowed", "Browser requests are not accepted here.");
      if (route === "pair" && req.method === "POST") return await redeem(req, via);
      if (!token) return refuse(401, "device_token_missing", "This request needs the phone's token.");
      if (!device) return refuse(401, "device_token_invalid", "This token does not belong to a paired phone.");
      if (device.revoked_at !== null) {
        // A machine unlinked while it could not be told has now heard it: the door it kept up may come down.
        if (device.refusal_owed_until !== undefined) refusalAnswered(device.id);
        return refuse(401, "device_revoked", "This phone was removed from the Inbox. Pair it again.");
      }
      if (device.platform === AGENT_PLATFORM) return refuse(403, "agent_not_accepted_here", "A cloud agent's pairing opens the agent door only.");
      // A machine reaches this door over the tailnet only, never the Wi-Fi's listener.
      if (device.platform === MACHINE_PLATFORM && via === "wifi") return refuse(403, "machine_not_accepted_here", "Machines reach this Inbox over the tailnet, not the Wi-Fi.");
      return await serve(req, url, route, device);
    } catch (error) {
      return caught(error);
    }
  };

  /**
   * A command that came up through the relay (contract section 4), applied
   * in-process as the device whose key opened it: the same revocation check,
   * allowlist and idempotency log as a request at the door, so a command the
   * relay replays writes nothing again. Four door routes are not carried:
   * `pair` (pairing through the relay is not in v1), `events` (the down
   * items are the relay's stream; an endless answer cannot be one result),
   * and the raw-body `uploads` and `markups` (`413 relay_upload_unavailable`).
   * A sealed command carries no headers in v1, so no Range reaches the
   * window from here: `attachments/:id/video` and `download` answer the whole
   * file (`200`), which the relay carries when it fits one frame and answers
   * `413 result_too_large` otherwise, without reading it (inbox-relay.ts).
   * A phone plays a video over the Wi-Fi or the tailnet; relay ranges are v1.1.
   */
  const asDevice = async (deviceId: string, input: { method: string; path: string; body?: unknown; app?: unknown; not_after?: unknown }): Promise<Response> => {
    try {
      const device = devices.get(deviceId);
      if (!device) return refuse(401, "device_token_invalid", "This token does not belong to a paired phone.");
      if (device.revoked_at !== null) return refuse(401, "device_revoked", "This phone was removed from the Inbox. Pair it again.");
      if (device.platform === AGENT_PLATFORM) return refuse(403, "agent_not_accepted_here", "A cloud agent's pairing opens the agent door only.");
      if (input.method !== "GET" && input.method !== "POST") return routeNotFound(device);
      let url: URL;
      try {
        url = new URL(input.path, `http://127.0.0.1:${context.port()}`);
      } catch {
        return routeNotFound(device);
      }
      const route = url.pathname.startsWith(DOOR_PREFIX) ? url.pathname.slice(DOOR_PREFIX.length) : "";
      if (!route || NOT_BY_RELAY.has(route) || url.origin !== `http://127.0.0.1:${context.port()}`) {
        return routeNotFound(device);
      }
      // A file (an upload, a drawing) is not carried: a sealed command's body is JSON, and a file in it would be
      // base64 inside the envelope, past Cloudflare's message limit well under the 100 MB cap. v1: the Wi-Fi or the tailnet.
      if (input.method === "POST" && ALLOWLIST.some((entry) => entry.raw && entry.method === "POST" && entry.route.test(route))) {
        return refuse(413, "relay_upload_unavailable", "Files and drawings are sent over the Wi-Fi or the tailnet, not the relay.");
      }
      const headers: Record<string, string> = input.method === "POST" ? { "Content-Type": "application/json" } : {};
      // A sealed command names its app as `app` beside `v`, in the header's words: the same floor applies. Read first,
      // so a value that is not in the form (or not a header's characters) is served as if absent, never a 500.
      const app = parseAppHeader(typeof input.app === "string" ? input.app : null);
      if (app) headers[APP_HEADER] = formatInboxAppHeader(app);
      // `not_after` beside `v`, as the header a direct write sends: one check, in `claim`, for both paths. A value
      // that is not a string is carried as one, so it is refused as no time (400), never dropped.
      if (input.not_after !== undefined && input.not_after !== null) headers[NOT_AFTER_HEADER] = typeof input.not_after === "string" ? input.not_after.replace(/[^\x20-\x7e]/g, "?") : "invalid";
      const req = new Request(url, {
        method: input.method,
        headers,
        body: input.method === "POST" ? JSON.stringify(input.body ?? {}) : undefined,
      });
      return await serve(req, url, route, device);
    } catch (error) {
      return caught(error);
    }
  };

  // ── The tailnet (contract sections 1 and 2) ──
  //
  // `tailscale serve` passes the client's own Host header through, so a Host
  // check cannot tell a tailnet peer from this machine. While the switch is
  // on, the Inbox runs a second loopback listener that serves the door and
  // nothing else, and the tailnet mapping points at it, never at the window's
  // port: the socket keeps tailnet requests on the door.

  let doorServer: ReturnType<typeof Bun.serve> | null = null;

  /** A listener that serves the door and nothing else: the tailnet's, and (QR pairing only) the Wi-Fi's. */
  const doorOnly =
    (via: PairingVia) =>
    (req: Request): Promise<Response> | Response => {
      let url: URL;
      try {
        url = new URL(req.url, "http://127.0.0.1");
      } catch {
        return routeNotFound();
      }
      if (url.pathname !== "/api/inbox/device" && !url.pathname.startsWith(DOOR_PREFIX)) return routeNotFound();
      return door(req, url, via).then((answer) => answer ?? routeNotFound());
    };

  // ── The Wi-Fi (contract section 3): the same door-only handler, over TLS on every interface. ──

  /** Keep "Reach from this Wi-Fi" in inbox.json (and this run's entry): `lan: { port, on }`, the port kept while off. */
  const saveLan = (value: { port: number; on: boolean }) => {
    const apply = (target: InboxRegistryEntry) => {
      target.lan = { ...value };
    };
    apply(context.registry());
    // Never another Inbox's entry, never into a removed data folder.
    updateOwnInboxRegistry(context.dataDir, context.registry().serverSession, apply);
  };
  const lan = createInboxLan({
    dataDir: context.dataDir,
    saved: () => {
      const kept = context.registry().lan;
      return kept ? { port: kept.port, on: kept.on !== false } : null;
    },
    save: saveLan,
    name: () => computer().name,
    fetch: doorOnly("wifi"),
  });

  /** The door listener, on the port it had last time when it is free. */
  const openDoorListener = (): number => {
    if (doorServer) return doorServer.port as number;
    const serve = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: doorOnly("tailnet") } as Parameters<typeof Bun.serve>[0]);
    const last = context.registry().tailnet?.door_port;
    try {
      doorServer = last ? serve(last) : serve(0);
    } catch {
      doorServer = serve(0);
    }
    return doorServer.port as number;
  };

  const closeDoorListener = () => {
    doorServer?.stop(true);
    doorServer = null;
  };

  /** The tailnet HTTPS port the door is published on this run, while it is. */
  let doorHttpsPort: number | null = null;

  /** The record, or (no record yet) what an older build's inbox.json `tailnet` says, never written here: the pairing checks only read. */
  const recordFor = (serveStatus: string): TailnetDoorRecord | null =>
    hasTailnetDoorRecord(context.dataDir) ? readTailnetDoorRecord(context.dataDir) : legacyTailnetDoorRecord(context.registry().tailnet, serveStatus);

  /** The tailnet port the door would take now, from `tailscale serve status --json`: the kept port, else (first publish) the first free one. */
  const doorPortIn = (serveStatus: string) => chooseTailnetDoorPort(serveStatus, recordFor(serveStatus));

  /** The switch: inbox.json's `tailnet`. Off also forgets the door's port, so the next first publish chooses again. */
  /** `owed`: switched off while Tailscale was not running: the record stays, a take-down still owed (`doorOwed`). */
  const saveSwitch = (on: boolean, owed = false) => {
    const value = on && doorServer ? { https_port: doorHttpsPort ?? INBOX_TAILNET_HTTPS_PORT, door_port: doorServer.port as number } : undefined;
    const apply = (target: InboxRegistryEntry) => {
      if (value) target.tailnet = { ...value };
      else delete target.tailnet;
    };
    // Never another Inbox's entry, never into a removed data folder.
    updateOwnInboxRegistry(context.dataDir, context.registry().serverSession, apply);
    apply(context.registry());
    if (!on && !owed) clearTailnetDoorRecord(context.dataDir);
  };

  /** Who reaches the door on its port, for the words of a refusal. */
  const reachers = () => (phonesOn ? "linked machines and paired phones" : "linked machines");

  const tailnetWords = (error: unknown): { code: string; message: string } => {
    if (error instanceof DoorPortError) return { code: error.code, message: error.message };
    const detail = error instanceof Error ? error.message.replace(/^--tailscale:\s*/, "") : String(error);
    // Linux: `tailscale serve` needs root unless the person made their user the operator once.
    const linux =
      process.platform === "linux" && /access denied|permission|operator|not permitted/i.test(detail)
        ? ' On Linux, run "sudo tailscale set --operator=$USER" once, then try again.'
        : "";
    return { code: "tailnet_unavailable", message: `Tailscale could not publish the Inbox. ${detail}${linux}` };
  };

  /**
   * Open the door listener and point a tailnet mapping at it, on its port
   * (inbox-tailnet-door.ts: the kept one, else the first free one). The
   * record is written before `tailscale serve` runs, so a crash between the
   * two never leaves a mapping the Inbox does not own; when serve fails, the
   * record goes back to what it was. On failure the listener closes and the
   * error is kept for the window.
   */
  /** Why a port read from `serve status` cannot be taken, as publish refuses it; null when it is usable. */
  const portRefusal = (port: TailnetDoorPort): Error | null => {
    if (port.state === "malformed") {
      return new TailscaleServeError(
        "malformed",
        "--tailscale: could not parse `tailscale serve status --json` output; refusing to modify the serve config. Inspect it with `tailscale serve status`.",
      );
    }
    if (port.state === "taken") {
      return new DoorPortError(
        "tailnet_port_taken",
        `Other tailscale serve mappings already use every port the Inbox can take (${INBOX_TAILNET_PORT_RANGE}). The Inbox never replaces them: free one of them if nothing needs it ("tailscale serve status" lists them).`,
      );
    }
    if (port.state === "held") {
      // How the port can change on purpose. With Phones off and nothing linked, there is nothing to unlink:
      // the port is let go of once nothing needs the door (closeTailnetIfUnused), and the next code chooses again.
      const move = phonesOn
        ? "To move this Inbox to a new port instead, turn Tailscale off and on again here, then pair your phones and link your machines again."
        : context.machines?.()?.hasLinks()
          ? "To move this Inbox to a new port instead, unlink each machine, then link it again."
          : `Nothing is linked here, so the Inbox lets go of port ${port.port} on its own once no link code is open (a code lasts ${PAIRING_OFFER_MS / 60_000} minutes)${
              owesRefusal() ? `, and the machine unlinked here has heard it was unlinked (at most ${UNLINKED_REFUSAL_KEPT_MS / 86_400_000} days)` : ""
            }; the next code then takes a free port.`;
      return new DoorPortError(
        "tailnet_port_held",
        `Another tailscale serve mapping now uses port ${port.port}, where ${reachers()} reach this Inbox. The Inbox never replaces it, and does not move to another port on its own: free port ${port.port} if nothing needs it ("tailscale serve status" lists it). ${move}`,
      );
    }
    return null;
  };

  /** A publish that did not happen: the listener closes, and the window is told why. */
  const publishFailed = (error: unknown): { ok: false; code: string; message: string } => {
    closeDoorListener();
    const words = tailnetWords(error);
    tailnet.address = null;
    tailnet.error = words.message;
    return { ok: false, ...words };
  };

  /**
   * `dead`: targets found dead just before (`loopbackTargetDead`, read without blocking by the look-again): a mapping
   * this Inbox made that points at one is its own leftover and is re-pointed. Without it, as before.
   */
  const publish = (dead: ReadonlySet<string> = new Set()): { ok: true } | { ok: false; code: string; message: string } => {
    try {
      const status = tailscale(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
      if (status.error || status.status !== 0) throw new TailscaleServeError("unavailable", `--tailscale: ${describeTailscaleFailure(status)}`);
      // An older build's inbox.json record, read once (inbox-tailnet-door.ts).
      const record = adoptLegacyTailnetDoor(context.dataDir, context.registry().tailnet, status.stdout);
      const port = chooseTailnetDoorPort(status.stdout, record, (target) => dead.has(target));
      const refused = portRefusal(port);
      if (refused || port.state !== "usable") throw refused;
      const doorPort = openDoorListener();
      const target = `http://127.0.0.1:${doorPort}`;
      const made = withMadeTargets(record?.made, record?.target, port.own, target);
      writeTailnetDoorRecord(context.dataDir, { https_port: port.port, target, published: true, made });
      let url: string;
      try {
        ({ url } = enableTailscaleServe(doorPort, tailscale, { httpsPort: port.port, ownTargets: port.own ? [port.own] : [], persist: true }));
      } catch (error) {
        if (record) writeTailnetDoorRecord(context.dataDir, { ...record, made });
        else clearTailnetDoorRecord(context.dataDir);
        // Free a moment ago, someone else's now: the race between reading the status and serving.
        if (error instanceof TailscaleServeError && error.code === "conflict") {
          throw new DoorPortError("tailnet_port_raced", `Port ${port.port} was just taken by another tailscale serve mapping. Try again.`);
        }
        throw error;
      }
      doorHttpsPort = port.port;
      const served = new URL(url);
      tailnet.address = `${served.hostname}:${served.port || "443"}`;
      tailnet.error = null;
      hangup(true);
      return { ok: true };
    } catch (error) {
      return publishFailed(error);
    }
  };

  /** Take this Inbox's own mapping down (never someone else's) and close the door listener. */
  /**
   * A terminal closing a foreground Inbox (SIGHUP) would end it without its
   * clean stop and leave the mapping pointing at a dead port. Routed through
   * the clean stop only while a mapping exists, as `--tailscale` sessions do,
   * so the signal's default (and `nohup`) is untouched otherwise.
   */
  const onHangup = () => {
    stopTailnet();
    process.exit(129);
  };
  const hangup = (on: boolean) => {
    process.removeListener("SIGHUP", onHangup);
    if (on) process.once("SIGHUP", onHangup);
  };

  /**
   * Take this Inbox's own mapping down (the recorded one, never someone else's); the listener closes unless the
   * take-down failed. "later" (Tailscale not running) closes it too: a mapping Tailscale brings back points at a closed
   * port (502), and the record stays for the take-down still owed (`doorOwed`).
   */
  const unpublish = (): TakeDownAnswer => {
    const result = takeDownInboxTailnet(context.dataDir, tailscale, context.registry().tailnet);
    if (result === "failed") return result;
    closeDoorListener();
    hangup(false);
    tailnet.address = null;
    doorHttpsPort = null;
    return result;
  };

  // ── A refusal owed (inbox-machines.md, "Unlink removes both sides") ──
  //
  // A machine unlinked here while it could not be told learns at its next
  // contact, from its revoked token's `401 device_revoked`. With Phones off
  // that contact needs the tailnet door, so the door stays published until
  // that token has been refused once, the limit passes
  // (`UNLINKED_REFUSAL_KEPT_MS`), or the person turns the tailnet off. The
  // device record keeps `refusal_owed_until`, so a restart publishes it again.
  // The door serves nothing new meanwhile: that token is revoked, and the
  // door answers exactly as it does while a machine is linked.

  const refusalKeptMs = context.refusalKeptMs ?? UNLINKED_REFUSAL_KEPT_MS;
  const owesRefusal = () => devices.owedRefusals(now().getTime()).length > 0;
  /** Fires when the soonest owed refusal reaches its limit. */
  let owedTimer: ReturnType<typeof setTimeout> | null = null;
  /** The door's close once a refusal's answer has left (`REFUSED_DOOR_CLOSE_MS`). */
  let refusedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Wake when the soonest owed refusal reaches its limit: the door then comes down unless something else needs it. */
  const watchOwed = () => {
    if (owedTimer) clearTimeout(owedTimer);
    owedTimer = null;
    const soonest = devices.owedRefusals(now().getTime())[0];
    if (!soonest) return;
    const wait = Math.max(Date.parse(soonest.refusal_owed_until!) - now().getTime(), 0) + 50;
    owedTimer = setTimeout(
      () => {
        owedTimer = null;
        closeTailnetIfUnused();
        watchOwed();
      },
      Math.min(wait, 2 ** 31 - 1),
    );
    owedTimer.unref?.();
  };

  /** A machine unlinked here could not be told: its revoked token is owed one refusal, and the door stays for it. */
  const oweRefusal = (deviceId: string) => {
    devices.oweRefusal(deviceId, new Date(now().getTime() + refusalKeptMs).toISOString(), now().toISOString());
    watchOwed();
  };

  /** That machine was refused (`401 device_revoked`): it removes its side now, and the door comes down after the answer. */
  const refusalAnswered = (deviceId: string) => {
    devices.oweRefusal(deviceId, null, now().toISOString());
    watchOwed();
    if (refusedTimer) clearTimeout(refusedTimer);
    refusedTimer = setTimeout(() => {
      refusedTimer = null;
      closeTailnetIfUnused();
    }, REFUSED_DOOR_CLOSE_MS);
    refusedTimer.unref?.();
  };

  /**
   * Phones off: once no machine is linked, no machine offer is open and no
   * refusal is owed, the tailnet door has nothing to serve, so this Inbox's
   * mapping comes down and the switch is cleared (after the last unlink that
   * reached the other machine, an offer nobody used, or the refusal an
   * unlinked machine was owed). Phones on: the person's own switch decides,
   * so nothing changes.
   */
  const closeTailnetIfUnused = () => {
    if (phonesOn || openMachineOffers().length > 0 || context.machines?.()?.hasLinks() || owesRefusal()) return;
    if (tailnet.address === null && !doorServer && !context.registry().tailnet) return;
    const result = unpublish();
    if (result === "failed") return;
    tailnet.on = false;
    tailnet.error = null;
    saveSwitch(false, result === "later");
    if (result === "later") afterDoorAttempt("wait");
  };

  /**
   * At start, Phones off, nothing linked or owed, the switch kept, and a
   * refusal whose limit passed while the Inbox was down. After a clean stop
   * the record says the mapping is down, and nothing runs (the next link
   * publishes the same port). After a crash during that week (kill -9, a
   * panic, a dead battery) the record still says published, and no later
   * start would take that mapping to a dead loopback port down: it comes
   * down now, the switch is cleared and the lapsed refusals are forgotten. A
   * take-down that failed changes nothing, so the next start tries again.
   */
  const settleLapsedRefusals = (kept: InboxRegistryEntry["tailnet"]) => {
    // Nothing is owed now, so every refusal still recorded has lapsed.
    const lapsed = devices.owedRefusals(Number.NEGATIVE_INFINITY);
    if (lapsed.length === 0 || !readTailnetDoorRecord(context.dataDir)?.published) return;
    const result = takeDownInboxTailnet(context.dataDir, tailscale, kept);
    if (result === "failed") return;
    saveSwitch(false, result === "later");
    if (result === "later") afterDoorAttempt("wait");
    for (const device of lapsed) devices.oweRefusal(device.id, null, now().toISOString());
  };

  /**
   * At start: the switch was on, so point the mapping at a fresh door
   * listener before anything else uses it. If that fails, a mapping the last
   * run left (a crash, kill -9) is taken down, so it never points at a dead
   * port for longer than this start. With Phones off, no machine linked and
   * no refusal owed, the tailnet is not this Inbox's business: `tailscale`
   * never runs (a leftover waits for a link, Phones, or `uninstall --purge`),
   * except for a door kept for a refusal whose limit passed while the Inbox
   * was down (`settleLapsedRefusals`).
   */
  const startTailnet = () => {
    doorStopped = false;
    watchOwed();
    const kept = context.registry().tailnet;
    // Switched off while Tailscale was not running: the take-down still owed, by a look that never blocks.
    if (!kept) return afterDoorAttempt("soon");
    // Phones off: the door is published only for linked machines, and for one unlinked while it could not be told.
    if (!phonesOn && !context.machines?.()?.hasLinks() && !owesRefusal()) {
      settleLapsedRefusals(kept);
      return;
    }
    tailnet.on = true;
    const result = publish();
    if (result.ok) saveSwitch(true);
    // A take-down while Tailscale is stopped answers "failed" (tailscale-serve.ts) and keeps the record; any record
    // keeps its targets, so the publish once Tailscale runs (`INBOX_DOOR_REPUBLISH`) re-points a dead one of its own.
    else takeDownInboxTailnet(context.dataDir, tailscale, kept);
    // Not published: Tailscale may not run yet (wait for it), or the port holds a mapping, perhaps a dead one of this
    // Inbox's own, which only an asynchronous look can tell (look now).
    afterDoorAttempt(result.ok ? "published" : result.code === "tailnet_unavailable" ? "wait" : "soon");
  };

  // ── The door publishing again by itself (INBOX_DOOR_REPUBLISH) ──
  //
  // Never blocks the Inbox: a look reads Tailscale's state and `serve status` without blocking, probes a leftover
  // mapping of its own without blocking, and runs the (synchronous) publish only when the port is usable.

  const doorTimers = context.doorTimers ?? defaultDoorTimers;
  const runAsync: PairingTailscaleRunner = context.tailscale ?? runTailscaleQuietly;
  let doorTimer: unknown = null;
  let doorWait = 0;
  let doorStuck = 0;
  let doorStopped = true;
  let doorLooking = false;
  /** The door should be up: the switch on, and Phones on, a machine linked, or a refusal owed. */
  const doorWanted = () => !doorStopped && tailnet.on && (phonesOn || !!context.machines?.()?.hasLinks() || owesRefusal());
  /**
   * A take-down still owed: the switch is off (saved), yet the record says a mapping of this Inbox's may exist (it was
   * switched off while Tailscale was not running). Looked at on the same waits until Tailscale runs, then taken down.
   */
  const doorOwed = () =>
    !doorStopped && !tailnet.on && !doorServer && !context.registry().tailnet && readTailnetDoorRecord(context.dataDir)?.published === true;
  const cancelDoorLook = () => {
    if (doorTimer !== null) doorTimers.clear(doorTimer);
    doorTimer = null;
  };
  const armDoorLook = (ms: number) => {
    cancelDoorLook();
    doorTimer = doorTimers.set(() => {
      doorTimer = null;
      void doorLook().catch(() => {});
    }, ms);
  };
  /**
   * The next look, or none. "published": a slow check. "wait": Tailscale is not running, each wait longer. "stuck":
   * Tailscale runs and the door still could not be published (a port held, a refused serve): 10, then 30 minutes.
   * "soon": at once, once (a start that found a mapping on its port).
   */
  const afterDoorAttempt = (next: "published" | "wait" | "stuck" | "soon") => {
    cancelDoorLook();
    if (!doorWanted() && !doorOwed()) return;
    if (next !== "wait") doorWait = 0;
    if (next !== "stuck") doorStuck = 0;
    if (next === "published") armDoorLook(INBOX_DOOR_REPUBLISH.checkMs);
    else if (next === "soon") armDoorLook(0);
    else if (next === "wait") {
      const waits = INBOX_DOOR_REPUBLISH.waitMs;
      armDoorLook(waits[Math.min(doorWait, waits.length - 1)]!);
      doorWait++;
    } else {
      const stuck = INBOX_DOOR_REPUBLISH.stuckMs;
      armDoorLook(stuck[Math.min(doorStuck, stuck.length - 1)]!);
      doorStuck++;
    }
  };
  const readTailscale = async (args: string[], ms: number): Promise<TailscaleRunResult> => {
    try {
      return await runAsync(args, ms);
    } catch (error) {
      return { status: null, stdout: "", stderr: "", error: error instanceof Error ? error : new Error(String(error)) };
    }
  };
  /** A take-down still owed (`doorOwed`): only the status while Tailscale is not running, then the take-down, without blocking. */
  const owedLook = async () => {
    doorLooking = true;
    try {
      const status = await readTailscale(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS);
      if ((status.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || !doorOwed()) return;
      if (status.error || status.status !== 0 || parseTailscaleBackend(status.stdout).state !== "running") return afterDoorAttempt("wait");
      const record = readTailnetDoorRecord(context.dataDir)!;
      const result = await runTailscaleStepsAsync(takeDownOwnServeSteps(record.https_port, [record.target]), runAsync);
      if (!doorOwed()) return;
      if (result === "removed" || result === "none") return clearTailnetDoorRecord(context.dataDir);
      afterDoorAttempt(result === "later" ? "wait" : "stuck");
    } finally {
      doorLooking = false;
    }
  };
  /** One look; see the block's note. */
  const doorLook = async () => {
    if (doorLooking) return;
    if (!doorWanted()) return doorOwed() ? owedLook() : undefined;
    doorLooking = true;
    try {
      const status = await readTailscale(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS);
      if (!doorWanted()) return;
      // No `tailscale` at all: nothing to wait for.
      if ((status.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
      // Not running: a published door keeps its listener (the mapping Tailscale keeps comes back with it).
      if (status.error || status.status !== 0 || parseTailscaleBackend(status.stdout).state !== "running") return afterDoorAttempt("wait");
      const serve = await readTailscale(["serve", "status", "--json"], TAILSCALE_SERVE_TIMEOUT_MS);
      if (!doorWanted()) return;
      if (serve.error || serve.status !== 0) return afterDoorAttempt("stuck");
      if (tailnet.address && doorServer && doorHttpsPort !== null) {
        const mapped = serveStatusProxy(serve.stdout, doorHttpsPort);
        if (mapped.state === "malformed" || (mapped.state === "mapped" && mapped.proxy === `http://127.0.0.1:${doorServer.port as number}`)) return afterDoorAttempt("published");
      }
      // A mapping this Inbox made on its port: dead only when a connect to it is refused.
      const record = recordFor(serve.stdout);
      const leftover = ownLeftoverTarget(serve.stdout, record);
      const dead = new Set<string>();
      if (leftover && (await loopbackTargetDead(leftover))) dead.add(leftover);
      if (!doorWanted()) return;
      const refused = portRefusal(chooseTailnetDoorPort(serve.stdout, record, (target) => dead.has(target)));
      if (refused) {
        // Not usable: no publish (nothing synchronous); the words are publish's own.
        publishFailed(refused);
        return afterDoorAttempt("stuck");
      }
      const result = publish(dead);
      if (result.ok) {
        saveSwitch(true);
        context.onDoorRepublished?.();
      }
      afterDoorAttempt(result.ok ? "published" : "stuck");
    } finally {
      doorLooking = false;
    }
  };

  /**
   * A clean stop (quit, the stop route, a restart to update, which runs this
   * before it starts the new binary) takes the mapping and the door listener
   * down, so nothing is published while the Inbox is stopped. The switch stays
   * on in inbox.json, and the record keeps the port, so the next start
   * publishes the same address; a take-down that failed here leaves the
   * record saying the mapping may exist, so the next start or
   * `uninstall --purge` does it.
   */
  const stopTailnet = () => {
    doorStopped = true;
    cancelDoorLook();
    if (owedTimer) clearTimeout(owedTimer);
    owedTimer = null;
    // A close still waiting for a refusal's answer runs now, so a stop never leaves the switch on for nothing.
    if (refusedTimer) {
      clearTimeout(refusedTimer);
      refusedTimer = null;
      closeTailnetIfUnused();
    }
    if (tailnet.address === null && !doorServer) return;
    unpublish();
    closeDoorListener();
    hangup(false);
  };

  const setTailnet = (on: boolean): Response => {
    if (on) {
      const result = publish();
      if (!result.ok) return refuse(409, result.code, result.message);
      tailnet.on = true;
      saveSwitch(true);
      afterDoorAttempt("published");
      return json({ tailnet });
    }
    // A take-down that failed changes nothing: the switch stays on, the record is kept, and the window says why.
    // Tailscale not running ("later"): the switch turns off all the same, and the take-down is owed (`doorOwed`).
    const port = readTailnetDoorRecord(context.dataDir)?.https_port ?? INBOX_TAILNET_HTTPS_PORT;
    const result = unpublish();
    if (result === "failed") {
      return refuse(409, "tailnet_unavailable", `Tailscale could not take the Inbox's address down. Try again, or run "tailscale serve --https=${port} off".`);
    }
    tailnet.on = false;
    tailnet.error = null;
    saveSwitch(false, result === "later");
    afterDoorAttempt(result === "later" ? "wait" : "published");
    // The person turned the tailnet off: no door is kept for an unlinked machine after this.
    for (const device of devices.owedRefusals(Number.NEGATIVE_INFINITY)) devices.oweRefusal(device.id, null, now().toISOString());
    watchOwed();
    return json({ tailnet });
  };

  // ── The window's routes ──

  const staleTab = (body: Record<string, unknown>) =>
    checkServerSession(body, context.serverSession) === "mismatch" ? json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409) : null;

  /**
   * A read another site started (a page elsewhere loading this URL): the
   * pairing reads say what reached this computer and run its tools, so only
   * the window's own page asks for them.
   */
  const crossSiteRead = (req: Request): boolean => {
    const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
    if (site === "cross-site" || site === "same-site") return true;
    return !isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", site);
  };
  const crossOrigin = () => refuse(403, "cross_origin", "Cross-origin requests are not accepted.");

  /**
   * Step 1's checks: one read in flight at a time, shared by every caller,
   * and kept `PAIRING_CHECKS_FRESH_MS` after it lands. `fresh` (Check again,
   * after a switch) skips a kept answer but still joins a read in flight.
   */
  let checks: { at: number; done: boolean; value: Promise<PairingChecks> } | null = null;
  const deadline = context.checksDeadlineMs ?? PAIRING_CHECKS_DEADLINE_MS;
  const pairingChecks = (fresh: boolean): Promise<PairingChecks> => {
    // A read in flight is joined only while it is within its deadline (readPairingChecks settles by then; this
    // is the backstop), so a read that never settled can never stay the shared one.
    const inFlight = checks && !checks.done && Date.now() - checks.at < deadline + 1_000;
    if (checks && (inFlight || (checks.done && !fresh && Date.now() - checks.at < PAIRING_CHECKS_FRESH_MS))) return checks.value;
    const value = readPairingChecks({
      dataDir: context.dataDir,
      // Tests hand in a scripted runner; this computer's own `tailscale` runs as a child process, never blocking the Inbox.
      tailscale: context.checksTailscale ?? context.tailscale ?? runTailscaleQuietly,
      doorPort: doorPortIn,
      probes: context.probes,
      deadlineMs: deadline,
    });
    const entry = { at: Date.now(), done: false, value };
    checks = entry;
    value.then(
      () => {
        entry.done = true;
        entry.at = Date.now();
      },
      () => {
        if (checks === entry) checks = null;
      },
    );
    return value;
  };

  const windowRoute = async (req: Request, url: URL): Promise<Response | null> => {
    if (!phonesOn) return null;
    const path = url.pathname;
    if (path === "/api/inbox/pairing") {
      // The last offer's state and what reached the door while it showed; never its secret or code.
      if (req.method === "GET") return crossSiteRead(req) ? crossOrigin() : json({ offer: offerView() });
      if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const stale = staleTab(await context.readBody(req));
      return stale ?? json(makeOffer(), 201);
    }
    if (path === "/api/inbox/pairing/checks") {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      if (crossSiteRead(req)) return crossOrigin();
      // Step 1 of Pair a phone: advisory only. Reads, never turns anything on.
      const answer = await pairingChecks(url.searchParams.get("fresh") === "1");
      return json({ checks: answer, lan: lan.state(), tailnet });
    }
    if (path === "/api/inbox/devices") {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      return json({ devices: devices.list().filter((d) => d.platform !== AGENT_PLATFORM).map((d) => ({ ...publicDevice(d), app: apps.get(d.id) ?? null })) });
    }
    const revokeMatch = /^\/api\/inbox\/devices\/([A-Za-z0-9_]+)\/revoke$/.exec(path);
    if (revokeMatch) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const stale = staleTab(await context.readBody(req));
      if (stale) return stale;
      const device = devices.get(revokeMatch[1]!);
      if (!device) return refuse(404, "device_not_found", "No such phone.");
      return json({ device: publicDevice(revoke(device)) });
    }
    if (path === "/api/inbox/tailnet") {
      if (req.method === "GET") return json({ tailnet });
      if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const body = await context.readBody(req);
      const stale = staleTab(body);
      if (stale) return stale;
      if (typeof body.on !== "boolean") throw new InboxError("validation_error", "on: must be a boolean.", { field: "on" });
      checks = null;
      return setTailnet(body.on);
    }
    if (path === "/api/inbox/lan") {
      if (req.method === "GET") return json({ lan: lan.state() });
      if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const body = await context.readBody(req);
      const stale = staleTab(body);
      if (stale) return stale;
      if (typeof body.on !== "boolean") throw new InboxError("validation_error", "on: must be a boolean.", { field: "on" });
      checks = null;
      try {
        return json({ lan: lan.set(body.on) });
      } catch (error) {
        if (error instanceof LanUnavailableError) return refuse(409, "lan_unavailable", error.message);
        throw error;
      }
    }
    return null;
  };

  /** Linked machines (inbox-machines.ts): the door's side of linking. */
  const machineDoor = {
    openMachineOffer,
    openIntroductionOffer,
    offerDevice,
    /** The computer a provisional device's link-back must come from, and who introduced it; null for any other device. */
    introduction: (deviceId: string): { for: string; by: string } | null => {
      const device = devices.get(deviceId);
      if (!device?.introduced || device.revoked_at !== null) return null;
      return { for: device.introduced.for, by: device.introduced.by };
    },
    /** The link a provisional device was made for is saved: it is an ordinary device from now on. */
    settleIntroduction: (deviceId: string) => {
      devices.settleIntroduced(deviceId, now().toISOString());
    },
    /** `by` is no longer linked: every offer it had opened here closes, and every device still provisional from one goes. */
    dropIntroductions: (by: string) => {
      for (const o of introOffers) if (o.by === by) o.redeemed = true;
      for (const device of devices.list()) if (device.introduced?.by === by) revoke(device);
    },
    /** `oweRefusal`: a machine unlinked while it could not be told; the door stays up until its token is refused once. */
    revokeDevice: (id: string, options: { oweRefusal?: boolean } = {}) => {
      const device = devices.get(id);
      if (!device) return;
      if (device.revoked_at === null) revoke(device);
      if (options.oweRefusal && device.platform === MACHINE_PLATFORM) oweRefusal(id);
    },
    /** Close a machine offer that will not be used (a link that failed halfway); the device it made, if one was. */
    closeMachineOffer: (secret: string): string | null => {
      const found = machineOffers.find((o) => sameSecret(o.secret, secret));
      if (!found) return null;
      found.redeemed = true;
      return found.deviceId ?? null;
    },
    tailnetAddress: () => tailnet.address,
    /** `tailscale status --json`, without blocking (the same reader as the door's own looks): this computer and its tailnet's. */
    tailnetStatus: () => readTailscale(["status", "--json"], TAILSCALE_CLI_TIMEOUT_MS),
    /** Why the door is not published, while it should be (a port held, Tailscale stopped), in the window's words. */
    tailnetError: () => tailnet.error,
    publishTailnet: (): { ok: true; address: string } | { ok: false; message: string } => {
      if (tailnet.address) return { ok: true, address: tailnet.address };
      const result = publish();
      if (!result.ok) return { ok: false, message: result.message };
      tailnet.on = true;
      saveSwitch(true);
      afterDoorAttempt("published");
      return { ok: true, address: tailnet.address! };
    },
    closeTailnetIfUnused,
    computerName: () => computer().name,
  };

  /** Cloud agents' devices: minted here because the person asked on this computer, so no offer is redeemed. */
  const agentDevices = {
    mint: (name: string): { device: InboxDevice; token: string; secret: string } => {
      const token = `tok_${randomBytes(32).toString("base64url")}`;
      const secret = randomBytes(32).toString("base64url");
      const at = now().toISOString();
      const device = devices.add({ id: inboxId("dev"), name, platform: AGENT_PLATFORM, token, secret, at });
      devices.setCarriage(device.id, false, at);
      return { device: devices.get(device.id) ?? device, token, secret };
    },
    relay: async (device: InboxDevice): Promise<{ url: string; mailbox_id: string } | null> => (await context.relay?.paired(device)) ?? null,
    byToken: (token: string): InboxDevice | null => {
      const device = devices.byToken(token);
      return device?.platform === AGENT_PLATFORM ? device : null;
    },
    byId: (id: string): InboxDevice | null => {
      const device = devices.get(id);
      return device?.platform === AGENT_PLATFORM ? device : null;
    },
    /** A phone's or a machine's token, which the agent door refuses by name. */
    isOtherDevice: (token: string): boolean => {
      const device = devices.byToken(token);
      return device !== null && device.platform !== AGENT_PLATFORM;
    },
    touch: (id: string) => devices.touch(id, now().toISOString()),
    seenAt: (id: string): string | null => devices.get(id)?.last_seen_at ?? null,
    revoke: (id: string) => {
      const device = devices.get(id);
      if (device?.platform === AGENT_PLATFORM && device.revoked_at === null) revoke(device);
    },
  };

  return { door, asDevice, doorReach, windowRoute, startTailnet, stopTailnet, startLan: lan.start, stopLan: lan.stop, devices, machineDoor, agentDevices };
}
