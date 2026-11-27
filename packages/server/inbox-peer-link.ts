/**
 * Plannotator Inbox: one live link to another machine's Inbox
 * (docs/agent-guides/inbox-machines.md). It dials that Inbox's door through
 * its transport, keeps that machine's list in memory (never on disk: PLAN
 * rule 2 and finding F6), follows its event stream from a cursor, and sends
 * the outbox when the machine is there.
 *
 * States: `connecting` (first dial), `online`, `offline` (asleep, off, or
 * unreachable: since when and why), `needs_update` (its Inbox is too old to
 * link), `revoked` (that machine removed this one: the link stops, rule 17).
 *
 * - Every other failure redials: 250 ms doubling to 30 s, and at once when a
 *   timer fires late (the Mac slept) or the person acts on that machine.
 * - 20 s with no byte on the event stream (the door sends a heartbeat every
 *   15 s) is a dead line, even when TCP says nothing (rule 16).
 * - Its list only moves forward: one fetch in flight at a time, and a list
 *   older (by cursor) than the one held is dropped (rule 5, finding F5).
 * - Records replayed after a reconnect are a resync, not news: they carry
 *   `live: false`, so no notification is raised for them (rule 21).
 * - The outbox is sent when the stream says hello and after any request that
 *   reached the machine (rule 15).
 */

import { inboxTagColoursRead, isInboxId, isInboxInitiativeRecord, isInboxTagLook, type InboxAgentsGroup, type InboxCardWire, type InboxInitiative, type InboxListRow, type InboxTagColours } from "@plannotator/core/inbox-types";
import { inboxPeerAgentsGroup } from "./inbox-agents-list";
import { inboxPeerSessionNames } from "./inbox-session-names";
import type { InboxLinkRecord } from "./inbox-links";
import { MACHINE_WINDOW_HEADER, type InboxOutbox, type OutboxAnswer, type OutboxEntry } from "./inbox-outbox";
import { sendWithFiles } from "./inbox-outbox-files";
import { OUTBOX_FILE_IDLE_MS, OutboxFileLane, type OutboxFileUpload } from "./inbox-outbox-file-lane";
import { INBOX_SENT_FROM_HEADER } from "@plannotator/core/inbox-types";
import type { InboxPeerTransport } from "./inbox-transport";
import { farArchivedPage, type FarArchived } from "./inbox-archived-merged";
import { readShowArchived, type InboxShowArchived } from "./inbox-show-archived";
import { readSharedReactions, type SharedReactions } from "./inbox-reactions-shared";
import { readLinkThroughWire, type LinkThroughWire } from "@plannotator/core/inbox-link-through";
import { readCapabilitySet, type CapabilitySet } from "./inbox-capability-set";
import { readFarArtifactPins } from "./inbox-artifacts-merged";
import type { InboxArtifactPin } from "@plannotator/core/inbox-artifact-pins";

/** How long the Archived group waits for a linked machine's page before it shows the one that machine last gave. */
export const FAR_ARCHIVED_WAIT_MS = 2_000;
/** The asks whose last page is kept per machine (the group's project and how many rows it shows). */
const FAR_ARCHIVED_KEPT = 8;

/** The oldest link protocol this Inbox links to: health's `machine_links`. */
export const MACHINE_LINKS_PROTOCOL = 1;

export type PeerLinkState = "connecting" | "online" | "offline" | "needs_update" | "revoked";

export interface PeerLinkTimings {
  /** Silence on the event stream that counts as a dead line. */
  silenceMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  /** A GET forwarded for the window. */
  requestMs: number;
  /** One outbox try. */
  sendMs: number;
  /** A held answer's file with no byte moving (inbox-outbox-files.ts). */
  fileIdleMs: number;
  /** A held answer's file whose try failed: its first pause before the next (doubled each time, up to `backoffMaxMs`). */
  fileRetryMinMs: number;
  /** How long `deliveries` frames gather before one read of the list: each read is the whole list. */
  deliveriesMs: number;
}

export const PEER_LINK_TIMINGS: PeerLinkTimings = { silenceMs: 20_000, backoffMinMs: 250, backoffMaxMs: 30_000, requestMs: 15_000, sendMs: 15_000, fileIdleMs: OUTBOX_FILE_IDLE_MS, fileRetryMinMs: 1_000, deliveriesMs: 5_000 };

