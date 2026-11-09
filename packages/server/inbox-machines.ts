/**
 * Plannotator Inbox: linked machines (docs/agent-guides/inbox-machines.md;
 * PLAN.md Phase 1). Every Inbox is equal: one pairing code links two
 * machines both ways, and each Inbox shows every machine's threads. A thread
 * still lives only on the machine whose agent started it; another Inbox is a
 * view of it and a remote control.
 *
 * This file owns everything about links, so nothing of it is scattered
 * through the route table:
 *  - the records (inbox-links.ts), one PeerLink per linked machine
 *    (inbox-peer-link.ts) over its transport (inbox-transport.ts), and the
 *    outbox (inbox-outbox.ts);
 *  - linking both ways, and unlinking both ways (rule 13);
 *  - the merged view, served only when the window asks with `machines=1`
 *    (the door refuses that parameter to a machine, so two Inboxes linked
 *    both ways can never echo each other's threads);
 *  - the generic forward `/api/inbox/m/<machine>/<door route>`: reads pass
 *    through with the far door's own safety headers (and `sandbox` when it
 *    sent none); a write is held or passed by its route in rule 8's table
 *    (`doorWriteKind`), never by its Content-Type: files go straight through
 *    while the machine is online, every other write through the outbox;
 *  - the window's routes (`/api/inbox/machines…`, `/api/inbox/outbox…`), the
 *    CLI's control routes, and the two door routes only a machine may call
 *    (`link-back`, `unlink`).
 */

import { inboxRowArchived, isInboxId, type InboxListRow, type InboxMachineAccountsRead } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { inboxSnoozeRefusal, inboxSnoozeRunning } from "@plannotator/core/inbox-snooze";
import { refuseInboxSnoozeUntil } from "@plannotator/shared/inbox/snoozes";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { INBOX_MACHINE_WINDOW_ONLY_BODY, isWindowRequest } from "./inbox-cross-site";
import { INBOX_MACHINE_ACCOUNTS_MAX_BYTES, INBOX_MACHINE_ACCOUNTS_WAIT_MS, parsePeerAccounts } from "./inbox-accounts";
import { buildLinkOffer, InboxLinks, parseLinkOffer, type InboxLinkRecord } from "./inbox-links";
import { doorWriteKind, InboxOutbox, MACHINE_WINDOW_HEADER, type OutboxEntry } from "./inbox-outbox";
import { farVersion, MACHINE_LINKS_PROTOCOL, parseFarUpdate, PEER_LINK_TIMINGS, PeerLink, readCapped, type PeerLinkTimings, type PeerRecord } from "./inbox-peer-link";
import { installCommandFor, isNewerStableVersion, normalizeStableVersion } from "@plannotator/shared/update-check";
import { openTransport, type InboxTransportSpec } from "./inbox-transport";
import { checkTailnetAddress } from "./inbox-transport-tailnet";

/** How long a write to a machine that is online waits for its answer before the window is told "Sending…" (rule 12). */
export const MACHINE_WRITE_WAIT_MS = 4_000;
/** How long Unlink waits for the other machine to hear it before it unlinks here anyway (the other side learns at its next contact). */
const UNLINK_TELL_MS = 5_000;
/**
 * The other machine's `unlink` arrives on this Inbox's tailnet door. When it
 * was the last link, that door comes down, but only this long after the
 * answer left: closing the listener (and taking the serve mapping down)
 * under the request would cut the answer, and the other side would report
 * this machine as not reached.
 */
const UNLINKED_DOOR_CLOSE_MS = 1_000;
const PAIR_MS = 15_000;
/** A file sent to another machine: the time until its answer's headers (the upload itself). */
const UPLOAD_MS = 10 * 60_000;

/** The pieces of the device door linking needs (inbox-devices.ts). */
export interface InboxMachineDoor {
  /** Open a one-time machine offer: its secret and six digits. */
  openMachineOffer: () => { secret: string; code: string; expires_at: string };
  /** The device a machine offer was redeemed for, once it was. */
  offerDevice: (secret: string) => string | null;
  /** Close a machine offer that will not be used; the device it made, if one was. */
  closeMachineOffer: (secret: string) => string | null;
  /**
   * Remove a device from this Inbox's door (its token stops at once).
   * `oweRefusal`: the machine could not be told, so the tailnet door stays
   * published until its token has been refused once (or a week passes).
   */
  revokeDevice: (deviceId: string, options?: { oweRefusal?: boolean }) => void;
  /** This Inbox's door on the tailnet (`host:8443`), or null while it is not published. */
  tailnetAddress: () => string | null;
  /** Why the door is not published while it should be (its port held, Tailscale stopped), or null. */
  tailnetError: () => string | null;
  /** Publish the door on the tailnet now (the tailnet switch's own path). */
  publishTailnet: () => { ok: true; address: string } | { ok: false; message: string };
  /** Phones off: take the tailnet door down once no machine is linked and no machine offer is open. */
  closeTailnetIfUnused: () => void;
}

/** The id kinds a forwarded route names in its first segments. */
export type HeldKind = "threads" | "messages" | "attachments" | "projects" | "annotations";
const HELD_KINDS = new Set<string>(["threads", "messages", "attachments", "projects", "annotations"]);
/** The body fields a forwarded write names an id in, and the kind each is. */
const BODY_IDS = [
  ["thread_id", "messages"],
  ["message_id", "messages"],
  ["reply_to", "messages"],
  ["attachment_id", "attachments"],
  ["project_id", "projects"],
] as const;
const safeDecode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export interface InboxMachinesContext {
  dataDir: string;
  serverSession: string;
  computerName: () => string;
  door: InboxMachineDoor;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /**
   * Whether this Inbox's own store holds an id (archived and pinned threads included). The forward refuses a route
   * whose thread, message, file, comment or project is this machine's: whatever a window believes, it never goes to a peer.
   */
  holds: (kind: HeldKind, id: string) => boolean;
  /** A tailnet request from someone other than this computer's owner (a login from `inboxTailscaleAllow`). */
  isGuest: (req: Request, via: "local" | "tailnet") => boolean;
  /** This Inbox's own version and the newest release it knows of: the fallback when a machine knows of no update itself. */
  ownVersions?: () => { current: string; latest: string | null };
  /** Tests: the links' clocks. */
  timings?: MachineLinkTimings;
  now?: () => Date;
}

/** The links' clocks, and `accountsMs`: how long a read of a machine's accounts waits. */
export type MachineLinkTimings = Partial<PeerLinkTimings> & { updatedShownMs?: number; restartBackMs?: number; accountsMs?: number };

/** A frame for the window's event stream: other machines' records and states never share the local seq (design review, change 2). */
export type MachineFrame = { event: "machine"; data: PeerRecord } | { event: "machines"; data: { machines: MachineView[] } } | { event: "outbox"; data: OutboxView } | { event: "snoozes"; data: Record<string, never> } | { event: "deliveries"; data: { sessions?: boolean } };

/** How the window draws a machine's version (approval "inbox-machine-update"). */
export interface MachineUpdateView {
  phase: "behind" | "updating" | "ready" | "failed" | "restarting" | "not_back" | "updated";
  target: string | null;
  from: string | null;
  /** Its door takes `update`. */
  can_update: boolean;
  /** Its copy was installed by the install script. */
  self_update: boolean;
  /** The person asked an agent there to update it (an older door): the thread (null while held) and the agent. Absent otherwise. */
  asked?: { thread: string | null; agent: string; at: string };
}

