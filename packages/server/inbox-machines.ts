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

import { INBOX_LINKED_MARKS, inboxPullUrlOfKey, inboxRowArchived, isInboxId, type InboxAgentsGroup, type InboxCardWire, type InboxInitiative, type InboxListRow, type InboxMachineAccountsRead, type InboxSentFrom, type InboxTagColours } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { inboxSnoozeRefusal, inboxSnoozeRunning } from "@plannotator/core/inbox-snooze";
import { refuseInboxSnoozeUntil } from "@plannotator/shared/inbox/snoozes";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { isForwardedHtmlAssetPath } from "@plannotator/shared/inbox/tailnet";
import { decodePathSegment } from "@plannotator/shared/path-segment";
import { INBOX_MACHINE_PULL_WINDOW_ONLY_BODY, INBOX_MACHINE_WINDOW_ONLY_BODY, isWindowRequest } from "./inbox-cross-site";
import { INBOX_MACHINE_ACCOUNTS_MAX_BYTES, INBOX_MACHINE_ACCOUNTS_WAIT_MS, parsePeerAccounts } from "./inbox-accounts";
import { buildLinkOffer, InboxLinks, parseLinkOffer, type InboxLinkRecord } from "./inbox-links";
import { createMachinePulls } from "./inbox-machine-pulls";
import { MACHINE_GUIDE_IMAGE_ROUTE, MACHINE_GUIDE_JSON_ROUTE, MACHINE_IMAGE_CSP, MACHINE_LINKED_PAGE_ROUTE, MACHINE_MARKDOWN_IMAGE_ROUTE, machineGuideJsonAnswer, machineLinkedPageAnswer, machineMarkdownImageAnswer } from "./inbox-machine-files";
import { farCsp, MACHINE_ASSET_ROUTE, MACHINE_PAGE_ROUTE, MACHINE_VIEW_ROUTE, machineAssetAnswer, machineAssetCsp, machinePageAnswer, machineViewAnswer } from "./inbox-machine-page";
import { createMachineLaunchReads, MACHINE_SESSIONS_ROUTE } from "./inbox-machine-launch-reads";
import { createMachineAgentRead, FAR_READ_REFUSALS } from "./inbox-machine-agent-read";
import { inboxFarReaderName, inboxMachineRecordName } from "./inbox-sent-from-reader";
import { createMachineAgentFind } from "./inbox-machine-agent-find";
import { INBOX_RUN_WINDOW_ONLY_BODY } from "./inbox-run-routes";
import { doorWriteKind, forwardsNow, InboxOutbox, MACHINE_WINDOW_HEADER, type OutboxEntry } from "./inbox-outbox";
import type { OutboxFile } from "./inbox-outbox-files";
import { inboxForwardedPlace } from "./inbox-sent-from";
import { createMachineBranches } from "./inbox-machine-branches";
import { createMachineDrafts, heldReplyState, lostDraftParts, MACHINE_DRAFT_ROUTE, type LostDraft } from "./inbox-machine-drafts";
import { createMachineShips } from "./inbox-machine-ships";
import { farVersion, MACHINE_LINKS_PROTOCOL, parseFarUpdate, PEER_LINK_TIMINGS, PeerLink, readCapped, type PeerCards, type PeerLinkTimings, type PeerRecord, type PeerRereadEvent } from "./inbox-peer-link";
import { installCommandFor, isNewerStableVersion, normalizeStableVersion } from "@plannotator/shared/update-check";
import { openTransport, type InboxTransportSpec } from "./inbox-transport";
import { checkTailnetAddress } from "./inbox-transport-tailnet";
import { sameTailnetRefusal } from "./inbox-same-tailnet";
import type { TailscaleRunResult } from "@plannotator/shared/tailscale";
import type { FarArchived } from "./inbox-archived-merged";
import { ARTIFACT_PINS_MARK, readFarWall } from "./inbox-artifacts-merged";
import type { InboxShowArchived } from "./inbox-show-archived";
import { createFarRoutines } from "./inbox-scheduled-machines";
import { CAPABILITY_SET_MARK, type CapabilitySet } from "./inbox-capability-set";
import type { SharedReactions } from "./inbox-reactions-shared";
import { FAR_AGENT_REPLY_ROUTE, FAR_DELIVERED_ROUTE, FAR_TAGGABLE_ROUTE, FAR_WAKE_ROUTE } from "./inbox-far-tags";
import { createLinkThrough, LINK_THROUGH_ASK_ROUTE, LINK_THROUGH_INTRODUCE_ROUTE, LINK_THROUGH_OFFER_ROUTE, LINK_THROUGH_ROUTES, LINK_THROUGH_WINDOW_ONLY, linkThroughAsks } from "./inbox-link-through";
import type { LinkThroughView } from "@plannotator/core/inbox-link-through";

/** A far tag's door routes (inbox-far-tags.ts): this Inbox sends them itself; the forward never does. */
const FAR_TAG_OWN_ROUTES = new Set([FAR_TAGGABLE_ROUTE, FAR_WAKE_ROUTE, FAR_AGENT_REPLY_ROUTE, FAR_DELIVERED_ROUTE]);

/** The most rows a linked machine's door gives in one archived page (its `INBOX_ARCHIVED_PAGE_MAX`). */
const FAR_ARCHIVED_LIMIT_MAX = 200;

/** How long a write to a machine that is online waits for its answer before the window is told "Sending…" (rule 12). */
export const MACHINE_WRITE_WAIT_MS = 4_000;
/** How long the merged Board waits for a linked machine's Board it has not read yet. */
const MERGED_CARDS_WAIT_MS = 2_000;
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
/** A PR's close, reopen or merge there: the forge is asked, then written to, by that machine's gh / glab. */
const FORGE_WRITE_MS = 60_000;

/** The pieces of the device door linking needs (inbox-devices.ts). */
export interface InboxMachineDoor {
  /** Open a one-time machine offer: its secret and six digits. */
  openMachineOffer: () => { secret: string; code: string; expires_at: string };
  /** Open an introduction's offer (inbox-link-through.ts): a secret only, for one computer, from the one introducing it. */
  openIntroductionOffer: (forId: string, by: string) => { secret: string; expires_at: string };
  /** A provisional device's binding: the computer whose link-back completes it, and who introduced it; null otherwise. */
  introduction: (deviceId: string) => { for: string; by: string } | null;
  /** The link a provisional device was made for is saved: it is an ordinary device from now on. */
  settleIntroduction: (deviceId: string) => void;
  /** A computer is no longer linked: the offers it had opened here close, and the devices still provisional from them go. */
  dropIntroductions: (by: string) => void;
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
  /** This computer's `tailscale status --json` (inbox-same-tailnet.ts); absent, an introduction's link is not checked against it. */
  tailnetStatus?: () => Promise<TailscaleRunResult>;
  /** Why the door is not published while it should be (its port held, Tailscale stopped), or null. */
  tailnetError: () => string | null;
  /** Publish the door on the tailnet now (the tailnet switch's own path). */
  publishTailnet: () => { ok: true; address: string } | { ok: false; message: string };
  /** Phones off: take the tailnet door down once no machine is linked and no machine offer is open. */
  closeTailnetIfUnused: () => void;
}