/** A record from the other machine's event stream, as the window's stream passes it on. */
export interface PeerRecord {
  machine: string;
  seq: number;
  /** False for a record replayed after a reconnect (a resync): never a notification. */
  live: boolean;
  record: unknown;
}

/**
 * That machine's events for a change that writes no record there (a snooze, a star, an agent's face or name, a
 * thread's tag): this Inbox asks for each (`<event>=1` on its stream), reads that machine's list again when one comes,
 * and tells its own windows the same event (approval "inbox-linked-marks"). A new mark adds its event here.
 */
export const PEER_REREAD_EVENTS = ["snoozes", "pins", "priority", "agent-faces", "tags", "show-archived", "grid-seen", "artifact-pins", "reactions", "links", "capability-set"] as const;
export type PeerRereadEvent = (typeof PEER_REREAD_EVENTS)[number];
const isRereadEvent = (event: string): event is PeerRereadEvent => (PEER_REREAD_EVENTS as readonly string[]).includes(event);

export interface PeerList {
  cursor: number;
  rows: (InboxListRow & { machine: string })[];
  projects: Record<string, unknown>[];
  /** Its Inbox keeps snoozes (its list says `snoozes: true`; an older one says nothing): only then is Snooze offered on its rows. */
  snoozes: boolean;
  /** The marks it takes from a linked machine (its list's `marks`; none from an older Inbox). */
  marks: string[];
  /** Its starred threads, in its own order (its list's `pins`). */
  pins: string[];
  /** Its live tags (its list's `tags`; none from an Inbox before thread tags), each with its colour from one that keeps them. */
  tags: InboxInitiative[];
  /** Its "Show tag colors" and own colours (its list's `tag_colours`); null from an Inbox before tag colours. */
  tag_colours: InboxTagColours | null;
  /** Its agents (its list's `agents`, capped, with `machine`; inbox-agents-list.ts); null from an older Inbox. */
  agents: InboxAgentsGroup | null;
  session_labels: Record<string, string>;
  session_titles: Record<string, string>;
  /** Its "Show archived" switch (inbox-show-archived.ts); null from an Inbox before it. */
  show_archived: InboxShowArchived | null;
  /** Its saved reaction emoji and their revision (inbox-reactions-shared.ts); null from an Inbox before it. */
  reactions: SharedReactions | null;
  /** Its Capabilities switches with the person's last flip of each (inbox-capability-set.ts); null from an Inbox before it. */
  capability_set: CapabilitySet | null;
  /** The artifacts pinned there (its list's `artifact_pins`, mark `artifact-pins`), in its own order; none from an older Inbox. */
  artifact_pins: InboxArtifactPin[];
  /** The computers it is linked to and the links it is making between them (its list's `link_through`, mark `link-through`); null from an older Inbox. */
  link_through: LinkThroughWire | null;
  /**
   * How far its clock runs ahead of this one's (ms, whole minutes; 0 within two minutes), from its list's `now` as it
   * arrived: Grid measures that machine's quiet time against its own clock. 0 from an Inbox before `now`.
   */
  clock_ms: number;
}

/** A linked machine's clock against this one's, from its list's `now` when that list arrived: whole minutes, 0 within two. */
export function peerClockMs(listNow: unknown, arrived: number): number {
  const at = typeof listNow === "string" ? Date.parse(listNow) : NaN;
  if (!Number.isFinite(at)) return 0;
  const ahead = at - arrived;
  return Math.abs(ahead) < 2 * 60_000 ? 0 : Math.round(ahead / 60_000) * 60_000;
}

/**
 * That machine's Board (its `GET cards`, mark `cards`), kept in memory like its list: its cards, the list rows of
 * their threads, its tags (deleted ones too: a card's history names them), its look and its cursor.
 */
export interface PeerCards {
  cursor: number;
  cards: InboxCardWire[];
  threads: Record<string, (InboxListRow & { machine: string }) | null>;
  initiatives: InboxInitiative[];
  seen_seq: number | null;
}

/** A linked machine's update, picked by name: a version that reads as one, and nothing it could point at (no URL, no command). */
export interface FarUpdate {
  state: "available" | "updating" | "ready" | "failed";
  version: string;
  action: "script" | "copy";
}

const FAR_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

export const farVersion = (value: unknown): string | null => (typeof value === "string" && FAR_VERSION.test(value) ? value : null);