/** How long "Updated" stays on the row, how long a machine has to come back, how long Update waits for its first answer (it asks GitHub first). */
const UPDATED_SHOWN_MS = 2 * 60_000;
const RESTART_BACK_MS = 3 * 60_000;
const UPDATE_START_MS = 45_000;
/** A press whose first `updating` has not arrived yet still reads as updating, for this long. */
const UPDATE_ASKED_GRACE_MS = 10_000;
/** How long an ask to an agent there is said ("Asked Claude Code on Mini"): an agent that never acts on it lets the dialog offer it again. */
export const AGENT_ASK_KEPT_MS = 30 * 60_000;

/**
 * What the window draws about a linked machine's version. That machine's own state first; when it has no newer version
 * to name (its checks are off), this Inbox's own version and newest known release can still show it is behind. An
 * Inbox never offers an update to a machine that is ahead of it or level with the newest known.
 */
export function machineUpdateView(
  peer: Pick<PeerLink, "state" | "since" | "version" | "farUpdate" | "noChange" | "asked" | "saidUpToDate" | "updated" | "canUpdate" | "selfUpdate"> & Partial<Pick<PeerLink, "agentAsked">>,
  own: { current: string; latest: string | null } | null,
  now: number,
  clocks: { updatedShownMs: number; restartBackMs: number },
): MachineUpdateView | null {
  const view = pressView(peer, own, now, clocks);
  // An agent there was asked to update it (an older door): said beside whatever the machine shows, for a while.
  const ask = peer.agentAsked && now - peer.agentAsked.at < AGENT_ASK_KEPT_MS ? peer.agentAsked : null;
  if (!ask || !view || view.phase === "updated") return view;
  const asked = { thread: ask.thread, agent: ask.agent, at: new Date(ask.at).toISOString() };
  // Gone since the ask: that agent's restart, for as long as a restart takes. Never "not back": a machine that sleeps
  // after an ask nobody acted on is only asleep.
  if (peer.state !== "online" && peer.since >= ask.at && now - peer.since < clocks.restartBackMs && view.phase === "behind") return { ...view, phase: "restarting", asked };
  return { ...view, asked };
}

function pressView(
  peer: Pick<PeerLink, "state" | "since" | "version" | "farUpdate" | "noChange" | "asked" | "saidUpToDate" | "updated" | "canUpdate" | "selfUpdate">,
  own: { current: string; latest: string | null } | null,
  now: number,
  clocks: { updatedShownMs: number; restartBackMs: number },
): MachineUpdateView | null {
  if (peer.state === "revoked") return null;
  const version = peer.version;
  const can = { can_update: peer.canUpdate, self_update: peer.selfUpdate };
  if (peer.updated && now - peer.updated.at < clocks.updatedShownMs) return { phase: "updated", target: peer.updated.to, from: peer.updated.from, ...can };
  const far = peer.farUpdate;
  if (peer.state === "online") {
    // During a press, `ready` is still that press: the install script runs on after it swaps the binary (skills,
    // plugins), and that machine restarts itself when the script ends. There is nothing to press.
    if (far?.state === "ready" && peer.asked) return { phase: "updating", target: far.version, from: version, ...can };
    if (far?.state === "updating" || far?.state === "failed" || far?.state === "ready") return { phase: far.state, target: far.version, from: version, ...can };
    if (peer.noChange) return { phase: "failed", target: peer.noChange, from: version, ...can };
    if (peer.asked && now - peer.asked.at < UPDATE_ASKED_GRACE_MS) return { phase: "updating", target: far?.version ?? null, from: version, ...can };
  } else if (peer.asked) {
    return { phase: now - peer.since >= clocks.restartBackMs ? "not_back" : "restarting", target: far?.version ?? null, from: version, ...can };
  }
  const candidates = [far?.version, own?.current, own?.latest].filter((v): v is string => !!v && !!normalizeStableVersion(v));
  const newest = candidates.reduce<string | null>((best, v) => (!best || isNewerStableVersion(v, best) ? v : best), null);
  if (!version || !normalizeStableVersion(version) || !newest || !isNewerStableVersion(newest, version)) return null;
  // This Inbox runs ahead of GitHub's latest, and that machine said so when pressed: Update would only say it again.
  // A release past that, or that machine's own answer, brings the word back.
  if (peer.saidUpToDate && far?.state !== "available" && !isNewerStableVersion(newest, peer.saidUpToDate)) return null;
  return { phase: "behind", target: newest, from: version, ...can };
}

/** Where that machine's update.log is, as `machinePath` sends it: a file name, or under `~` or the data folder. Never a command. */
const FAR_LOG = /^(?:(?:~|\$PLANNOTATOR_DATA_DIR)[/\\][\p{L}\p{N} ._@+\-/\\]*)?update\.log$/u;

/**
 * The far door's answer to `GET update`, picked by name again: this window never shows a URL or a command a machine
 * sent. The install command is this Inbox's own table, by that machine's platform and its remembered flags.
 */
export function parseFarDetails(raw: unknown) {
  const body = (raw ?? {}) as Record<string, any>;
  const platform = ["darwin", "linux", "win32"].includes(body.platform) ? (body.platform as "darwin" | "linux" | "win32") : "linux";
  const failure = body.failure && typeof body.failure === "object" ? body.failure : null;
  return {
    current: farVersion(body.current),
    update: parseFarUpdate(body.update),
    platform,
    // `installCommandFor` keeps only the flags on its own allowlist.
    command: installCommandFor(platform, Array.isArray(body.flags) ? body.flags : []),
    log: typeof body.log === "string" && FAR_LOG.test(body.log) ? body.log : "",
    open_reviews: typeof body.open_reviews === "number" ? Math.max(0, Math.min(body.open_reviews, 9999)) : 0,
    failure: failure
      ? {
          exit_code: typeof failure.exit_code === "number" ? failure.exit_code : 1,
          ...(failure.tls === "untrusted" || failure.tls === "revoked" ? { tls: failure.tls } : {}),
          ...(failure.release_first === true ? { release_first: true } : {}),
          // The one kind of reason there is (stagingReason): anything else is not said here.
          ...(typeof failure.prepare === "string" && /^(?:could not write to )?the temp folder\b/.test(failure.prepare) ? { prepare: failure.prepare.slice(0, 300) } : {}),
          ...(failure.unchanged === true ? { unchanged: true } : {}),
        }
      : null,
  };
}

export interface MachineView {
  id: string;
  name: string;
  /** This Inbox. */
  self: boolean;
  state: "online" | "connecting" | "offline" | "needs_update" | "revoked";
  /** When it entered that state. */
  since: string;
  reason: string | null;
  version: string | null;
  /** Where its door is reached (`mini.tail1234.ts.net:8443`). */
  address: string | null;
  /** Both ways (it shows this Inbox's threads too), or one way. */
  both_ways: boolean;
  /** Writes held for it (rule 12: "Will send when … is back"). */
  waiting: number;
  /**
   * The cursor of its list this Inbox holds (null: none yet). It moves when
   * that list is read again, so the window's `machines` frame tells it to
   * read the merged list once the far rows changed, not before.
   */
  list_cursor: number | null;
  /** Its Inbox keeps snoozes (approval "inbox-snooze"): a write there would land. False until its list is read, and for an older Inbox. */
  snoozes: boolean;
  /** Its list was read and it keeps no snoozes: an older Inbox, said so instead of Snooze vanishing. A list not read yet says nothing. */
  snooze_old?: boolean;
  /** Its version as the window draws it. Null: nothing to say. */
  update?: MachineUpdateView | null;
  /**
   * Remote launch, from its health when the line connected: agents can start there (true), launch is off there
   * (false: "Starting agents is off on Mini"), or its Inbox is too old to say (null: "Update Plannotator on Mini to
   * start agents there"). Null for this Inbox, whose own launch block says.
   */
  launch: boolean | null;
}