/** The id kinds a forwarded route names in its first segments. */
export type HeldKind = "threads" | "messages" | "attachments" | "projects" | "annotations" | "cards";
const HELD_KINDS = new Set<string>(["threads", "messages", "attachments", "projects", "annotations", "cards"]);
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
  /** The earlier runs of this Inbox's data folder (the health's `follows`): a far reply draft save from a page one served is taken. */
  follows?: readonly string[];
  computerName: () => string;
  door: InboxMachineDoor;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  /**
   * Whether this Inbox's own store holds an id (archived and pinned threads included). The forward refuses a route
   * whose thread, message, file, comment or project is this machine's: whatever a window believes, it never goes to a peer.
   */
  holds: (kind: HeldKind, id: string) => boolean;
  /** This Inbox's own version and the newest release it knows of: the fallback when a machine knows of no update itself. */
  ownVersions?: () => { current: string; latest: string | null };
  /** A linked machine's list was read: this Inbox takes its "Show archived" switch when that one is newer. */
  showArchivedSaid?: (value: InboxShowArchived) => void;
  /** A linked machine's list was read: this Inbox takes its saved reaction emoji when that set is newer. */
  reactionsSaid?: (value: SharedReactions) => void;
  /** A linked computer's list was read, one that keeps the one set (mark `capability-set`): this Inbox takes each newer flip. */
  capabilitySetSaid?: (value: CapabilitySet) => void;
  /** Grid is on here (experimental): only then are linked machines asked for Grid's fields and looks, and `clock_ms` shown. */
  gridOn?: () => boolean;
  /** Where the person wrote a write this Inbox forwards, told from the request (inbox-sent-from.ts). */
  sentFrom?: (req: Request, via: "local" | "tailnet") => InboxSentFrom | null;
  /** Tests: the links' clocks. */
  timings?: MachineLinkTimings;
  now?: () => Date;
  /** Where the same-tailnet check of an introduction's link reads the test sandbox flag (inbox-same-tailnet.ts). Default `process.env`. */
  tailnetCheckEnv?: Record<string, string | undefined>;
}

/** The links' clocks, and `accountsMs`: how long a read of a machine's accounts waits. */
export type MachineLinkTimings = Partial<PeerLinkTimings> & { updatedShownMs?: number; restartBackMs?: number; accountsMs?: number };

/** A frame for the window's event stream: other machines' records and states never share the local seq (design review, change 2). */
export type MachineFrame = { event: "machine"; data: PeerRecord } | { event: "machines"; data: { machines: MachineView[] } } | { event: "outbox"; data: OutboxView } | { event: PeerRereadEvent | "cards"; data: Record<string, never> } | { event: "deliveries"; data: { sessions?: boolean; agents?: boolean } } | { event: "drafts"; data: { thread_id: string } };

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
  /** Its threads' reply drafts held here, not landed there yet (never "waiting"): Unlink says they would be lost too. */
  drafts_held: number;
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
  /** The marks it takes for its own threads and agents (inbox-linked-marks): the window offers only those on its rows. Empty until its list is read, and for an older Inbox. */
  marks: string[];
  /** Its version as the window draws it. Null: nothing to say. */
  update?: MachineUpdateView | null;
  /**
   * Remote launch, from its health when the line connected: agents can start there (true), launch is off there
   * (false: "Starting agents is off on Mini"), or its Inbox is too old to say (null: "Update Plannotator on Mini to
   * start agents there"). Null for this Inbox, whose own launch block says.
   */
  launch: boolean | null;
  /**
   * Its store takes a Delete on an agent message's words (its health's `message_deletions`). Not: a Delete it refuses
   * (422) reads "<name> needs an update to delete words". True for this Inbox; false until its health is read, and for an older Inbox.
   */
  message_deletions: boolean;
  /** How far its clock runs ahead of this one's (ms, whole minutes), from its list's `now`; absent within two minutes. Grid reads it. */
  clock_ms?: number;
  /** This Inbox only: its links not linked to each other, and computers it reaches through a link (inbox-link-through.ts). */
  link_through?: LinkThroughView;
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
  /** A held Viewed tick in a review there: its file and whether it is ticked (null for any other write). */
  viewed: { path: string; viewed: boolean } | null;
}

const VIEWED_ROUTE = /^messages\/[^/]+\/guide\/viewed$/;
const viewedOf = (entry: OutboxEntry): OutboxView["viewed"] =>
  VIEWED_ROUTE.test(entry.route) && typeof entry.body.path === "string" && typeof entry.body.viewed === "boolean" ? { path: entry.body.path, viewed: entry.body.viewed } : null;

/** At most this much of a held write's words rides its view. */
const OUTBOX_WORDS_SHOWN = 2_000;

const wordsOf = (entry: OutboxEntry): string | null => {
  const { body } = entry;
  // An agent's answer in a thread there (inbox-mcp-far-reply.ts) holds send_message's arguments: its words are theirs.
  const args = entry.route === FAR_AGENT_REPLY_ROUTE && body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : null;
  const words = args ? (typeof args.body === "string" ? args.body : null) : typeof body.words === "string" ? body.words : typeof body.body === "string" ? body.body : null;
  if (words === null) return null;
  // A reply draft lost with its link is there to be copied whole ("Not sent"): its card shows the start of it.
  if (MACHINE_DRAFT_ROUTE.test(entry.route)) return words;
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
  words: wordsOf(entry),
  thread: entry.thread ?? null,
  machine_name: entry.machine_name ?? null,
  viewed: viewedOf(entry),
});

const FORWARD = /^\/api\/inbox\/m\/(ibx_[0-9A-HJKMNP-TV-Z]{26})\/(.+)$/;
const SNOOZE_ROUTE = /^threads\/[^/]+\/snooze$/;
const REPLY_ROUTE = /^messages\/[^/]+\/reply$/;
/** Another machine's folder names, for "Another folder on <machine>…" (remote launch), and where it would clone a URL. */
const FOLDERS_ROUTES = new Set(["launch/folders", "launch/clone", "launch/clone-check"]);
/** A file a message names, read on another machine (approval "inbox-file-refs-open-viewer"): its view, its bytes. */
const FILE_READ_ROUTE = /^open-in\//;
/**
 * The reads of a far file only this Inbox's window makes: a file a message names, a Markdown file's pictures, a
 * document next to a file, a guided review's pictures, whole files and package changes.
 */
const WINDOW_FILE_READS: readonly RegExp[] = [FILE_READ_ROUTE, MACHINE_MARKDOWN_IMAGE_ROUTE, MACHINE_LINKED_PAGE_ROUTE, MACHINE_GUIDE_IMAGE_ROUTE, MACHINE_GUIDE_JSON_ROUTE];
/** The reads a linked machine's window makes of this mark (`linked-reads`): steps, a review's files, a hover, a file check. */
const LINKED_READ_ROUTES: readonly RegExp[] = [/^threads\/[^/]+\/steps$/, MACHINE_GUIDE_IMAGE_ROUTE, MACHINE_GUIDE_JSON_ROUTE, /^open-in\/file(?:\/code)?$/];
/** A forwarded file read that is not a press in this Inbox's window. */
export const INBOX_MACHINE_FILE_WINDOW_ONLY_BODY = { error: "A file on another machine opens from the Inbox window only.", code: "window_only" } as const;