export function parseFarUpdate(value: unknown): FarUpdate | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Json;
  if (v.state !== "available" && v.state !== "updating" && v.state !== "ready" && v.state !== "failed") return null;
  const version = farVersion(v.version);
  if (!version) return null;
  return { state: v.state, version, action: v.action === "script" ? "script" : "copy" };
}

export interface PeerLinkOptions {
  link: InboxLinkRecord;
  transport: InboxPeerTransport;
  outbox: InboxOutbox;
  onRecord: (record: PeerRecord) => void;
  /** State, list or anything else the window draws changed. */
  onChange: () => void;
  /** A no-record change there (`PEER_REREAD_EVENTS`) and its list was read again: the windows hear the same event. */
  onReread?: (event: PeerRereadEvent) => void;
  /** Its Board was read again (`cards`): the windows read the merged Board. */
  onCards?: () => void;
  /**
   * A thread's reply draft changed there (`drafts`, mark `reply-drafts`) and its list was read again for the Draft mark.
   * `refreshed` false: that read failed, so the list held may predate the change.
   */
  onDrafts?: (threadId: string, refreshed: boolean) => void;
  /**
   * That machine's live sessions moved its rows (a delivery, "Session ended") and its list was read again: the windows
   * read theirs. `sessions`: a session ended or came back there; `agents`: its Agents section moved; `labels`: a
   * session's name changed there.
   */
  onDeliveries?: (change: { sessions: boolean; agents: boolean; labels: boolean }) => void;
  /** That machine removed this one (401 device_revoked): the owner of the link cleans up. */
  onRevoked: () => void;
  /** Grid is on here (experimental): only then does this Inbox ask that machine for Grid's fields and looks. */
  gridOn?: () => boolean;
  timings?: Partial<PeerLinkTimings>;
}

type Json = Record<string, any>;

/** No refusal is longer: a far side that answers 401 with more is not read past this. */
const REFUSAL_MAX_BYTES = 64 * 1024;

/** A far answer's body as text, reading no further than `maxBytes`: past that it cancels the stream and answers null. */
export async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    size += value.length;
    if (size > maxBytes) {
      // Not awaited: a clone's cancel settles only once its twin is cancelled too.
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
}

/** The `code` of a door's refusal, if it reads as one. */
async function refusalCode(response: Response): Promise<unknown> {
  try {
    return (JSON.parse((await readCapped(response, REFUSAL_MAX_BYTES)) ?? "null") as Json | null)?.code;
  } catch {
    return undefined;
  }
}