/** An agent's snooze of a linked machine's thread: its answer there, or `held`, the words for a write that waits. */
export interface MachineSnoozeAnswer {
  machine: string;
  name: string;
  snoozed: { until: string; at: string } | null;
  held: string | null;
  /** `until: null` took off a snooze this machine's list showed running. */
  ended: boolean;
}

/** What a held write says, by its machine's state: the same words as the window's `heldWords` (packages/inbox/api.ts). A revoked machine is forgotten as it is revoked, so it never holds one here. */
export function machineHeldWords(name: string, state: string | null): string {
  return state !== null && state !== "online" && state !== "connecting" ? `Waiting for ${name}: this applies when ${name} is back.` : `Sending to ${name}: this applies once ${name} confirms.`;
}

export interface OutboxView {
  key: string;
  machine: string;
  route: string;
  state: OutboxEntry["state"];
  queued_at: string;
  settled_at: string | null;
  status: number | null;
  answer: unknown;
  notice: OutboxEntry["notice"];
  dismissed: boolean;
  /** The words a held reply or message carries, so the window can show what waits (null for any other write). Cut at
   * OUTBOX_WORDS_SHOWN, then "…". */
  words: string | null;
  /** The thread it is about, as the window named it (null: not named, or an older entry). */
  thread: string | null;
  /** The machine's name once its link is gone (null while linked: the window knows it). */
  machine_name: string | null;
}

/** At most this much of a held write's words rides its view. */
const OUTBOX_WORDS_SHOWN = 2_000;

const wordsOf = (body: Record<string, unknown>): string | null => {
  const words = typeof body.words === "string" ? body.words : typeof body.body === "string" ? body.body : null;
  if (words === null) return null;
  return words.length > OUTBOX_WORDS_SHOWN ? `${words.slice(0, OUTBOX_WORDS_SHOWN)}…` : words;
};

export const outboxView = (entry: OutboxEntry): OutboxView => ({
  key: entry.key,
  machine: entry.machine,
  route: entry.route,
  state: entry.state,
  queued_at: entry.queued_at,
  settled_at: entry.settled_at,
  status: entry.status,
  answer: entry.answer,
  notice: entry.notice,
  dismissed: entry.dismissed,
  words: wordsOf(entry.body),
  thread: entry.thread ?? null,
  machine_name: entry.machine_name ?? null,
});

const FORWARD = /^\/api\/inbox\/m\/(ibx_[0-9A-HJKMNP-TV-Z]{26})\/(.+)$/;
const SNOOZE_ROUTE = /^threads\/[^/]+\/snooze$/;
const REPLY_ROUTE = /^messages\/[^/]+\/reply$/;
/** Another machine's folder names, for "Another folder on <machine>…" (remote launch), and where it would clone a URL. */
const FOLDERS_ROUTES = new Set(["launch/folders", "launch/clone", "launch/clone-check"]);
/** A tailnet guest of this Inbox, acting on another machine or on what waits for one. */
const OWNER_ONLY_BODY = { error: "Only this computer's owner can act on another machine from this Inbox.", code: "owner_only" } as const;
/** Of a forwarded read's query, what a guest never passes on: `sessions`' folder-trust facts. */
const GUEST_STRIPPED = ["trust_agent", "trust_project"] as const;

/** A forwarded read's query: a guest reads as before, but never another machine's folder-trust facts (Trust and start is the owner's). */
export function forwardedReadSearch(search: string, guest: boolean): string {
  if (!guest) return search;
  const query = new URLSearchParams(search);
  if (!GUEST_STRIPPED.some((name) => query.has(name))) return search;
  for (const name of GUEST_STRIPPED) query.delete(name);
  return query.size > 0 ? `?${query}` : "";
}
/** A launched agent's buttons on another machine (remote launch): Stop, Try again, Trust folder, Delete. */
const LAUNCH_ROUTE = /^launch\/[^/]+\/(stop|retry|trust|delete)$/;

/**
 * Remote launch: a write that starts, stops or trusts an agent on another machine, which is code run there. Only a
 * press in a window of this Inbox sends one; an agent's or a script's bare call through the forward never does.
 */
export function startsAgentThere(route: string, body: Record<string, unknown>): boolean {
  if (LAUNCH_ROUTE.test(route)) return true;
  const to = body.to;
  return route === "messages" && !!to && typeof to === "object" && "launch" in to;
}
/** A thread id the window names in `X-Plannotator-Thread`: kept on the outbox entry only, never sent on. */
const THREAD_HINT = /^[A-Za-z0-9_-]{8,80}$/;
/** Of the window's headers, the forward passes on only these (as the door does). */
const PASS_REQUEST = ["range", "if-range", "if-none-match"];
/** Of the far door's answer, these: its bytes' description, and its safety headers (an SVG or a page from another machine never runs on this origin). */
const PASS_RESPONSE = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "cache-control",
  "content-disposition",
  "last-modified",
  "x-content-type-options",
  "content-security-policy",
  "cross-origin-resource-policy",
  "x-image-width",
  "x-image-height",
];

/**
 * The far door's answer as the window gets it, from this Inbox's origin. Its
 * CSP always holds `sandbox`: the far CSP's directives are kept, and
 * `sandbox` is added when it lacks one, so nothing another machine serves (an
 * SVG, an HTML asset, an older, buggy or hostile Inbox's answer with a
 * permissive CSP) can run script here.
 */
function passAnswer(response: Response): Response {
  const headers = pick(response.headers, PASS_RESPONSE);
  const csp = headers["content-security-policy"]?.trim() ?? "";
  const directives = csp.split(";").map((d) => d.trim().split(/\s+/)[0]!.toLowerCase());
  if (!directives.includes("sandbox")) headers["content-security-policy"] = csp ? `${csp.replace(/;\s*$/, "")}; sandbox` : "sandbox";
  if (!headers["x-content-type-options"]) headers["x-content-type-options"] = "nosniff";
  return new Response(response.body, { status: response.status, headers });
}