/**
 * Whether a forwarded read of a file on another machine is refused (`open-in/file/*`; a Markdown file's pictures and
 * a document next to an attached file, `attachments/<id>/markdown-image|linked-page`). That machine hands the read to
 * its own route as its owner's, so only this Inbox's window asks (an `<img>` and a `fetch` from it alike): a browser's own request (`Sec-Fetch-Site: same-origin`, and an
 * Origin, when sent, of this host). An agent's or a script's bare call sends neither, so it cannot read the other
 * machine's files through this one (the remote launch rule; a tightening, not a secret).
 */
export function forwardedFileReadRefusal(route: string, req: Request): { status: 403; body: Record<string, string> } | null {
  if (!WINDOW_FILE_READS.some((read) => read.test(route))) return null;
  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  const origin = req.headers.get("origin");
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = "";
  }
  const window = site === "same-origin" && (origin === null || originHost === (req.headers.get("host") ?? ""));
  return window ? null : { status: 403, body: INBOX_MACHINE_FILE_WINDOW_ONLY_BODY };
}
/** A launched agent's buttons on another machine (remote launch): Stop, Try again, Trust folder, Delete. */
const LAUNCH_ROUTE = /^launch\/[^/]+\/(stop|retry|trust|delete)$/;
/** New message, and a reply sent to a new session in place of one that ended: both carry `to.launch`. */
const LAUNCHES_WITH_TO = /^messages(\/[^/]+\/reply)?$/;
/** A routine's write there (make, edit, turn, run, stop, delete, bring back): that computer takes it only from a window. */
const ROUTINE_WRITE = /^scheduled(\/sch_[^/]+(\/(on|off|run|stop|delete|restore))?)?$/;

/**
 * Remote launch: a write that starts, stops or trusts an agent on another machine, which is code run there. Only a
 * press in a window of this Inbox sends one; an agent's or a script's bare call through the forward never does.
 */
export function startsAgentThere(route: string, body: Record<string, unknown>): boolean {
  if (LAUNCH_ROUTE.test(route) || ROUTINE_WRITE.test(route)) return true;
  const to = body.to;
  return LAUNCHES_WITH_TO.test(route) && !!to && typeof to === "object" && "launch" in to;
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
 * The far door's answer as the window gets it, from this Inbox's origin, whatever the far machine sent (an older,
 * buggy or hostile one included). Its CSP is `csp` when the caller names this origin's own (a far folder's answers,
 * `machineAssetCsp`); otherwise the far CSP as `farCsp` leaves it: always `sandbox`, never a flag that escapes it
 * (`allow-same-origin`, `allow-top-navigation…`, `allow-popups-to-escape-sandbox`). Always `nosniff`. So nothing
 * another machine serves (an SVG, a picture opened in a tab, an HTML asset) runs as this origin.
 */