export class PeerLink {
  readonly id: string;
  state: PeerLinkState = "connecting";
  since = Date.now();
  reason: string | null = null;
  version: string | null = null;
  /** Its health's `launch_from_machines` (remote launch): agents can start there (true), launch is off (false), or its Inbox is too old to say (null). */
  launch: boolean | null = null;
  /** Its health's `message_deletions`: its store takes a Delete on a message's words. False until it answered, and for an older Inbox. */
  messageDeletions = false;
  list: PeerList | null = null;
  /**
   * Reads of its list started so far (`listAsked`), and which of them made the list held now (`listGen`; it only moves
   * forward). A list whose read started after something was heard there says what is there now (inbox-machine-drafts.ts).
   */
  listAsked = 0;
  listGen = 0;
  /** Its Board, once a window asked for the merged Board (`wantCards`), and only from a machine whose list takes `cards`. */
  cards: PeerCards | null = null;
  /** That machine's own update answer (its health and its status frames), and whether its door takes `update`. */
  farUpdate: FarUpdate | null = null;
  canUpdate = false;
  selfUpdate = true;
  /** The version an Update there was for, when it ended with no error and no new binary. */
  noChange: string | null = null;
  /** This Inbox pressed Update there and is waiting for it to come back on a new version. In memory: that machine's own state is the truth. */
  asked: { from: string | null; at: number } | null = null;
  /** That machine asked GitHub on a press and answered up to date: the newest version this Inbox knew of then. In memory, like `asked`. */
  saidUpToDate: string | null = null;
  updated: { from: string; to: string; at: number } | null = null;
  /**
   * The person asked an agent on that machine to update it (an older door takes no `update`): the thread it went to
   * (null while the outbox holds it) and the agent's name. In memory, like `asked`; a new version clears it into `updated`.
   */
  agentAsked: { from: string | null; at: number; thread: string | null; agent: string } | null = null;
  private cursor: number | null = null;
  private running = false;
  private stream: AbortController | null = null;
  private wake: (() => void) | null = null;
  private listing: Promise<boolean> | null = null;
  private listAgain = false;
  /** The stream is ended on purpose to ask again for what this Inbox wants (Grid turned on or off): dial at once, still online. */
  private redial = false;
  private cardsWanted = false;
  private cardsReading: Promise<void> | null = null;
  private cardsAgain = false;
  private readonly archived = new Map<string, FarArchived["page"]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private deliveriesTimer: ReturnType<typeof setTimeout> | null = null;
  private deliveriesSessions = false;
  private deliveriesAgents = false;
  private deliveriesLabels = false;
  private flushDelay = 0;
  private readonly t: PeerLinkTimings;
  /** Held answers' files, in their own lane (inbox-outbox-file-lane.ts): nothing in the write queue waits on one. */
  private readonly files: OutboxFileLane;
  private filesTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: PeerLinkOptions) {
    this.id = options.link.id;
    this.t = { ...PEER_LINK_TIMINGS, ...options.timings };
    this.files = new OutboxFileLane({
      outbox: options.outbox,
      machine: options.link.id,
      machineName: () => this.options.link.name,
      upload: (file) => this.uploadFile(file),
      idleMs: this.t.fileIdleMs,
      onChange: () => this.flush(),
      retryMinMs: this.t.fileRetryMinMs,
      retryMaxMs: this.t.backoffMaxMs,
    });
  }

  private get token() {
    return this.options.link.token;
  }

  /** The machine's name as its link says it. */
  get name(): string {
    return this.options.link.name;
  }

  private auth(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  private setState(state: PeerLinkState, reason: string | null = null) {
    if (this.state === state && this.reason === reason) return;
    if (this.state !== state) this.since = Date.now();
    this.state = state;
    this.reason = reason;
    this.options.onChange();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.stream?.abort();
    this.wake?.();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.filesTimer) clearTimeout(this.filesTimer);
    this.filesTimer = null;
    if (this.deliveriesTimer) clearTimeout(this.deliveriesTimer);
    this.deliveriesTimer = null;
  }

  /** That machine's live sessions moved: one read of its list for all that moved in `deliveriesMs`, at its end. */
  private deliveriesMoved(sessions: boolean, agents: boolean, labels: boolean): void {
    this.deliveriesSessions ||= sessions;
    this.deliveriesAgents ||= agents;
    this.deliveriesLabels ||= labels;
    if (this.deliveriesTimer) return;
    this.deliveriesTimer = setTimeout(() => {
      this.deliveriesTimer = null;
      const moved = { sessions: this.deliveriesSessions, agents: this.deliveriesAgents, labels: this.deliveriesLabels };
      this.deliveriesSessions = false;
      this.deliveriesAgents = false;
      this.deliveriesLabels = false;
      void this.refreshList().then(() => this.options.onDeliveries?.(moved));
    }, this.t.deliveriesMs);
    (this.deliveriesTimer as { unref?: () => void }).unref?.();
  }

  /** The person acted on this machine: redial now instead of waiting out the backoff. */
  poke(): void {
    this.wake?.();
  }

  /**
   * Grid was turned on or off here: its list is read again with or without Grid's fields, and its stream asks again
   * with or without `grid-seen` (a quiet redial: the line stays online).
   */
  gridChanged(): void {
    void this.refreshList();
    if (!this.stream) return;
    this.redial = true;
    this.stream.abort();
  }

  // ── The line: health, then the event stream from the cursor; redial with backoff. ──

  private async loop() {
    let backoff = this.t.backoffMinMs;
    while (this.running) {
      const ended = await this.connect().catch((error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!this.running) break;
      if (ended === "revoked") {
        this.running = false;
        this.setState("revoked", "This machine was removed on the other Inbox.");
        this.options.onRevoked();
        break;
      }
      if (ended === "redial") {
        backoff = this.t.backoffMinMs;
        continue;
      }
      if (ended === "online-ended") backoff = this.t.backoffMinMs;
      else if (ended !== "needs_update") this.setState("offline", ended);
      const wait = ended === "needs_update" ? this.t.backoffMaxMs : backoff;
      const late = await this.sleep(wait);
      // A timer that fired far past its time: the computer slept. Dial again at the first pace.
      backoff = late ? this.t.backoffMinMs : Math.min(backoff * 2, this.t.backoffMaxMs);
    }
  }

  /** Waits `ms`, or less when poked. True when it woke much later than asked (the computer slept). */
  private sleep(ms: number): Promise<boolean> {
    const start = Date.now();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve(Date.now() - start > ms * 2 + 1000);
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /** One connection. Answers why it ended. */
  private async connect(): Promise<string> {
    const health = await this.options.transport.request("health", "", { method: "GET", headers: this.auth(), signal: AbortSignal.timeout(this.t.requestMs) });
    const body = (await health.json().catch(() => ({}))) as Json;
    if (health.status === 401 && (body.code === "device_revoked" || body.code === "device_token_invalid")) return "revoked";
    if (!health.ok) return `health answered ${health.status}`;
    const nextVersion = typeof body.version === "string" ? body.version : null;
    this.version = nextVersion;
    this.farUpdate = parseFarUpdate(body.update);
    this.canUpdate = body.machine_update === 1;
    this.selfUpdate = body.self_update !== false;
    this.noChange = farVersion(body.update_no_change);
    if (this.asked && nextVersion) {
      if (this.asked.from && nextVersion !== this.asked.from) {
        this.updated = { from: this.asked.from, to: nextVersion, at: Date.now() };
        this.asked = null;
      } else if (this.farUpdate?.state !== "updating" && this.farUpdate?.state !== "ready") {
        // It came back on the same version with nothing running: this press is over, and its own state says the rest.
        this.asked = null;
      }
    }
    if (this.agentAsked && nextVersion && this.agentAsked.from && nextVersion !== this.agentAsked.from) {
      this.updated = { from: this.agentAsked.from, to: nextVersion, at: Date.now() };
      this.agentAsked = null;
    }
    this.launch = typeof body.launch_from_machines === "number" ? body.launch_from_machines >= 1 : null;
    this.messageDeletions = typeof body.message_deletions === "number" && body.message_deletions >= 1;
    if (body.inbox_id !== this.id) return "a different Inbox answers at this address";
    if (typeof body.machine_links !== "number" || body.machine_links < MACHINE_LINKS_PROTOCOL) {
      this.setState("needs_update", `Update Plannotator on ${this.options.link.name} (it runs ${this.version ?? "an older version"}).`);
      return "needs_update";
    }
    const abort = new AbortController();
    this.stream = abort;
    const headers = this.auth(this.cursor === null ? {} : { "Last-Event-ID": String(this.cursor) });
    // A machine that sleeps between its health answer and this one must not hang the line until TCP gives up:
    // the stream's headers get the same deadline as its silence.
    let headersLate = false;
    const headersTimer = setTimeout(() => {
      headersLate = true;
      abort.abort();
    }, this.t.silenceMs);
    let response: Response;
    try {
      // The reread events, `deliveries=1` and `drafts=1`: none writes a record, so the stream tells this machine when to read the list again.
      // `grid-seen` only while Grid is on here: off, nothing of Grid is asked for.
      const gridOn = this.options.gridOn?.() === true;
      const asks = [...PEER_REREAD_EVENTS.filter((event) => event !== "grid-seen" || gridOn), "deliveries", "drafts"].map((event) => `${event}=1`).join("&");
      response = await this.options.transport.events(headers, this.cursor === null ? `?${asks}` : `?cursor=${this.cursor}&${asks}`, abort.signal);
    } catch (error) {
      if (this.stream === abort) this.stream = null;
      if (headersLate) return `the event stream did not answer for ${Math.round(this.t.silenceMs / 1000)} s`;
      throw error;
    } finally {
      clearTimeout(headersTimer);
    }
    if (response.status === 401) {
      const refused = (await response.json().catch(() => ({}))) as Json;
      if (refused.code === "device_revoked" || refused.code === "device_token_invalid") return "revoked";
    }
    if (!response.ok || !response.body) return `events answered ${response.status}`;
    let lastByte = Date.now();
    let silent = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastByte > this.t.silenceMs) {
        silent = true;
        abort.abort();
      }
    }, Math.min(1000, this.t.silenceMs / 4));
    let helloCursor: number | null = null;
    let wasOnline = false;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        lastByte = Date.now();
        buffer += decoder.decode(chunk, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const parsed = parseFrame(frame);
          if (!parsed) continue;
          if (parsed.event === "hello") {
            const hello = JSON.parse(parsed.data) as Json;
            helloCursor = typeof hello.cursor === "number" ? hello.cursor : 0;
            if (this.cursor === null) this.cursor = helloCursor;
            wasOnline = true;
            this.setState("online");
            void this.refreshList().then(() => this.refreshCards());
            // A file that failed while the line was down goes now, not after its pause.
            this.files.lineBack();
            this.flush();
          } else if (parsed.event === "record" && parsed.id !== null) {
            const seq = Number(parsed.id);
            if (!Number.isSafeInteger(seq)) continue;
            this.cursor = Math.max(this.cursor ?? 0, seq);
            const record = JSON.parse(parsed.data) as Json;
            this.options.onRecord({ machine: this.id, seq, live: helloCursor !== null && seq > helloCursor, record });
            this.refreshList();
            if (record?.kind === "card" || record?.kind === "initiative") void this.refreshCards();
          } else if (parsed.event === "status") {
            // Its update's state, as its own windows hear it. An ending that needs no restart ends this press here.
            const status = JSON.parse(parsed.data) as Json;
            if ("update" in status) {
              this.farUpdate = parseFarUpdate(status.update);
              this.noChange = farVersion(status.update_no_change);
              if (this.asked && (this.farUpdate?.state === "failed" || this.noChange)) this.asked = null;
              this.options.onChange();
            }
          } else if (isRereadEvent(parsed.event)) {
            // The list's cursor does not move, so the windows are told apart from a list that changes it.
            const event = parsed.event;
            void this.refreshList().then(() => this.options.onReread?.(event));
          } else if (parsed.event === "drafts") {
            // A thread's reply draft there: its row's Draft mark is in the list. A compose draft there is its own.
            const change = JSON.parse(parsed.data) as Json;
            const threadId = typeof change.thread_id === "string" ? change.thread_id : null;
            if (threadId) void this.refreshList().then((refreshed) => this.options.onDrafts?.(threadId, refreshed));
          } else if (parsed.event === "deliveries") {
            const change = JSON.parse(parsed.data) as Json;
            this.deliveriesMoved(change.sessions === true, change.agents === true, change.labels === true);
          }
        }
      }
    } catch {
      // Aborted (silence, stop) or the line dropped: the reason is below.
    } finally {
      clearInterval(watchdog);
      if (this.stream === abort) this.stream = null;
    }
    if (silent) return "no heartbeat for 20 s";
    if (this.redial) {
      this.redial = false;
      if (wasOnline && this.running) return "redial";
    }
    return wasOnline ? (this.running ? (this.setState("offline", "the connection closed"), "online-ended") : "stopped") : "the event stream ended";
  }

  // ── The list: one fetch at a time, never backwards (rule 5). ──

  /** True when the last read of this run was taken (a failed read, or one older than the list held, is not). */
  refreshList(): Promise<boolean> {
    if (this.listing) {
      this.listAgain = true;
      return this.listing;
    }
    const run = (async () => {
      let accepted = false;
      do {
        this.listAgain = false;
        accepted = false;
        const asked = ++this.listAsked;
        try {
          // `grid=1` only while Grid is on here: that machine adds Grid's fields to its rows only then.
          const response = await this.options.transport.request("threads", this.options.gridOn?.() === true ? "?grid=1" : "", { method: "GET", headers: this.auth(), signal: AbortSignal.timeout(this.t.requestMs) });
          if (!response.ok) continue;
          accepted = this.acceptList((await response.json()) as Json, asked);
        } catch {
          // The stream's own failure handling marks the line.
        }
      } while (this.listAgain && this.running);
      return accepted;
    })();
    const listing = run.finally(() => {
      this.listing = null;
    });
    this.listing = listing;
    return listing;
  }

  /** Rule 5: a list older than the one held is dropped. `asked`: which read of the list it is (`listAsked`). */
  acceptList(list: Json, asked = ++this.listAsked): boolean {
    const cursor = typeof list.cursor === "number" ? list.cursor : -1;
    if (this.list && cursor < this.list.cursor) return false;
    this.listGen = Math.max(this.listGen, asked);
    const rows = (Array.isArray(list.sections) ? list.sections : []).flatMap((section: Json) => (Array.isArray(section.threads) ? section.threads : []));
    const projects = Array.isArray(list.projects) ? list.projects : [];
    this.list = {
      cursor,
      rows: rows.map((row: InboxListRow) => ({ ...row, machine: this.id })),
      projects: projects.map((project: Json) => ({ ...project, machine: this.id })),
      snoozes: list.snoozes === true,
      marks: Array.isArray(list.marks) ? list.marks.filter((mark: unknown): mark is string => typeof mark === "string") : [],
      pins: Array.isArray(list.pins) ? list.pins.flatMap((row: Json) => (typeof row?.thread_id === "string" ? [row.thread_id] : [])) : [],
      tags: Array.isArray(list.tags)
        ? list.tags
            .filter((tag: unknown): tag is InboxInitiative & { look?: unknown } => isInboxInitiativeRecord(tag) && tag.deleted_at === null)
            // A colour this Inbox cannot read is no colour.
            .map(({ look, ...tag }: InboxInitiative & { look?: unknown }) => (isInboxTagLook(look) ? { ...tag, look } : tag))
        : [],
      tag_colours: inboxTagColoursRead(list.tag_colours),
      agents: inboxPeerAgentsGroup(list.agents, this.id),
      session_labels: inboxPeerSessionNames(list.session_labels),
      session_titles: inboxPeerSessionNames(list.session_titles),
      show_archived: list.show_archived === undefined ? null : readShowArchived(list.show_archived),
      reactions: readSharedReactions(list.reactions),
      capability_set: readCapabilitySet(list.capability_set),
      artifact_pins: readFarArtifactPins(list.artifact_pins),
      link_through: readLinkThroughWire(list.link_through),
      clock_ms: peerClockMs(list.now, Date.now()),
    };
    this.options.onChange();
    return true;
  }

  // ── The Board: read once a window asked for it, then on hello and on each card or tag record; one read at a time. ──

  /** A window asked for the merged Board: this machine's is read now (when its list takes `cards`) and kept current. */
  wantCards(): Promise<void> {
    this.cardsWanted = true;
    return this.cardsReading ?? (this.cards ? Promise.resolve() : this.refreshCards());
  }

  refreshCards(): Promise<void> {
    if (!this.cardsWanted || !this.list?.marks.includes("cards")) return Promise.resolve();
    if (this.cardsReading) {
      this.cardsAgain = true;
      return this.cardsReading;
    }
    const run = (async () => {
      do {
        this.cardsAgain = false;
        try {
          const response = await this.options.transport.request("cards", "", { method: "GET", headers: this.auth(), signal: AbortSignal.timeout(this.t.requestMs) });
          if (response.ok && this.acceptCards((await response.json()) as Json)) this.options.onCards?.();
        } catch {
          // The stream's own failure handling marks the line.
        }
      } while (this.cardsAgain && this.running);
    })();
    this.cardsReading = run.finally(() => {
      this.cardsReading = null;
    });
    return this.cardsReading;
  }

  /** Its Board, picked by name. One older (by cursor) than the one held is dropped, as its list is (rule 5). */
  acceptCards(model: Json): boolean {
    const cursor = typeof model.cursor === "number" ? model.cursor : -1;
    if (this.cards && cursor < this.cards.cursor) return false;
    const threads: PeerCards["threads"] = {};
    if (model.threads && typeof model.threads === "object") {
      for (const [id, row] of Object.entries(model.threads as Json)) {
        if (isInboxId("msg", id)) threads[id] = row && typeof row === "object" ? { ...(row as InboxListRow), machine: this.id } : null;
      }
    }
    this.cards = {
      cursor,
      cards: (Array.isArray(model.cards) ? model.cards : []).filter((card: Json) => isInboxId("crd", card?.id) && isInboxId("prj", card?.project_id)),
      threads,
      initiatives: Array.isArray(model.initiatives) ? model.initiatives.filter((tag: unknown): tag is InboxInitiative => isInboxInitiativeRecord(tag)) : [],
      seen_seq: typeof model.seen_seq === "number" ? model.seen_seq : null,
    };
    return true;
  }

  // ── Its archived threads: read only when a window's Archived group asks, never on a timer. ──

  /**
   * Its archived page for one ask (`?limit=…&project=…`). Online, read now; asleep, slow or failing, the page it last
   * gave for the same ask, marked `away`. A door that predates the route (404) shows nothing.
   */
  async archivedPage(search: string): Promise<FarArchived> {
    const held = this.archived.get(search) ?? null;
    if (this.state !== "online") return { machine: this.id, page: held, away: true };
    try {
      const response = await this.request("threads/archived", search, { method: "GET", headers: {}, timeoutMs: FAR_ARCHIVED_WAIT_MS });
      if (response.status === 404) return { machine: this.id, page: null, away: false };
      if (!response.ok) return { machine: this.id, page: held, away: true };
      const page = farArchivedPage(this.id, await response.json());
      this.archived.delete(search);
      this.archived.set(search, page);
      for (const old of this.archived.keys()) if (this.archived.size > FAR_ARCHIVED_KEPT) this.archived.delete(old);
      return { machine: this.id, page, away: false };
    } catch {
      return { machine: this.id, page: held, away: true };
    }
  }

  // ── Requests for the window, and the outbox. ──

  /**
   * One request to the door, for the window (a GET, or a file sent while the
   * machine is online). Throws when the machine cannot be reached; an answer
   * means it is there, so the outbox goes too (rule 15).
   */
  async request(
    route: string,
    search: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Response> {
    // The time limit runs until the answer's headers arrive, never over its body: a long download or video keeps streaming.
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), init.timeoutMs ?? this.t.requestMs);
    const signal = init.signal ? AbortSignal.any([init.signal, limit.signal]) : limit.signal;
    let response: Response;
    try {
      response = await this.options.transport.request(route, search, { method: init.method, headers: this.auth(init.headers), body: init.body, signal });
    } catch (error) {
      this.poke();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) {
      const code = await refusalCode(response.clone());
      if (code === "device_revoked" || code === "device_token_invalid") this.stream?.abort();
    } else if (this.state !== "online") {
      this.poke();
    } else {
      this.flush();
    }
    return response;
  }

  /** One outbox try: the entry's route and body under its own key (rule 1), a held answer's with its files' ids there. */
  private send = (entry: OutboxEntry): Promise<OutboxAnswer> =>
    sendWithFiles(entry, { post: (body) => this.post(entry, body), forgot: () => this.options.outbox.filesForgotten(entry.key) });

  /** A held answer's file to that machine's `uploads` route, its key in the query as that door takes a file (and as a window's upload there sends one). */
  // Streamed: `fetch` pulls the body as the socket takes it (inbox-outbox-file-wire.test.ts), so the lane's idle limit
  // measures the line. Its Content-Length declared, so that door refuses one too large before a byte is read.
  private uploadFile: OutboxFileUpload = (file) =>
    this.options.transport.request("uploads", `?${new URLSearchParams({ name: file.name, idempotency_key: file.key })}`, {
      method: "POST",
      headers: this.auth({ "Content-Type": "application/octet-stream", "Content-Length": String(file.size) }),
      body: file.body,
      signal: file.signal,
    });


  private post = async (entry: OutboxEntry, sendBody: Record<string, unknown>): Promise<OutboxAnswer> => {
    try {
      const response = await this.options.transport.request(entry.route, "", {
        method: "POST",
        // A press in the person's window here: the other machine's door hands that on (inbox-devices.ts).
        headers: this.auth({ "Content-Type": "application/json", ...(entry.window ? { [MACHINE_WINDOW_HEADER]: "1" } : {}), ...(entry.sent_from ? { [INBOX_SENT_FROM_HEADER]: entry.sent_from } : {}) }),
        body: JSON.stringify(sendBody),
        signal: AbortSignal.timeout(this.t.sendMs),
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body };
    } catch {
      return null;
    }
  };

  /** Send what waits for this machine (rule 15). A 5xx is tried again after a pause; anything else waits for the next hello. */
  flush(): void {
    if (!this.running || this.state !== "online") return;
    // Files go in their own lane; a file whose try failed waits out its own pause there (a run before it ends passes
    // it by), and the lane runs again when the soonest pause ends.
    void this.files.run().then((result) => {
      if (result === "revoked") return this.stream?.abort();
      const wait = this.files.nextTryIn();
      if (wait === null) return;
      if (this.filesTimer) clearTimeout(this.filesTimer);
      this.filesTimer = setTimeout(() => {
        this.filesTimer = null;
        this.flush();
      }, wait);
    });
    void this.options.outbox.drain(this.id, this.send).then((result) => {
      if (result === "server_error") {
        this.flushDelay = Math.min(Math.max(this.flushDelay * 2, 1000), this.t.backoffMaxMs);
        if (!this.flushTimer) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
          }, this.flushDelay);
        }
      } else {
        this.flushDelay = 0;
        if (result === "unreachable") this.stream?.abort();
        if (result === "revoked") this.stream?.abort();
      }
    });
  }
}

function parseFrame(frame: string): { event: string; id: string | null; data: string } | null {
  let event = "message";
  let id: string | null = null;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length === 0) return null;
  return { event, id, data: data.join("\n") };
}