function pick(headers: Headers, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

export function createInboxMachines(context: InboxMachinesContext) {
  const links = InboxLinks.open(context.dataDir);
  const outbox = InboxOutbox.open(context.dataDir, context.now);
  const peers = new Map<string, PeerLink>();
  const listeners = new Set<(frame: MachineFrame) => void>();
  /** An offer that published the door: the door comes down when it expires unused. */
  let offerTimer: ReturnType<typeof setTimeout> | null = null;
  /** The door's close after the other machine's `unlink` was answered (UNLINKED_DOOR_CLOSE_MS). */
  let doorCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMachines = "";
  const updatedShownMs = context.timings?.updatedShownMs ?? UPDATED_SHOWN_MS;
  const restartBackMs = context.timings?.restartBackMs ?? RESTART_BACK_MS;
  const startedAt = new Date().toISOString();
  const json = context.json;

  const emit = (frame: MachineFrame) => {
    for (const listener of listeners) listener(frame);
  };

  const updateView = (peer: PeerLink): MachineUpdateView | null =>
    machineUpdateView(peer, context.ownVersions?.() ?? null, Date.now(), { updatedShownMs, restartBackMs });

  const machinesView = (): MachineView[] => [
    {
      id: links.selfId,
      name: context.computerName(),
      self: true,
      state: "online",
      since: startedAt,
      // This Inbox's door, when it cannot be published (its port held by another mapping): the window and `link --list` say why.
      reason: context.door.tailnetError(),
      version: null,
      address: context.door.tailnetAddress(),
      both_ways: true,
      waiting: 0,
      list_cursor: null,
      snoozes: true,
      launch: null,
    },
    ...links.list().map((link) => {
      const peer = peers.get(link.id);
      return {
        id: link.id,
        name: link.name,
        self: false,
        state: peer?.state ?? "connecting",
        since: new Date(peer?.since ?? Date.now()).toISOString(),
        reason: peer?.reason ?? null,
        version: peer?.version ?? null,
        address: openTransport(link.transport).describe(),
        both_ways: link.device_id !== null,
        waiting: outbox.list(link.id, "pending").length,
        list_cursor: peer?.list?.cursor ?? null,
        snoozes: peer?.list?.snoozes ?? false,
        snooze_old: peer?.list ? !peer.list.snoozes : false,
        update: peer ? updateView(peer) : null,
        launch: peer?.launch ?? null,
      } satisfies MachineView;
    }),
  ];

  /** Tell the windows when the machines block changed (a state, a name, the waiting count). */
  const machinesChanged = () => {
    armUpdateClock();
    const machines = machinesView();
    const text = JSON.stringify(machines.map(({ since: _since, ...rest }) => rest));
    if (text === lastMachines) return;
    lastMachines = text;
    emit({ event: "machines", data: { machines } });
  };

  /** A machine's update changes by the clock too ("Not back", "Updated" fading): the window hears it when it does. */
  let updateClock: ReturnType<typeof setTimeout> | null = null;
  const armUpdateClock = () => {
    if (updateClock) clearTimeout(updateClock);
    updateClock = null;
    const now = Date.now();
    const due = [...peers.values()].flatMap((peer) => [
      ...(peer.updated ? [peer.updated.at + updatedShownMs] : []),
      ...(peer.asked ? [peer.state === "online" ? peer.asked.at + UPDATE_ASKED_GRACE_MS : peer.since + restartBackMs] : []),
      ...(peer.agentAsked ? [peer.agentAsked.at + AGENT_ASK_KEPT_MS, ...(peer.state === "online" ? [] : [peer.since + restartBackMs])] : []),
    ]).filter((at) => at > now);
    if (due.length === 0) return;
    updateClock = setTimeout(machinesChanged, Math.min(...due) - now + 20);
    (updateClock as { unref?: () => void }).unref?.();
  };

  outbox.onChange(({ entry }) => {
    emit({ event: "outbox", data: outboxView(entry) });
    machinesChanged();
  });

  /** Save a link (rule 19: a second link to the same id replaces the first) and start its line. A replaced link's old way back is revoked. */
  const save = (record: InboxLinkRecord) => {
    const old = links.get(record.id);
    links.put(record);
    if (old?.device_id && old.device_id !== record.device_id) context.door.revokeDevice(old.device_id);
    startPeer(record);
  };

  const startPeer = (link: InboxLinkRecord) => {
    peers.get(link.id)?.stop();
    const peer = new PeerLink({
      link,
      transport: openTransport(link.transport),
      outbox,
      timings: context.timings,
      onRecord: (record) => emit({ event: "machine", data: record }),
      onChange: machinesChanged,
      // A snooze moves no cursor, so nothing in the machines block changes: the windows are told in a frame of its own.
      onSnoozes: () => emit({ event: "snoozes", data: {} }),
      onDeliveries: ({ sessions }) => emit({ event: "deliveries", data: sessions ? { sessions: true } : {} }),
      onRevoked: () => forget(link.id),
    });
    peers.set(link.id, peer);
    peer.start();
    machinesChanged();
  };

  /**
   * Rules 4 and 13, this side: the link goes, the other machine's device on
   * this door goes, and every write held for it ends with its notice.
   * `closeDoor`: "now" when the other machine already knows; "after_answer"
   * when it is told by the answer on this door; "after_refusal" when it could
   * not be told, so the door stays until its token has been refused once.
   */
  const forget = (id: string, closeDoor: "now" | "after_answer" | "after_refusal" = "now"): InboxLinkRecord | null => {
    peers.get(id)?.stop();
    peers.delete(id);
    const link = links.remove(id);
    if (link?.device_id) context.door.revokeDevice(link.device_id, { oweRefusal: closeDoor === "after_refusal" });
    outbox.dropMachine(id, link?.name ?? null);
    // The last link gone: with Phones off the tailnet door has nothing left to serve (but a refusal owed).
    if (closeDoor === "after_answer") closeDoorAfterAnswer();
    else context.door.closeTailnetIfUnused();
    machinesChanged();
    return link;
  };

  /** Close the door once the answer on it has left (the check runs then: a link or offer made meanwhile keeps it up). */
  const closeDoorAfterAnswer = () => {
    if (doorCloseTimer) clearTimeout(doorCloseTimer);
    doorCloseTimer = setTimeout(() => {
      doorCloseTimer = null;
      context.door.closeTailnetIfUnused();
    }, UNLINKED_DOOR_CLOSE_MS);
    doorCloseTimer.unref?.();
  };

  // ── Linking (rule 4 of section 4: one code links both ways) ──

  /** The answer a door gave, read as JSON; a refusal becomes an InboxError carrying its code. */
  const doorAnswer = async (response: Response, what: string): Promise<Record<string, any>> => {
    const body = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok) {
      throw new InboxError(typeof body.code === "string" ? body.code : "link_failed", `${what}: ${typeof body.error === "string" ? body.error : `answered ${response.status}`}`);
    }
    return body;
  };

  /** Redeem another Inbox's offer through `spec` and check who answers: its token and its health. */
  const redeem = async (spec: InboxTransportSpec, offer: { id: string | null; secret: string | null; code: string | null }) => {
    const transport = openTransport(spec);
    let paired: Response;
    try {
      paired = await transport.request("pair", "", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: context.computerName(), platform: "machine", ...(offer.secret ? { secret: offer.secret } : { code: offer.code }) }),
        signal: AbortSignal.timeout(PAIR_MS),
      });
    } catch (error) {
      throw new InboxError("machine_unreachable", `Could not reach ${transport.describe()}: ${error instanceof Error ? error.message : String(error)}. Is its Inbox running, and is this computer on the same tailnet?`);
    }
    // With Phones off, a door with no machine offer open is the unknown route: the code was used, expired or replaced.
    if (paired.status === 404) throw new InboxError("offer_expired", "This link code is no longer open. Make a new one on the other machine.");
    const pairedBody = await doorAnswer(paired, "Pairing was refused");
    const token = String(pairedBody.token ?? "");
    const health = await doorAnswer(
      await transport.request("health", "", { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(PAIR_MS) }),
      "The other Inbox's health",
    );
    if (typeof health.machine_links !== "number" || health.machine_links < MACHINE_LINKS_PROTOCOL || typeof health.inbox_id !== "string") {
      throw new InboxError("machine_needs_update", `Update Plannotator on ${pairedBody.computer?.name ?? "the other machine"} (it runs ${health.version ?? "an older version"}): it cannot link machines yet.`);
    }
    if (offer.id && health.inbox_id !== offer.id) throw new InboxError("machine_mismatch", "A different Inbox answers at that address than the one that made this code.");
    if (health.inbox_id === links.selfId) throw new InboxError("link_to_self", "That is this Inbox's own link code: open the code on the other machine.");
    // The other machine names itself: control characters dropped (the CLI prints the name), at most 64 characters.
    const named = typeof pairedBody.computer?.name === "string" ? pairedBody.computer.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 64) : "";
    const name = named || "Other machine";
    return { token, id: health.inbox_id as string, name, transport };
  };

  /**
   * `plannotator inbox link --offer` / Settings' "Link another Plannotator":
   * a one-time code another Inbox redeems. `tailscale`: publish this door on
   * the tailnet first, so the code carries its address.
   */
  const offer = (input: { tailscale?: boolean }) => {
    let address = context.door.tailnetAddress();
    let tailnetError: string | null = null;
    if (!address && input.tailscale) {
      const published = context.door.publishTailnet();
      if (published.ok) address = published.address;
      else tailnetError = published.message;
    }
    const opened = context.door.openMachineOffer();
    // The code carries this Inbox's id, so the id must outlive a restart from now on.
    links.keepSelf();
    if (offerTimer) clearTimeout(offerTimer);
    offerTimer = setTimeout(() => context.door.closeTailnetIfUnused(), Date.parse(opened.expires_at) - Date.now() + 1_000);
    offerTimer.unref?.();
    const link = buildLinkOffer({ id: links.selfId, name: context.computerName(), tailnet: address, secret: opened.secret, code: opened.code });
    return { link, code: opened.code, expires_at: opened.expires_at, machine: { id: links.selfId, name: context.computerName() }, tailnet: address, tailnet_error: tailnetError };
  };

  /**
   * `plannotator inbox link <link>` / Settings → Machines: redeem the other
   * machine's code, then hand it a one-time code for this door so it links
   * back (both ways by default). `address` overrides the code's tailnet
   * address; `back` is how the other machine reaches this one (default: this
   * door's tailnet address, published now when it is not yet: linking both
   * ways is the person's consent to it). When it cannot be published, the
   * link is refused unless `one_way` says the person wants it that way.
   */
  const link = async (input: { link?: unknown; address?: unknown; code?: unknown; back?: unknown; one_way?: unknown }) => {
    const parsed = typeof input.link === "string" && input.link.trim() ? parseLinkOffer(input.link) : null;
    if (typeof input.link === "string" && input.link.trim() && !parsed) throw new InboxError("validation_error", "link: not a plannotator://link code.", { field: "link" });
    const secret = parsed?.secret ?? null;
    const code = parsed?.code ?? (typeof input.code === "string" ? input.code.trim() : null);
    if (!secret && !code) throw new InboxError("validation_error", "link or code: paste the other machine's link code, or type its address and six digits.", { field: "link" });
    if (parsed?.id === links.selfId) throw new InboxError("link_to_self", "That is this Inbox's own link code: open the code on the other machine.");
    const rawAddress = typeof input.address === "string" && input.address.trim() ? input.address : parsed?.tailnet;
    if (!rawAddress) {
      throw new InboxError("validation_error", "address: the other machine's tailnet address. Make its code with --tailscale, or give --address <name>.ts.net:8443.", { field: "address" });
    }
    const url = checkTailnetAddress(rawAddress);
    if (!url) throw new InboxError("validation_error", "address: an https address on your tailnet, like mini.tail1234.ts.net:8443.", { field: "address" });
    const oneWay = input.one_way === true;
    const givenBack = typeof input.back === "string" && input.back.trim() ? input.back : null;
    if (givenBack && !checkTailnetAddress(givenBack)) {
      throw new InboxError("validation_error", "back: this machine's address on your tailnet, like laptop.tail1234.ts.net:8443.", { field: "back" });
    }
    let backRaw = oneWay ? null : (givenBack ?? context.door.tailnetAddress());
    if (!backRaw && !oneWay) {
      const published = context.door.publishTailnet();
      if (!published.ok) {
        // Nothing came of it: with nothing else needing the door, its kept port is let go of (the held refusal says so).
        context.door.closeTailnetIfUnused();
        throw new InboxError(
          "no_way_back",
          `The other machine needs a way to reach this one to show its threads, and this Inbox could not publish its tailnet door: ${published.message} Fix that and link again, or pass --back <address>, or --one-way.`,
        );
      }
      backRaw = published.address;
    }
    const back = backRaw ? checkTailnetAddress(backRaw) : null;
    try {
      const target = await redeem({ kind: "tailnet", url }, { id: parsed?.id ?? null, secret, code });
      let deviceId: string | null = null;
      if (back) {
        const backOffer = context.door.openMachineOffer();
        const backLink = buildLinkOffer({ id: links.selfId, name: context.computerName(), tailnet: back, secret: backOffer.secret, code: backOffer.code });
        try {
          await doorAnswer(
            await target.transport.request("link-back", "", {
              method: "POST",
              headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ link: backLink }),
              signal: AbortSignal.timeout(PAIR_MS * 2),
            }),
            `${target.name} could not link back to this machine`,
          );
        } catch (error) {
          // Nothing half-made: the device this pairing made over there goes, and so does any the other side made here.
          const orphan = context.door.closeMachineOffer(backOffer.secret);
          if (orphan) context.door.revokeDevice(orphan);
          await tellUnlink(target.transport, target.token);
          throw error;
        }
        deviceId = context.door.offerDevice(backOffer.secret);
      }
      const record: InboxLinkRecord = { id: target.id, name: target.name, token: target.token, transport: { kind: "tailnet", url }, device_id: deviceId, linked_at: new Date().toISOString() };
      save(record);
      return { machine: machinesView().find((m) => m.id === record.id)! };
    } catch (error) {
      // A door this link published comes down again when nothing came of it.
      context.door.closeTailnetIfUnused();
      throw error;
    }
  };

  /**
   * Tell the other machine to drop this link. Told is its door's answer: 200
   * (it forgot the link) or 401 (it no longer knows this token). Only the
   * status counts, never the body: the answer may be its door's last before
   * it closes, so a connection that ends after it changes nothing.
   */
  const tellUnlink = async (transport: ReturnType<typeof openTransport>, token: string): Promise<boolean> => {
    let response: Response;
    try {
      response = await transport.request("unlink", "", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(UNLINK_TELL_MS),
      });
    } catch {
      return false;
    }
    response.body?.cancel().catch(() => {});
    return response.ok || response.status === 401;
  };

  /**
   * Rule 13: Unlink removes both links. The other machine is told first; when
   * it cannot be reached, this side unlinks anyway and revokes its device
   * here, so its next contact gets `device_revoked` and it cleans up then.
   * That contact needs this door, so it stays published (with Phones off,
   * even when this was the last link) until that refusal has been answered.
   */
  const unlink = async (id: string) => {
    const record = links.get(id);
    if (!record) throw new InboxError("machine_not_linked", "That machine is not linked.");
    peers.get(id)?.stop();
    const told = await tellUnlink(openTransport(record.transport), record.token);
    forget(id, told ? "now" : "after_refusal");
    return { unlinked: { id, name: record.name }, told };
  };

  // ── The two door routes only a machine may call (inbox-devices.ts hands them here) ──

  /** The other machine's half of a both-way link: it handed this Inbox a code for its door. */
  const linkBack = async (deviceId: string, body: Record<string, unknown>): Promise<Response> => {
    const parsed = typeof body.link === "string" ? parseLinkOffer(body.link) : null;
    if (!parsed?.secret || !parsed.tailnet || !parsed.id) return json({ error: "link: a plannotator://link code with an address.", code: "validation_error" }, 422);
    const url = checkTailnetAddress(parsed.tailnet);
    if (!url) return json({ error: "link: its address is not usable.", code: "validation_error" }, 422);
    try {
      const target = await redeem({ kind: "tailnet", url }, parsed);
      const record: InboxLinkRecord = { id: target.id, name: target.name, token: target.token, transport: { kind: "tailnet", url }, device_id: deviceId, linked_at: new Date().toISOString() };
      save(record);
      return json({ machine: { id: links.selfId, name: context.computerName() } }, 201);
    } catch (error) {
      if (error instanceof InboxError) return json({ error: error.message, code: error.code }, 409);
      throw error;
    }
  };

  /**
   * The other machine unlinked: forget it here too (rule 13). This answer
   * goes out on the door it came in on, so the door closes after it.
   */
  const unlinkedBy = (deviceId: string): Response => {
    const record = links.list().find((l) => l.device_id === deviceId);
    if (record) forget(record.id, "after_answer");
    else context.door.revokeDevice(deviceId);
    return json({ unlinked: true });
  };

  // ── The forward: /api/inbox/m/<machine>/<door route> ──

  const forward = async (req: Request, url: URL, machine: string, route: string, via: "local" | "tailnet"): Promise<Response> => {
    const peer = peers.get(machine);
    if (!peer) return json({ error: "That machine is not linked.", code: "machine_not_linked" }, 404);
    // The window's own stream carries other machines' records; a merged view is never asked of a machine.
    // A door route, nothing that could step out of it: no empty, `.` or `..` segment, no encoded dot, slash or backslash.
    const segments = route.split("/");
    if (/%2e|%2f|%5c|\\/i.test(route) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return json({ error: "Not a forwarded route.", code: "not_found" }, 404);
    }
    // Accounts go by `accountsOf` alone: a forward would pass the far answer as it came, past the owner's check, and
    // would hold a write such as a switch on disk. Nothing under `accounts/` either: a linked machine's switch is its own step.
    // `update` has its own route (`/api/inbox/machines/:id/update`), never a held forward.
    if (route === "events" || route === "pair" || route === "link-back" || route === "unlink" || route === "revoke" || safeDecode(segments[0]!) === "accounts" || safeDecode(route) === "update") {
      return json({ error: "Not a forwarded route.", code: "not_found" }, 404);
    }
    // This machine's own thread, message, file or project never goes to a peer, whatever the window learned: a
    // linked machine that lists or names one of this Inbox's ids cannot take its reads or writes.
    const ownId = HELD_KINDS.has(segments[0]!) && segments[1] ? safeDecode(segments[1]) : null;
    if (ownId && context.holds(segments[0] as HeldKind, ownId)) {
      return json({ error: "That is on this computer, not on another machine.", code: "id_is_local", id: ownId }, 409);
    }
    const offline = () =>
      json({ error: `${links.get(machine)?.name ?? "That machine"} cannot be reached now.`, code: "machine_offline", machine: machinesView().find((m) => m.id === machine) }, 503);
    if (req.method === "GET") {
      const search = forwardedReadSearch(url.search, context.isGuest(req, via));
      const headers = pick(req.headers, PASS_REQUEST);
      // Another machine's folder names ("Another folder on <machine>…"): the owner's window only, and said so to it.
      if (FOLDERS_ROUTES.has(route)) {
        if (context.isGuest(req, via)) return json(OWNER_ONLY_BODY, 403);
        if (req.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "Folders are listed in the Inbox window only.", code: "window_only" }, 403);
        headers[MACHINE_WINDOW_HEADER] = "1";
      }
      try {
        return passAnswer(await peer.request(route, search, { method: "GET", headers, signal: req.signal }));
      } catch {
        return offline();
      }
    }
    if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
    // A guest let onto this Inbox's tailnet was never let onto that machine: it writes nothing there. Reads stay as they are.
    if (context.isGuest(req, via)) return json(OWNER_ONLY_BODY, 403);
    // Rule 8's table decides, by route: a write it has not classified, or calls `local`, never reaches another machine.
    const kind = doorWriteKind(route);
    if (!kind) return json({ error: "Not a forwarded route.", code: "not_found" }, 404);
    if (kind === "file") {
      // A file (an upload, a drawing): never held. It goes now, or not at all.
      if (peer.state !== "online") return offline();
      try {
        const headers: Record<string, string> = { "Content-Type": req.headers.get("content-type") || "application/octet-stream" };
        const length = req.headers.get("content-length");
        if (length) headers["Content-Length"] = length;
        // A file's stale-tab guard rides the query: checked here against this Inbox's page session, never sent on.
        const query = new URLSearchParams(url.search);
        const session = query.get("serverSession");
        if (session !== null && checkServerSession({ serverSession: session }, context.serverSession) === "mismatch") {
          return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        }
        query.delete("serverSession");
        const search = query.size > 0 ? `?${query}` : "";
        return passAnswer(await peer.request(route, search, { method: "POST", headers, body: req.body, signal: req.signal, timeoutMs: UPLOAD_MS }));
      } catch {
        return offline();
      }
    }
    // Every other write is a JSON body, whatever its Content-Type says, and goes through the outbox.
    const body = await context.readBody(req);
    if (checkServerSession(body, context.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    // A press in this Inbox's window (its own Origin and this run's page session), said to the other machine with the
    // write: it answers a permission prompt, or starts, stops or trusts an agent there, only for one (remote launch).
    // An agent's or a script's bare call is still the owner's for every other write, as before.
    const window = isWindowRequest(req, body, context.serverSession);
    if (!window && startsAgentThere(route, body)) return json(INBOX_MACHINE_WINDOW_ONLY_BODY, 403);
    // A write that names this Inbox's thread, message, file or project in its body (a comment, a new message) is refused the same way.
    for (const [key, held] of BODY_IDS) {
      const id = body[key];
      if (typeof id === "string" && id !== "" && context.holds(held, id)) return json({ error: "That is on this computer, not on another machine.", code: "id_is_local", id }, 409);
    }
    // This Inbox's page session means nothing to the other machine's Inbox, and its drafts stay on this computer.
    delete body.serverSession;
    if (route === "messages") delete body.draft_id;
    // Rule 11: a reply held for another machine says what the person saw, so a late one is refused there.
    if (REPLY_ROUTE.test(route) && (typeof body.seen_through_seq !== "number" || !Number.isSafeInteger(body.seen_through_seq))) {
      throw new InboxError("validation_error", "seen_through_seq: a reply to another machine carries the newest seq of the thread the person saw.", { field: "seen_through_seq" });
    }
    // A time already gone when it is asked for is the asker's to hear now. One that goes by in the queue is for that machine to settle.
    if (SNOOZE_ROUTE.test(route) && !outbox.get(String(body.idempotency_key)) && inboxSnoozeRefusal(body.until) === "past") throw new InboxError("snooze_past", "That time has passed.", { field: "until" });
    // The window names the thread a write is about, so a held answer shows even where that thread cannot open.
    const named = req.headers.get("X-Plannotator-Thread")?.trim() ?? "";
    const { entry, fresh } = outbox.submit(machine, route, body, THREAD_HINT.test(named) ? named : null, window);
    if (peer.state === "online") peer.flush();
    else peer.poke();
    const settled = (await outbox.waitSettled(entry.key, peer.state === "online" ? MACHINE_WRITE_WAIT_MS : 0)) ?? entry;
    return outboxAnswer(settled, fresh);
  };

  /** The owner's own answer when there is one (status and body as its door gave them); otherwise 202 and the entry ("Sending…"). */
  const outboxAnswer = (entry: OutboxEntry, fresh: boolean): Response => {
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Plannotator-Outbox": entry.state };
    if (!fresh) headers["Idempotent-Replayed"] = "true";
    if ((entry.state === "delivered" || entry.state === "refused") && entry.status !== null) {
      return new Response(JSON.stringify(entry.answer), { status: entry.status, headers });
    }
    const machine = machinesView().find((m) => m.id === entry.machine) ?? null;
    return new Response(JSON.stringify({ outbox: outboxView(entry), machine }), { status: 202, headers });
  };

  // ── An agent's snooze of a linked machine's thread ──

  /**
   * The window's own write: the forward and the outbox, so a machine that is away gets it when it is back. Null: no
   * linked machine lists the thread. A machine too old to keep snoozes is refused here, with nothing held or noticed.
   */
  const snoozeThread = async (threadId: string, until: string | null): Promise<MachineSnoozeAnswer | null> => {
    const owners = [...peers.values()].flatMap((peer) => {
      const row = peer.list?.rows.find((candidate) => candidate.thread_id === threadId);
      return row ? [{ peer, row }] : [];
    });
    if (owners.length === 0) {
      if (peers.size === 0 || !isInboxId("msg", threadId)) return null;
      // Right after this Inbox starts, a machine that is away has sent no list, so the thread may be there.
      const unknown = [...peers.values()].filter((peer) => peer.list === null && peer.state !== "needs_update" && peer.state !== "revoked").map((peer) => links.get(peer.id)?.name ?? "A linked machine");
      if (unknown.length > 0) throw new InboxError("machine_offline", `This thread may be on ${unknown.join(" or ")}, whose threads are not known yet (away or still connecting). Nothing changed.`);
      throw new InboxError("thread_not_found", `No thread ${threadId}. On a linked machine, use the thread's id, not a message's.`);
    }
    if (owners.length > 1) throw new InboxError("machine_conflict", "Two linked machines both claim this thread, so it opens on neither.");
    const { peer, row } = owners[0]!;
    const machine = peer.id;
    const name = links.get(machine)?.name ?? "that machine";
    if (!peer.list!.snoozes) throw new InboxError("machine_needs_update", `Update Plannotator on ${name}: it cannot snooze threads yet. Nothing changed.`);
    // Refused here, as that machine's store would: sent, an agent's mistake would wait as if it will apply, then leave the person a notice.
    if (until !== null) {
      refuseInboxSnoozeUntil(until, new Date());
      if (inboxRowArchived(row)) throw new InboxError("thread_resolved", "This thread is archived; unarchive it first.");
    }
    const route = `threads/${encodeURIComponent(threadId)}/snooze`;
    const url = new URL(`http://inbox.local/api/inbox/m/${machine}/${route}`);
    const asked = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Plannotator-Thread": threadId },
      body: JSON.stringify({ idempotency_key: `agent-${crypto.randomUUID()}`, until }),
    });
    const response = await forward(asked, url, machine, route, "local");
    const body = (await response.json().catch(() => ({}))) as { snoozed?: MachineSnoozeAnswer["snoozed"]; code?: unknown; error?: unknown; machine?: { state?: string } | null; outbox?: OutboxView };
    if (response.status === 202) {
      const state = body.outbox?.state;
      if (state === "queued" || state === "sending") return { machine, name, snoozed: null, held: machineHeldWords(name, body.machine?.state ?? null), ended: false };
      const why = (body.outbox?.answer as { error?: unknown } | null | undefined)?.error;
      throw new InboxError("not_delivered", typeof why === "string" && why ? why : `Not delivered to ${name}.`);
    }
    if (!response.ok) throw new InboxError(typeof body.code === "string" ? body.code : "machine_refused", typeof body.error === "string" ? body.error : `${name} refused it.`);
    return { machine, name, snoozed: body.snoozed ?? null, held: null, ended: until === null && !!row.snoozed && inboxSnoozeRunning(row.snoozed.until) };
  };

  // ── A linked machine's accounts (Settings → Accounts, the Usage peek) ──

  /**
   * Its door's read, asked for only when a window asks (nothing polls), kept
   * nowhere, and picked by name again. Each machine is its own request, so a
   * slow one holds up only itself. It waits past the far run's own limit, so a
   * slow run comes back as its real `timed_out`, and only a machine that does
   * not answer at all is offline. A door that hangs while its line stays up is
   * awake, and so is one that revoked this link: the wait outlasts the line's
   * silence limit, so a machine truly asleep has lost its line by the end of
   * it. A door that does not know the route is an older Plannotator. An answer
   * past the cap is a failed read, and read no further.
   */
  const accountsOf = async (machine: string, fresh: boolean, signal: AbortSignal): Promise<InboxMachineAccountsRead> => {
    const peer = peers.get(machine);
    if (!peer) throw new InboxError("machine_not_linked", "That machine is not linked.");
    if (peer.state === "needs_update") return { state: "needs_update" };
    if (peer.state === "revoked") return { state: "unreachable" };
    if (peer.state === "offline") {
      peer.poke();
      return { state: "offline" };
    }
    try {
      const waitMs = context.timings?.accountsMs ?? INBOX_MACHINE_ACCOUNTS_WAIT_MS;
      // `timeoutMs` stops at the answer's headers: this signal covers its body too.
      const response = await peer.request("accounts", fresh ? "?fresh=1" : "", { method: "GET", headers: {}, timeoutMs: waitMs, signal: AbortSignal.any([signal, AbortSignal.timeout(waitMs)]) });
      const raw = await readCapped(response, INBOX_MACHINE_ACCOUNTS_MAX_BYTES);
      if (raw === null) return { state: "failed", reason: "bad_output" };
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // Not JSON: no answer to this read, below.
      }
      if (response.status === 404 && (body as { code?: unknown } | null)?.code === "device_route_not_found") return { state: "needs_update" };
      return response.ok ? parsePeerAccounts(body) : { state: "unreachable" };
    } catch {
      return { state: peer.state === "online" ? "unreachable" : "offline" };
    }
  };

  // ── The window's routes and the CLI's ──

  const staleTab = (body: Record<string, unknown>) =>
    checkServerSession(body, context.serverSession) === "mismatch" ? json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409) : null;

  /** The routes the window calls. `via`: linking and unlinking answer only on this computer (PLAN section 4, rule 5). */
  const route = async (req: Request, url: URL, via: "local" | "tailnet"): Promise<Response | null> => {
    const path = url.pathname;
    // Another site's page must not read (or time) other machines' threads or the links: refused like the window's other reads.
    if (req.method === "GET" && !isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
      return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
    }
    const forwarded = FORWARD.exec(path);
    if (forwarded) return forward(req, url, forwarded[1]!, forwarded[2]!, via);
    if (path === "/api/inbox/machines") {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      return json({ self: links.selfId, machines: machinesView() });
    }
    if (path === "/api/inbox/outbox") {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      const machine = url.searchParams.get("machine");
      const waiting = links.list().flatMap((l) => (machine && l.id !== machine ? [] : outbox.list(l.id, "pending")));
      return json({ waiting: waiting.map(outboxView), notices: outbox.notices().map(outboxView) });
    }
    // Cancel a write still waiting that never left (a launch held for a machine that is asleep): it is never sent.
    // The owner's, from any of their devices; a held launch only from a window, as the forward took it.
    const cancel = /^\/api\/inbox\/outbox\/([^/]+)\/cancel$/.exec(path);
    if (cancel) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      if (context.isGuest(req, via)) return json(OWNER_ONLY_BODY, 403);
      const body = await context.readBody(req);
      const stale = staleTab(body);
      if (stale) return stale;
      const key = decodeURIComponent(cancel[1]!);
      const held = outbox.get(key);
      if (held && startsAgentThere(held.route, held.body) && !isWindowRequest(req, body, context.serverSession)) return json(INBOX_MACHINE_WINDOW_ONLY_BODY, 403);
      const entry = outbox.cancel(key);
      if (!entry) return json({ error: "No such write.", code: "not_found" }, 404);
      if (entry.state !== "cancelled") {
        const name = links.get(entry.machine)?.name ?? entry.machine_name ?? "the other machine";
        return json({ error: `It already went to ${name}, so it can't be cancelled here.`, code: "outbox_already_sent", entry: outboxView(entry) }, 409);
      }
      return json({ entry: outboxView(entry) });
    }
    const dismiss = /^\/api\/inbox\/outbox\/([^/]+)\/dismiss$/.exec(path);
    if (dismiss) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      if (context.isGuest(req, via)) return json(OWNER_ONLY_BODY, 403);
      const stale = staleTab(await context.readBody(req));
      if (stale) return stale;
      const entry = outbox.dismiss(decodeURIComponent(dismiss[1]!));
      if (!entry) return json({ error: "No such write.", code: "not_found" }, 404);
      return json({ entry: outboxView(entry) });
    }
    // The window asked an agent on an older machine to update it (its New message went through the forward, as any
    // compose does): remembered here so that machine's row says so, then Restarting and Updated when it comes back newer.
    const askedMatch = /^\/api\/inbox\/machines\/(ibx_[0-9A-HJKMNP-TV-Z]{26})\/update\/asked$/.exec(path);
    if (askedMatch) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      if (context.isGuest(req, via)) return json(OWNER_ONLY_BODY, 403);
      const body = await context.readBody(req);
      const stale = staleTab(body);
      if (stale) return stale;
      const peer = peers.get(askedMatch[1]!);
      if (!peer) return json({ error: "That machine is not linked.", code: "machine_not_linked" }, 404);
      const thread = typeof body.thread_id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(body.thread_id) ? body.thread_id : null;
      const agent = typeof body.agent === "string" ? body.agent.replace(/\s+/g, " ").trim().slice(0, 60) : "";
      peer.agentAsked = { from: peer.version, at: Date.now(), thread, agent: agent || "An agent" };
      machinesChanged();
      return json({ ok: true, update: updateView(peer) });
    }
    // Update on another machine. Its own route, like its accounts: never the forward and never the outbox
    // (an update that waits days and runs when a machine wakes is not what anyone pressed).
    const updateMatch = /^\/api\/inbox\/machines\/(ibx_[0-9A-HJKMNP-TV-Z]{26})\/update$/.exec(path);
    if (updateMatch) {
      if (req.method !== "GET" && req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      // Another site's page never gets here: the request guard and the tailnet listener refuse it, reads included.
      if (context.isGuest(req, via)) return json({ error: "Only this computer's owner can update another machine from this Inbox.", code: "owner_only" }, 403);
      const peer = peers.get(updateMatch[1]!);
      if (!peer) return json({ error: "That machine is not linked.", code: "machine_not_linked" }, 404);
      const name = links.get(peer.id)?.name ?? "That machine";
      if (peer.state !== "online") {
        peer.poke();
        return json({ error: `${name} cannot be reached now. Nothing was sent.`, code: "machine_offline" }, 503);
      }
      if (req.method === "GET") {
        try {
          const answer = await peer.request("update", "", { method: "GET", headers: {} });
          if (answer.status === 404) return json({ too_old: true, current: peer.version });
          const raw = await readCapped(answer, 64 * 1024);
          return json(parseFarDetails(raw === null ? null : JSON.parse(raw)));
        } catch {
          return json({ error: `${name} did not answer.`, code: "machine_offline" }, 503);
        }
      }
      const stale = staleTab(await context.readBody(req));
      if (stale) return stale;
      try {
        // An empty body, always: nothing the window sent reaches that machine.
        const answer = await peer.request("update", "", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: UPDATE_START_MS });
        if (answer.status === 404) return json({ error: `${name} runs ${peer.version ?? "an older version"}, from before machines could update each other.`, code: "machine_too_old" }, 409);
        const raw = await readCapped(answer, 4 * 1024);
        const outcome = String((raw ? (JSON.parse(raw) as { outcome?: unknown }).outcome : "") ?? "");
        if (outcome === "launched" || outcome === "joined" || outcome === "restarting") {
          peer.asked = { from: peer.version, at: Date.now() };
          machinesChanged();
          return json({ ok: true, outcome });
        }
        if (outcome === "up-to-date") {
          peer.saidUpToDate = updateView(peer)?.target ?? peer.saidUpToDate;
          machinesChanged();
        }
        const words: Record<string, string> = {
          unmanaged: `${name}'s copy of Plannotator was not installed by the install script, so it can't update itself.`,
          "up-to-date": `${name} is up to date.`,
          "no-release": `${name} could not reach GitHub to find the newest release.`,
          "launch-failed": `The install script could not be started on ${name}.`,
          "dev-build": `${name} runs a development build.`,
        };
        return json({ error: words[outcome] ?? `The update could not start on ${name}.`, code: `update_${outcome.replace(/-/g, "_")}` }, 409);
      } catch {
        return json({ error: `${name} did not answer. Nothing may have started.`, code: "machine_offline" }, 503);
      }
    }
    const unlinkMatch = /^\/api\/inbox\/machines\/(ibx_[0-9A-HJKMNP-TV-Z]{26})\/unlink$/.exec(path);
    if (path === "/api/inbox/machines/offer" || path === "/api/inbox/machines/link" || unlinkMatch) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      if (via !== "local") return json({ error: "Linking machines works only on this computer's own screen.", code: "local_only" }, 403);
      const body = await context.readBody(req);
      const stale = staleTab(body);
      if (stale) return stale;
      if (unlinkMatch) return json(await unlink(unlinkMatch[1]!));
      if (path === "/api/inbox/machines/offer") return json(offer({ tailscale: body.tailscale === true }), 201);
      return json(await link(body), 201);
    }
    return null;
  };

  /** The CLI's control routes (the registry's bearer token, checked by the caller): offer, link, unlink, list. */
  const control = async (req: Request, path: string): Promise<Response | null> => {
    if (!path.startsWith("/api/inbox/control/machines")) return null;
    if (path === "/api/inbox/control/machines" && req.method === "GET") return json({ self: links.selfId, machines: machinesView() });
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await context.readBody(req);
    if (path === "/api/inbox/control/machines/offer") return json(offer({ tailscale: body.tailscale === true }), 201);
    if (path === "/api/inbox/control/machines/link") return json(await link(body), 201);
    if (path === "/api/inbox/control/machines/unlink") {
      const target = typeof body.machine === "string" ? body.machine.trim() : "";
      const record = links.list().find((l) => l.id === target || l.name.toLowerCase() === target.toLowerCase());
      if (!record) throw new InboxError("machine_not_linked", `No linked machine named ${target || "(none)"}.`);
      return json(await unlink(record.id));
    }
    return json({ error: "Not found", code: "not_found" }, 404);
  };

  // ── The merged view (only with machines=1) ──

  const rows = (): (InboxListRow & { machine: string })[] => [...peers.values()].flatMap((peer) => peer.list?.rows ?? []);
  const projects = (): Record<string, unknown>[] => [...peers.values()].flatMap((peer) => peer.list?.projects ?? []);
  const projectOwner = (projectId: string): string | null => {
    for (const peer of peers.values()) if (peer.list?.projects.some((p) => p.id === projectId)) return peer.id;
    return null;
  };

  const start = () => {
    for (const record of links.list()) startPeer(record);
  };

  const stop = () => {
    if (offerTimer) clearTimeout(offerTimer);
    offerTimer = null;
    // A door close still waiting runs now, so a stop never leaves the switch on for a door with nothing to serve.
    if (doorCloseTimer) {
      clearTimeout(doorCloseTimer);
      doorCloseTimer = null;
      context.door.closeTailnetIfUnused();
    }
    if (updateClock) clearTimeout(updateClock);
    updateClock = null;
    for (const peer of peers.values()) peer.stop();
    peers.clear();
    listeners.clear();
  };

  return {
    selfId: links.selfId,
    /** Whether any link exists (the tailnet door then publishes at start even with Phones off). */
    hasLinks: () => links.list().length > 0,
    machinesView,
    rows,
    projects,
    projectOwner,
    snoozeThread,
    /** The linked machine a device on this Inbox's door belongs to (a launch it starts here records it), or null. */
    machineOfDevice: (deviceId: string): { machine: string; name: string } | null => {
      const record = links.list().find((l) => l.device_id === deviceId);
      return record ? { machine: record.id, name: record.name } : null;
    },
    subscribe: (listener: (frame: MachineFrame) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    route,
    control,
    accountsOf,
    linkBack,
    unlinkedBy,
    start,
    stop,
  };
}

export type InboxMachines = ReturnType<typeof createInboxMachines>;