function passAnswer(response: Response, options: { also?: readonly string[]; csp?: string; head?: boolean } = {}): Response {
  const headers = pick(response.headers, options.also ? [...PASS_RESPONSE, ...options.also] : PASS_RESPONSE);
  headers["content-security-policy"] = options.csp ?? farCsp(headers["content-security-policy"]);
  headers["x-content-type-options"] = "nosniff";
  if (options.head) void response.body?.cancel().catch(() => {});
  return new Response(options.head ? null : response.body, { status: response.status, headers });
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
  const machinePulls = createMachinePulls({ peers: () => peers.values() });
  // A linked machine's thread's reply draft (mark `reply-drafts`): kept there, held here while it is away. Every window
  // hears a change as it hears this Inbox's own (`event: drafts`).
  // The machines block says how many are held for each (`drafts_held`, for Unlink); it is sent only when that moved.
  /** A reply draft's words for a machine whose link went, put in "Not sent" in parts; false when a part could not be. */
  const notSent = (machine: string, name: string | null, lost: LostDraft): boolean => {
    let all = true;
    for (const part of lostDraftParts(lost)) {
      try {
        outbox.recordLostDraft(machine, lost.thread, part, name);
      } catch (error) {
        all = false;
        console.error(`Plannotator Inbox: a reply draft held for an unlinked computer could not be put in "Not sent" (${error instanceof Error ? error.message : String(error)}); it stays on disk.`);
      }
    }
    return all;
  };
  const drafts = createMachineDrafts({
    dataDir: context.dataDir,
    peer: (id) => peers.get(id),
    // Words saved as that machine's link went (a save on its way as Unlink ran): to "Not sent", never held for it.
    lost: (peer, lost) => void notSent(peer.id, peer.name ?? null, lost),
    // A reply that carried a held draft: the draft settles once it is delivered there; refused or cancelled, it comes back.
    replyState: (key) => heldReplyState(outbox.get(key)?.state),
    onChange: (_machine, threadId) => {
      emit({ event: "drafts", data: { thread_id: threadId } });
      machinesChanged();
    },
  });
  // Branch reviews: each linked machine's reported branches, read when Reviews is, kept past a restart (inbox-machine-branches.ts).
  const machineBranches = createMachineBranches({ peers: () => peers.values(), dir: inboxDir(context.dataDir), linked: () => links.list().map((link) => link.id) });
  // Ship: each linked machine's merged ships, read when Reviews is (inbox-machine-ships.ts).
  const machineShips = createMachineShips({ peers: () => peers.values() });
  /** Each linked machine's last good launch read, so a window opened while it sleeps still lists its projects. */
  const launchReads = createMachineLaunchReads();
  /** The person's writes waiting for a linked computer, laid on its routines as they are shown. */
  const heldOn = (machine: string) => outbox.list(machine, "pending").filter((entry) => !entry.auto);
  /** Each linked computer's routines (mark `routines`), for the Routines page's merged read (inbox-scheduled-machines.ts). */
  const farRoutines = createFarRoutines(() => peers.values(), heldOn);
  // An agent here reads a linked machine's thread, and saves its files here (inbox-machine-agent-read.ts).
  const agentRead = createMachineAgentRead({ peers: () => peers.values(), nameOf: (id) => links.get(id)?.name ?? "A linked machine" });
  // ...and finds them: its search and read_thread's list ask every linked machine too (inbox-machine-agent-find.ts).
  const agentFind = createMachineAgentFind({ peers: () => peers.values(), nameOf: (id) => links.get(id)?.name ?? "A linked machine" });
  const listeners = new Set<(frame: MachineFrame) => void>();
  /** A linked computer's stream that asked `links=1`: told when this Inbox's links, as its list names them, change. */
  const linksListeners = new Set<() => void>();
  let lastLinksWire = "";
  // Two of this Inbox's links not linked to each other, linked with one click (inbox-link-through.ts).
  const linkThrough = createLinkThrough({
    dataDir: context.dataDir,
    selfId: () => links.selfId,
    peers: () =>
      links.list().map((record) => {
        const peer = peers.get(record.id);
        return { id: record.id, name: record.name, state: peer?.state ?? "connecting", marks: peer?.list?.marks ?? [], wire: peer?.list?.link_through ?? null, url: record.transport.url };
      }),
    request: (machine, route, body, timeoutMs) => {
      const peer = peers.get(machine);
      if (!peer) return Promise.reject(new Error("not linked"));
      return peer.request(route, "", { method: "POST", headers: { "Content-Type": "application/json", [MACHINE_WINDOW_HEADER]: "1" }, body: JSON.stringify(body), timeoutMs });
    },
    hold: (via, body) => {
      const peer = peers.get(via);
      if (!peer) return;
      // The person's click, held as this Inbox's own write (never listed as waiting): its row says how it stands.
      outbox.submit(via, LINK_THROUGH_ASK_ROUTE, body, null, true, null, true);
      if (peer.state === "online") peer.flush();
      else peer.poke();
    },
    held: () => links.list().flatMap((record) => linkThroughAsks(outbox.list(record.id), record)),
    link: (input) => link(input, { introduced: true }),
    introOffer: (forId, by) => {
      const opened = context.door.openIntroductionOffer(forId, by);
      links.keepSelf();
      return { link: buildLinkOffer({ id: links.selfId, name: context.computerName(), tailnet: context.door.tailnetAddress(), secret: opened.secret, code: null }) };
    },
    ownAddress: () => context.door.tailnetAddress(),
    refresh: async (ids) => {
      await Promise.all(ids.map((id) => peers.get(id)?.refreshList()));
    },
    changed: () => machinesChanged(),
  });
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
      drafts_held: 0,
      list_cursor: null,
      snoozes: true,
      marks: [...INBOX_LINKED_MARKS],
      launch: null,
      message_deletions: true,
      link_through: linkThrough.view(),
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
        waiting: outbox.list(link.id, "pending").filter((e) => !e.auto).length,
        drafts_held: drafts.heldCount(link.id),
        list_cursor: peer?.list?.cursor ?? null,
        snoozes: peer?.list?.snoozes ?? false,
        snooze_old: peer?.list ? !peer.list.snoozes : false,
        marks: peer?.list?.marks ?? [],
        update: peer ? updateView(peer) : null,
        launch: peer?.launch ?? null,
        message_deletions: peer?.messageDeletions ?? false,
        ...(context.gridOn?.() && peer?.list?.clock_ms ? { clock_ms: peer.list.clock_ms } : {}),
      } satisfies MachineView;
    }),
  ];

  /** Tell the windows when the machines block changed (a state, a name, the waiting count). */
  const machinesChanged = () => {
    armUpdateClock();
    // The links as this Inbox's list names them to a linked computer: each that asked hears when they move.
    const wire = JSON.stringify(linkThrough.wire());
    if (wire !== lastLinksWire) {
      lastLinksWire = wire;
      for (const listener of linksListeners) listener();
    }
    linkThrough.tick();
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
    if (REPLY_ROUTE.test(entry.route)) drafts.replySettled(entry.machine, entry.key);
    // A link-through ask is drawn on its own row (how it stands, a refusal's words): the rows hear it, not the outbox.
    if (entry.auto && entry.route === LINK_THROUGH_ASK_ROUTE) return machinesChanged();
    // What this Inbox writes itself (a Combine's archive there) is not the person's: the window never draws it,
    // except the notice of one the person is told about when it does not land (`notify`).
    if (entry.auto && !(entry.notify && entry.notice !== null)) return;
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
      onChange: () => {
        if (peer.list?.show_archived) context.showArchivedSaid?.(peer.list.show_archived);
        if (peer.list?.reactions) context.reactionsSaid?.(peer.list.reactions);
        // An older Plannotator there says no mark: its switches stay its own, and none of its are taken here.
        if (peer.list?.capability_set && peer.list.marks.includes(CAPABILITY_SET_MARK)) context.capabilitySetSaid?.(peer.list.capability_set);
        // Back online: a reply draft held here for it lands (inbox-machine-drafts.ts).
        if (peer.state === "online") void drafts.drain(link.id);
        machinesChanged();
      },
      // A snooze or a star moves no cursor, so nothing in the machines block changes: the windows are told in a frame of its own.
      onReread: (event) => emit({ event, data: {} }),
      onCards: () => emit({ event: "cards", data: {} }),
      // A reply draft there changed (its window, a phone, a Send, this Inbox's own write): read again on the next read.
      onDrafts: (threadId, refreshed) => {
        drafts.farChanged(link.id, threadId, refreshed);
        emit({ event: "drafts", data: { thread_id: threadId } });
      },
      onDeliveries: ({ sessions, agents, labels }) => emit({ event: "deliveries", data: { ...(sessions ? { sessions: true } : {}), ...(agents ? { agents: true } : {}), ...(labels ? { labels: true } : {}) } }),
      onRevoked: () => forget(link.id),
      gridOn: context.gridOn,
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
    machinePulls.forget(id);
    machineBranches.forget(id);
    machineShips.forget(id);
    launchReads.forget(id);
    const link = links.remove(id);
    if (link?.device_id) context.door.revokeDevice(link.device_id, { oweRefusal: closeDoor === "after_refusal" });
    // What it introduced and is not complete yet goes with it: its open codes here, the devices they made, the introductions it sent.
    context.door.dropIntroductions(id);
    linkThrough.forgetBroker(id);
    // A reply draft held for it is lost with the link, as a write waiting for it is: its words join the "Not sent"
    // list, never gone silently. Never queued or sent (`recordLostDraft` writes it already dropped).
    // Every word goes (its files and quote named after them): a draft longer than one line fits is said in parts.
    // Written to "Not sent" first: the held files go only once every part is there.
    let handedOver = true;
    for (const lost of drafts.forget(id, true)) if (!notSent(id, link?.name ?? null, lost)) handedOver = false;
    if (handedOver) drafts.forget(id);
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
  const link = async (input: { link?: unknown; address?: unknown; code?: unknown; back?: unknown; one_way?: unknown }, how: { introduced?: boolean } = {}) => {
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
      // A code a linked computer handed over (inbox-link-through.ts): only for one of this person's own computers on
      // this tailnet, checked before its secret leaves here (inbox-same-tailnet.ts). A code pasted by hand is not.
      if (how.introduced) {
        const refused = await sameTailnetRefusal(url, context.door.tailnetStatus, context.tailnetCheckEnv);
        if (refused) throw new InboxError("not_same_tailnet", refused);
      }
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
        if (!deviceId) {
          // Its way back was taken, but the offer that names the device it made is gone: a link saved without it could
          // not revoke that device at Unlink. Nothing half-made: the other machine forgets its side.
          await tellUnlink(target.transport, target.token);
          throw new InboxError("machine_not_linked", "That machine is not linked.");
        }
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
    // A device an introduction's code made (inbox-link-through.ts) is completed only by the computer it was made for,
    // however many link-backs came before; it stays bound until its link is saved.
    const introduced = context.door.introduction(deviceId);
    if (introduced && introduced.for !== parsed.id) {
      context.door.revokeDevice(deviceId);
      return json({ error: "This link code was made for another computer.", code: "introduction_mismatch" }, 403);
    }
    // ...and only when it is one of this person's own computers on this tailnet (inbox-same-tailnet.ts).
    const refused = introduced ? await sameTailnetRefusal(url, context.door.tailnetStatus, context.tailnetCheckEnv) : null;
    if (refused) {
      context.door.revokeDevice(deviceId);
      return json({ error: refused, code: "not_same_tailnet" }, 403);
    }
    try {
      const target = await redeem({ kind: "tailnet", url }, parsed);
      // Dropped meanwhile (its time ran out, or the computer that introduced it was unlinked): nothing is saved.
      if (introduced && (target.id !== introduced.for || !context.door.introduction(deviceId))) {
        await tellUnlink(target.transport, target.token);
        return json({ error: "This introduction is no longer open. Click Link again.", code: "introduction_dropped" }, 409);
      }
      const record: InboxLinkRecord = { id: target.id, name: target.name, token: target.token, transport: { kind: "tailnet", url }, device_id: deviceId, linked_at: new Date().toISOString() };
      save(record);
      if (introduced) context.door.settleIntroduction(deviceId);
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
    // A far tag's own writes (inbox-far-tags.ts) are this Inbox's, never a window's.
    if (route === "events" || route === "pair" || route === "link-back" || route === "unlink" || route === "revoke" || safeDecode(segments[0]!) === "accounts" || safeDecode(route) === "update" || FAR_TAG_OWN_ROUTES.has(safeDecode(route)) || LINK_THROUGH_ROUTES.has(safeDecode(route))) {
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
    const fileRead = forwardedFileReadRefusal(route, req);
    if (fileRead) return json(fileRead.body, fileRead.status);
    // A linked-reads read of a machine known to be away answers at once: never a wait to the request's limit.
    if (req.method === "GET" && peer.state === "offline" && LINKED_READ_ROUTES.some((read) => read.test(route))) return offline();
    // HEAD as a local page and its folder answer it: the far GET's headers, no body.
    const head = req.method === "HEAD" && (MACHINE_PAGE_ROUTE.test(route) || MACHINE_ASSET_ROUTE.test(route) || MACHINE_MARKDOWN_IMAGE_ROUTE.test(route) || MACHINE_GUIDE_IMAGE_ROUTE.test(route));
    // A thread's reply draft (inbox-machine-drafts.ts): one waiting to land there, or (away) the last one heard, is answered here.
    const draftRoute = MACHINE_DRAFT_ROUTE.exec(route);
    if (draftRoute && !draftRoute[2] && req.method === "GET") {
      const here = drafts.read(peer, draftRoute[1]!);
      if (here) return json(here);
    }
    if (req.method === "GET" || head) {
      const search = url.search;
      const headers = pick(req.headers, PASS_REQUEST);
      // Another machine's folder names ("Another folder on <machine>…"): the owner's window only, and said so to it.
      if (FOLDERS_ROUTES.has(route)) {
        if (req.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "Folders are listed in the Inbox window only.", code: "window_only" }, 403);
        headers[MACHINE_WINDOW_HEADER] = "1";
      }
      // A file a message names: only the window's read gets here (`forwardedFileReadRefusal`), said so to that machine.
      if (FILE_READ_ROUTE.test(route)) headers[MACHINE_WINDOW_HEADER] = "1";
      // Its launch block and home are kept for a window opened while it sleeps (`launch_reads` on the machines read),
      // numbered as the read starts so an older answer that ends later never replaces a newer one.
      const sessionsRead = route === MACHINE_SESSIONS_ROUTE ? launchReads.begin() : null;
      // An attached page's own tab is made here from its door's `view` (inbox-machine-page.ts): no page route there.
      const page = MACHINE_PAGE_ROUTE.exec(route);
      try {
        const answer = await peer.request(page ? `attachments/${page[1]}/view` : route, search, { method: "GET", headers, signal: req.signal });
        if (sessionsRead !== null && answer.ok) void launchReads.keep(machine, sessionsRead, answer.clone(), () => peers.has(machine));
        if (draftRoute && !draftRoute[2]) {
          drafts.noteRead(machine, draftRoute[1]!, answer.clone());
          // Words of the person's the draft there does not hold (a conflict a held save met): offered with it.
          const offered = answer.ok ? drafts.notLanded(machine, draftRoute[1]!) : null;
          if (offered) return json({ ...((await answer.json().catch(() => ({}))) as Record<string, unknown>), not_landed: offered });
        }
        if (page) {
          const made = await machinePageAnswer(answer, machine, search, (far) => passAnswer(far));
          if (!head) return made;
          void made.body?.cancel().catch(() => {});
          return new Response(null, { status: made.status, headers: made.headers });
        }
        if (MACHINE_VIEW_ROUTE.test(route)) return passAnswer(await machineViewAnswer(answer, machine));
        // A Markdown file's pictures and a document next to a file (inbox-machine-files.ts): as a local file's.
        if (MACHINE_MARKDOWN_IMAGE_ROUTE.test(route) || MACHINE_GUIDE_IMAGE_ROUTE.test(route)) return passAnswer(machineMarkdownImageAnswer(answer), { csp: MACHINE_IMAGE_CSP, head });
        if (MACHINE_LINKED_PAGE_ROUTE.test(route)) return passAnswer(await machineLinkedPageAnswer(answer, machine));
        if (MACHINE_GUIDE_JSON_ROUTE.test(route)) return passAnswer(await machineGuideJsonAnswer(answer));
        // Its folder, read from an opaque origin as a local page's is: CORS reads (fonts, module scripts) as here,
        // under a local folder's CSP, never the far one.
        if (MACHINE_ASSET_ROUTE.test(route)) {
          const asset = await machineAssetAnswer(answer, machine);
          return passAnswer(asset, { also: ["access-control-allow-origin"], csp: machineAssetCsp(asset), head });
        }
        return passAnswer(answer);
      } catch {
        return offline();
      }
    }
    if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
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
        const far = await peer.request(route, search, { method: "POST", headers, body: req.body, signal: req.signal, timeoutMs: UPLOAD_MS });
        // A reply draft held while that machine is away shows this file's tile by it.
        if (route === "uploads" && far.ok) drafts.noteUpload(far.clone());
        return passAnswer(far);
      } catch {
        return offline();
      }
    }
    // Every other write is a JSON body, whatever its Content-Type says, and goes through the outbox, but draft text.
    const body = await context.readBody(req);
    // Draft text (rule 8's `draft`): the reply-draft module's, never the outbox's (`submit` refuses it).
    const draftWrite = kind === "draft" ? MACHINE_DRAFT_ROUTE.exec(route) : null;
    // A reply draft SAVE from a page an earlier run of this same Inbox served is taken, as this Inbox's own drafts take
    // it (inbox-reply-drafts.ts `follows`): it is a compare-and-set, so it never writes over newer words.
    const earlierRun = !!draftWrite && !draftWrite[2] && typeof body.serverSession === "string" && (context.follows ?? []).includes(body.serverSession);
    if (!earlierRun && checkServerSession(body, context.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    // A press in this Inbox's window (its own Origin and this run's page session), said to the other machine with the
    // write: it answers a permission prompt, or starts, stops or trusts an agent there, only for one (remote launch).
    // An agent's or a script's bare call is still the owner's for every other write, as before.
    const window = isWindowRequest(req, body, context.serverSession);
    if (!window && startsAgentThere(route, body)) return json(INBOX_MACHINE_WINDOW_ONLY_BODY, 403);
    // A reply draft's save or Discard: straight there while it can take it, else held here (inbox-machine-drafts.ts).
    if (kind === "draft") {
      if (!draftWrite) return json({ error: "Not a forwarded route.", code: "not_found" }, 404);
      delete body.serverSession;
      const answer = await drafts.write(peer, draftWrite[1]!, !!draftWrite[2], body, req.signal);
      return "far" in answer ? passAnswer(answer.far) : json(answer.body, answer.status);
    }
    // Sent now or not at all, from a press in this window (rule 8, `now`): a file a message names, attached there as the
    // person comments on it (the window needs the attachment now); a Combine, or a Tidy with the person's words, which
    // held for days would act on threads nobody is looking at. A Tidy without words stays held like any append.
    if (forwardsNow(route, body)) {
      if (!window) return json(route === "open-in/file/attach" ? INBOX_MACHINE_FILE_WINDOW_ONLY_BODY : /^messages\/[^/]+\/(run|secret)$/.test(route) ? INBOX_RUN_WINDOW_ONLY_BODY : INBOX_MACHINE_WINDOW_ONLY_BODY, 403);
      if (peer.state !== "online") return offline();
      delete body.serverSession;
      try {
        return passAnswer(await peer.request(route, "", { method: "POST", headers: { "Content-Type": "application/json", [MACHINE_WINDOW_HEADER]: "1" }, body: JSON.stringify(body), signal: req.signal }));
      } catch {
        return offline();
      }
    }
    if (kind === "forge") {
      // A PR's close, reopen or merge as that machine's gh / glab: a request that looks like this window's, sent now or
      // not at all. That stops an agent's bare call, not a local program that imitates the window ("Accepted, not
      // defended" in inbox-launch.md). A close held for days would run when nobody is looking, and Undo's reopen is
      // taken there only minutes after it.
      if (!window) return json(INBOX_MACHINE_PULL_WINDOW_ONLY_BODY, 403);
      if (peer.state !== "online") return offline();
      delete body.serverSession;
      try {
        const far = await peer.request(route, "", { method: "POST", headers: { "Content-Type": "application/json", [MACHINE_WINDOW_HEADER]: "1" }, body: JSON.stringify(body), signal: req.signal, timeoutMs: FORGE_WRITE_MS });
        const answer = passAnswer(far);
        // A retried press under its key: that machine's door answered it again without running it.
        if (far.headers.get("idempotent-replayed") === "true") answer.headers.set("Idempotent-Replayed", "true");
        if (answer.ok) void machinePulls.reread(peer);
        return answer;
      } catch (error) {
        // Refused before it got there: nothing ran. Past its time (or the window left): it may have run there, as the
        // gh call is not stopped with the request, so its board is read before anything is said.
        const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
        if (!aborted) return offline();
        const key = typeof body.key === "string" ? body.key : "";
        const done = { "pulls/close": "closed", "pulls/reopen": "open", "pulls/merge": "merged" }[route];
        const state = key ? await machinePulls.stateThere(peer, key) : null;
        if (state !== null && state === done) return json({ ok: true, key, url: inboxPullUrlOfKey(key) ?? "", method: null });
        const name = links.get(machine)?.name ?? "That machine";
        return json({ error: `${name} did not answer in time. It may have run there: check the pull request.`, code: "pull_unconfirmed" }, 504);
      }
    }
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
    // Where the person was, when not at this window, said on so that machine's agent reads where they wrote it.
    const place = inboxForwardedPlace(context.sentFrom?.(req, via) ?? null);
    const { entry, fresh } = outbox.submit(machine, route, body, THREAD_HINT.test(named) ? named : null, window, place);
    // A reply that carries a draft still waiting to land there: the draft shown here settles with it.
    if (fresh && REPLY_ROUTE.test(route) && THREAD_HINT.test(named)) drafts.afterReply(peer, named, body, entry.key);
    if (peer.state === "online") peer.flush();
    else peer.poke();
    const settled = (await outbox.waitSettled(entry.key, peer.state === "online" ? MACHINE_WRITE_WAIT_MS : 0)) ?? entry;
    // A state that landed is in that machine's list now: read it before answering, so the window's next read shows it.
    // A card's write reads its Board and its list both: a tag named there may be new, and the merged tags come from the list.
    if (settled.state === "delivered" && kind === "set") await (segments[0] === "cards" ? Promise.all([peer.refreshList(), peer.refreshCards()]) : peer.refreshList());
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
    // Except a linked machine's HTML asset route: its attached page is an opaque origin, as `/api/html-assets/` here.
    if ((req.method === "GET" || req.method === "HEAD") && !isForwardedHtmlAssetPath(path) && !isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
      return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
    }
    const forwarded = FORWARD.exec(path);
    if (forwarded) return forward(req, url, forwarded[1]!, forwarded[2]!, via);
    if (path === "/api/inbox/machines") {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      const machines = machinesView();
      // Each linked machine's last launch read, only for compose, which asks: every other reader of this route skips it.
      if (url.searchParams.get("launch_reads") !== "1") return json({ self: links.selfId, machines });
      return json({ self: links.selfId, machines, launch_reads: launchReads.view(machines.filter((m) => !m.self).map((m) => m.id)) });
    }
    if (path === "/api/inbox/outbox") {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      const machine = url.searchParams.get("machine");
      const waiting = links.list().flatMap((l) => (machine && l.id !== machine ? [] : outbox.list(l.id, "pending").filter((e) => !e.auto)));
      return json({ waiting: waiting.map(outboxView), notices: outbox.notices().map(outboxView) });
    }
    // Cancel a write still waiting that never left (a launch held for a machine that is asleep): it is never sent.
    // Any window's, as the write itself was; a held launch only from a window, as the forward took it.
    const cancel = /^\/api\/inbox\/outbox\/([^/]+)\/cancel$/.exec(path);
    if (cancel) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await context.readBody(req);
      const stale = staleTab(body);
      if (stale) return stale;
      const key = decodePathSegment(cancel[1]!);
      if (key === null) return json({ error: "Bad request.", code: "bad_request" }, 400);
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
      const stale = staleTab(await context.readBody(req));
      if (stale) return stale;
      const key = decodePathSegment(dismiss[1]!);
      if (key === null) return json({ error: "Bad request.", code: "bad_request" }, 400);
      const entry = outbox.dismiss(key);
      if (!entry) return json({ error: "No such write.", code: "not_found" }, 404);
      return json({ entry: outboxView(entry) });
    }
    // The window asked an agent on an older machine to update it (its New message went through the forward, as any
    // compose does): remembered here so that machine's row says so, then Restarting and Updated when it comes back newer.
    const askedMatch = /^\/api\/inbox\/machines\/(ibx_[0-9A-HJKMNP-TV-Z]{26})\/update\/asked$/.exec(path);
    if (askedMatch) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
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
    // Link two computers through a third (inbox-link-through.ts): here two of this Inbox's links (`a`, `c`), or this
    // Inbox with a computer it reaches through one of its links (`via`, `with`). A click in a window only.
    if (path === "/api/inbox/machines/link-through") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await context.readBody(req);
      const stale = staleTab(body);
      if (stale) return stale;
      if (!isWindowRequest(req, body, context.serverSession)) return json(LINK_THROUGH_WINDOW_ONLY, 403);
      const id = (value: unknown) => (isInboxId("ibx", value) ? value : null);
      const via = id(body.via);
      const withId = id(body.with);
      const a = id(body.a);
      const c = id(body.c);
      const answer = via && withId ? linkThrough.askVia(via, withId) : a && c ? linkThrough.linkHere(a, c) : { status: 422, body: { error: "a and c, or via and with: computers' ids.", code: "validation_error" } };
      return json({ ...answer.body, link_through: linkThrough.view() }, answer.status);
    }
    const unlinkMatch = /^\/api\/inbox\/machines\/(ibx_[0-9A-HJKMNP-TV-Z]{26})\/unlink$/.exec(path);
    if (path === "/api/inbox/machines/offer" || path === "/api/inbox/machines/link" || unlinkMatch) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      // This computer's, and its owner's from any of their own devices over the tailnet (owner ruling 2026-11-11).
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
    // `plannotator inbox call fetch_file` of a linked machine's message: its bytes streamed on to the command, which
    // saves them in its own process. Nothing is written here, and a body's other fields (a folder) are not read.
    if (path === "/api/inbox/control/machines/fetch-file") {
      const id = typeof body.message_id === "string" ? body.message_id.trim() : "";
      if (id && context.holds("messages", id)) throw new InboxError("file_is_local", FAR_READ_REFUSALS.fileLocal(id));
      return await agentRead.fetchFile({ message_id: id, file: typeof body.file === "string" ? body.file.trim() : "" }, req.signal);
    }
    if (path === "/api/inbox/control/machines/unlink") {
      const target = typeof body.machine === "string" ? body.machine.trim() : "";
      const record = links.list().find((l) => l.id === target || l.name.toLowerCase() === target.toLowerCase());
      if (!record) throw new InboxError("machine_not_linked", `No linked machine named ${target || "(none)"}.`);
      return json(await unlink(record.id));
    }
    return json({ error: "Not found", code: "not_found" }, 404);
  };

  // ── The merged view (only with machines=1) ──

  // A draft waiting to land on its machine draws the row's Draft mark here (inbox-machine-drafts.ts).
  const rows = (): (InboxListRow & { machine: string })[] => drafts.overlay([...peers.values()].flatMap((peer) => peer.list?.rows ?? []));
  const projects = (): Record<string, unknown>[] => [...peers.values()].flatMap((peer) => peer.list?.projects ?? []);
  /** Each linked machine's agents, as its list last said (kept in memory while it is away, like its rows); none from an older Inbox. */
  const agents = (): InboxAgentsGroup[] => [...peers.values()].flatMap((peer) => (peer.list?.agents ? [peer.list.agents] : []));
  const sessionNames = (): { labels: Record<string, string>; titles: Record<string, string> } => {
    const labels = Object.create(null) as Record<string, string>;
    const titles = Object.create(null) as Record<string, string>;
    for (const peer of peers.values()) {
      if (!peer.list) continue;
      Object.assign(labels, peer.list.session_labels);
      Object.assign(titles, peer.list.session_titles);
    }
    return { labels, titles };
  };
  /** Each linked machine's starred threads, in its own order, from a machine that takes stars from this one. */
  const pinnedIds = (): string[] => [...peers.values()].flatMap((peer) => (peer.list?.marks.includes("star") ? peer.list.pins : []));
  /** Each linked machine's live tags, from a machine that takes tags from this one (an older one's stay its own). */
  const tagLists = (): { machine: string; tags: InboxInitiative[] }[] =>
    [...peers.values()].flatMap((peer) => (peer.list?.marks.includes("tags") ? [{ machine: peer.id, tags: peer.list.tags }] : []));
  /** Each linked machine's "Show tag colors" and own colours, from a machine that takes `tag-colours`. */
  const tagColourLists = (): InboxTagColours[] =>
    [...peers.values()].flatMap((peer) => (peer.list?.marks.includes("tag-colours") && peer.list.tag_colours ? [peer.list.tag_colours] : []));
  /**
   * Each linked machine's Board, from a machine that takes `cards` (an older one's are not listed). The first ask makes
   * each line read its Board and keep it current; it waits for that read only while the machine is online, and at most
   * MERGED_CARDS_WAIT_MS (a slow one's cards follow with `event: cards`).
   */
  const cardLists = async (): Promise<{ machine: string; cards: PeerCards }[]> => {
    const reads = [...peers.values()].map((peer) => {
      const read = peer.wantCards();
      return peer.state === "online" ? read : null;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(reads), new Promise((resolve) => (timer = setTimeout(resolve, MERGED_CARDS_WAIT_MS)))]);
    clearTimeout(timer);
    return [...peers.values()].flatMap((peer) => (peer.cards && peer.list?.marks.includes("cards") ? [{ machine: peer.id, cards: peer.cards }] : []));
  };
  /**
   * Each linked machine's archived page for the list's Archived group (inbox-archived-merged.ts): its first `count`
   * rows, of `project` only from `owner`, the machine that project lives on. Read when a window asks, never before.
   */
  const archivedPages = (count: number, project: string | null, owner: string | null): Promise<FarArchived[]> => {
    const search = `?limit=${Math.min(count, FAR_ARCHIVED_LIMIT_MAX)}${project ? `&project=${encodeURIComponent(project)}` : ""}`;
    return Promise.all([...peers.values()].filter((peer) => !owner || peer.id === owner).map((peer) => peer.archivedPage(search)));
  };
  /** The linked machines whose list takes artifact pins (inbox-artifacts-merged.ts): an older one is never asked. */
  const artifactPeers = () => [...peers.values()].filter((peer) => peer.list?.marks.includes(ARTIFACT_PINS_MARK));
  const artifactPins = {
    /** Each one's pins as its list last said (an asleep machine's from memory). */
    pinLists: () => artifactPeers().map((peer) => ({ machine: peer.id, pins: peer.list!.artifact_pins })),
    /** Each one's Wall page for its own part of the ask, read now while it is online. */
    walls: (searchOf: (machine: string) => string) => Promise.all(artifactPeers().map((peer) => readFarWall(peer, searchOf(peer.id)))),
  };
  /** Each linked machine's "Show archived" switch as its list last said: a save here goes past the newest. */
  const showArchivedCopies = (): InboxShowArchived[] => [...peers.values()].flatMap((peer) => (peer.list?.show_archived ? [peer.list.show_archived] : []));
  /** Each linked machine's saved reaction emoji as its list last said: a save here goes past the newest. */
  const reactionsCopies = (): SharedReactions[] => [...peers.values()].flatMap((peer) => (peer.list?.reactions ? [peer.list.reactions] : []));
  /** A linked machine's card, as its Board last said: the lane marks and a link's site icon are read here for it. */
  const farCard = (id: string): InboxCardWire | null => {
    for (const peer of peers.values()) {
      const card = peer.list?.marks.includes("cards") ? peer.cards?.cards.find((c) => c.id === id) : undefined;
      if (card) return card;
    }
    return null;
  };
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
    /** A linked machine's name, or null when it is not linked. */
    nameOf: (machine: string): string | null => links.get(machine)?.name ?? null,
    /** Every linked machine's id (a Ship tells each of them, inbox-ship-watch.ts `onStart`). */
    linkedIds: (): string[] => links.list().map((link) => link.id),
    machinesView,
    /** Grid was turned on or off here: every link asks its machine again (inbox-peer-link.ts `gridChanged`). */
    gridChanged: () => {
      for (const peer of peers.values()) peer.gridChanged();
      machinesChanged();
    },
    /** This Inbox's door changed by itself (published again once Tailscale ran): the windows hear the machines block. */
    machinesChanged,
    rows,
    /** The Drafts page's rows of linked machines' threads holding unsent work (mark `reply-drafts`), each with its first words. */
    replyDraftRows: () => drafts.rowsFor([...peers.values()], rows()),
    projects,
    agents,
    sessionNames,
    projectOwner,
    pinnedIds,
    tagLists,
    tagColourLists,
    cardLists,
    archivedPages,
    farRoutines,
    /** Pinned artifacts and the Wall on linked machines (mark `artifact-pins`, inbox-artifacts-merged.ts). */
    artifactPins,
    showArchivedCopies,
    reactionsCopies,
    /** Each linked machine's PR board (mark `pulls`), for the merged board (inbox-machine-pulls.ts). */
    pullLists: (refresh: boolean) => {
      const snapshot = machinePulls.start(refresh);
      return () => snapshot().map((entry) => ({ ...entry, name: links.get(entry.machine)?.name }));
    },
    pullLinkedThere: (key: string) => machinePulls.linkedThere(key),
    /** Each linked machine's reported branches (mark `branches`), for Reviews (inbox-machine-branches.ts). */
    branchLists: () => machineBranches.start((machine) => links.get(machine)?.name ?? null),
    /** Each linked machine's merged ships (mark `ships`), as last read: for Reviews' rows kept while Merged shows. */
    mergedShips: () => machineShips.start(),
    farCard,
    snoozeThread,
    /**
     * A write this Inbox makes itself on a linked machine's thread (a Combine's archive there, and its Undo;
     * inbox-combine-far.ts): held in the outbox as the window's writes are, so one queue and one key per write, sent
     * now while that machine is online and when it is back otherwise. Waits up to `waitMs` for its answer. Null when
     * that machine is not linked. `own`: the write it undoes (`follows`), when it stops being worth sending (`send_by`), and
     * whether its refusal is a notice the window shows (`notify`).
     */
    holdWrite: (machine: string, route: string, body: Record<string, unknown>, thread: string | null, waitMs: number, own: { follows?: string; send_by?: string; notify?: boolean; files?: readonly OutboxFile[] } = {}): Promise<OutboxEntry | null> | null => {
      const peer = peers.get(machine);
      if (!peer) return null;
      // Marked as this Inbox's own (`auto`): the window never lists it as the person's waiting write.
      const { entry } = outbox.submit(machine, route, body, thread, false, null, true, own);
      if (peer.state === "online") peer.flush();
      else peer.poke();
      return outbox.waitSettled(entry.key, peer.state === "online" ? waitMs : 0);
    },
    /** Every linked machine's line (a far tag's `@` list, inbox-far-tags.ts). */
    peerLinks: (): PeerLink[] => [...peers.values()],
    /** A held write of this Inbox's own, by its key: how it stands (null: never held). */
    heldWrite: (key: string): OutboxEntry | null => outbox.get(key),
    /** A held write's notice, dismissed: the one who made it was told already (inbox-mcp-far-reply.ts). */
    dismissHeld: (key: string): void => {
      outbox.dismiss(key);
    },
    /** Take back a held write of this Inbox's own that never left (rule 10: one that left stays), or one past its `send_by`. */
    cancelHeld: (key: string): OutboxEntry | null => outbox.cancel(key),
    /** A linked machine's rows as its list last said, or null while this Inbox holds no list of it. */
    listedRows: (machine: string): readonly InboxListRow[] | null => peers.get(machine)?.list?.rows ?? null,
    readThread: agentRead.readThread,
    /** A linked machine's file of a thread its agents read, streamed (a Combine copies the other computer's files in). */
    fetchFile: agentRead.fetchFile,
    /** A piece of a linked machine's file, for a paired cloud agent's fetch_file (inbox-machine-agent-piece.ts). */
    filePiece: agentRead.filePiece,
    /** An agent's search and thread list on every linked machine (inbox-machine-agent-find.ts). */
    agentFind,
    /** The name of the linked machine whose list names `threadId` (send_message's reply_to there is refused in words). */
    farThreadMachine: (threadId: string): string | null => {
      const peer = [...peers.values()].find((p) => p.list?.rows.some((row) => row.thread_id === threadId));
      return peer ? (links.get(peer.id)?.name ?? "A linked machine") : null;
    },
    /** The linked machine a device on this Inbox's door belongs to (a launch it starts here records it), or null. */
    /**
     * The name a forward from the linked machine on this door device records here, for a far read of its agent
     * (inbox-sent-from-reader.ts); none when another linked machine records the same name.
     */
    readerNameOfDevice: (deviceId: string, deviceName: string): string => {
      const all = links.list();
      const record = all.find((l) => l.device_id === deviceId);
      const others = all.filter((l) => l !== record).map((l) => inboxMachineRecordName(l.name, null));
      return inboxFarReaderName(inboxMachineRecordName(record?.name, deviceName), others);
    },
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
    /** This Inbox's links as its list names them to a linked computer (`link_through`, mark `link-through`). */
    linkThroughWire: () => linkThrough.wire(),
    /** A linked computer's stream asked `links=1`: told when those links move. */
    onLinks: (listener: () => void) => {
      linksListeners.add(listener);
      return () => linksListeners.delete(listener);
    },
    /**
     * The three door routes of linking through a third (inbox-link-through.ts), from a linked computer's token:
     * `window`, its word that a press in a window there made it (`X-Plannotator-Window`, believed from a machine only).
     */
    linkThroughDoor: async (route: string, deviceId: string, window: boolean, body: Record<string, unknown>): Promise<Response> => {
      const from = links.list().find((l) => l.device_id === deviceId)?.id ?? null;
      const answer =
        route === LINK_THROUGH_ASK_ROUTE
          ? linkThrough.asked(from, window, body)
          : route === LINK_THROUGH_OFFER_ROUTE
            ? await linkThrough.offerFor(from, window, body)
            : route === LINK_THROUGH_INTRODUCE_ROUTE
              ? await linkThrough.introduce(from, window, body)
              : { status: 404, body: { error: "Not found", code: "not_found" } };
      return json(answer.body, answer.status);
    },
    start,
    stop: () => {
      linkThrough.stop();
      linksListeners.clear();
      stop();
    },
  };
}

export type InboxMachines = ReturnType<typeof createInboxMachines>;
