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

import type { InboxListRow } from "@plannotator/core/inbox-types";
import type { InboxLinkRecord } from "./inbox-links";
import type { InboxOutbox, OutboxAnswer, OutboxEntry } from "./inbox-outbox";
import type { InboxPeerTransport } from "./inbox-transport";

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
}

export const PEER_LINK_TIMINGS: PeerLinkTimings = { silenceMs: 20_000, backoffMinMs: 250, backoffMaxMs: 30_000, requestMs: 15_000, sendMs: 15_000 };

/** A record from the other machine's event stream, as the window's stream passes it on. */
export interface PeerRecord {
  machine: string;
  seq: number;
  /** False for a record replayed after a reconnect (a resync): never a notification. */
  live: boolean;
  record: unknown;
}

export interface PeerList {
  cursor: number;
  rows: (InboxListRow & { machine: string })[];
  projects: Record<string, unknown>[];
}

export interface PeerLinkOptions {
  link: InboxLinkRecord;
  transport: InboxPeerTransport;
  outbox: InboxOutbox;
  onRecord: (record: PeerRecord) => void;
  /** State, list or anything else the window draws changed. */
  onChange: () => void;
  /** That machine's snoozes changed and its list was read again: the windows read theirs. */
  onSnoozes?: () => void;
  /** That machine removed this one (401 device_revoked): the owner of the link cleans up. */
  onRevoked: () => void;
  timings?: Partial<PeerLinkTimings>;
}

type Json = Record<string, any>;

export class PeerLink {
  readonly id: string;
  state: PeerLinkState = "connecting";
  since = Date.now();
  reason: string | null = null;
  version: string | null = null;
  list: PeerList | null = null;
  private cursor: number | null = null;
  private running = false;
  private stream: AbortController | null = null;
  private wake: (() => void) | null = null;
  private listing: Promise<void> | null = null;
  private listAgain = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDelay = 0;
  private readonly t: PeerLinkTimings;

  constructor(private readonly options: PeerLinkOptions) {
    this.id = options.link.id;
    this.t = { ...PEER_LINK_TIMINGS, ...options.timings };
  }

  private get token() {
    return this.options.link.token;
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
  }

  /** The person acted on this machine: redial now instead of waiting out the backoff. */
  poke(): void {
    this.wake?.();
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
    this.version = typeof body.version === "string" ? body.version : null;
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
      // `snoozes=1`: a snooze writes no record, so the stream tells this machine when to read the list again.
      response = await this.options.transport.events(headers, this.cursor === null ? "?snoozes=1" : `?cursor=${this.cursor}&snoozes=1`, abort.signal);
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
            this.refreshList();
            this.flush();
          } else if (parsed.event === "record" && parsed.id !== null) {
            const seq = Number(parsed.id);
            if (!Number.isSafeInteger(seq)) continue;
            this.cursor = Math.max(this.cursor ?? 0, seq);
            this.options.onRecord({ machine: this.id, seq, live: helloCursor !== null && seq > helloCursor, record: JSON.parse(parsed.data) });
            this.refreshList();
          } else if (parsed.event === "snoozes") {
            // The list's cursor does not move, so the windows are told apart from a list that changes it.
            void this.refreshList().then(() => this.options.onSnoozes?.());
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
    return wasOnline ? (this.running ? (this.setState("offline", "the connection closed"), "online-ended") : "stopped") : "the event stream ended";
  }

  // ── The list: one fetch at a time, never backwards (rule 5). ──

  refreshList(): Promise<void> {
    if (this.listing) {
      this.listAgain = true;
      return this.listing;
    }
    const run = (async () => {
      do {
        this.listAgain = false;
        try {
          const response = await this.options.transport.request("threads", "", { method: "GET", headers: this.auth(), signal: AbortSignal.timeout(this.t.requestMs) });
          if (!response.ok) continue;
          this.acceptList((await response.json()) as Json);
        } catch {
          // The stream's own failure handling marks the line.
        }
      } while (this.listAgain && this.running);
    })();
    this.listing = run.finally(() => {
      this.listing = null;
    });
    return this.listing;
  }

  /** Rule 5: a list older than the one held is dropped. */
  acceptList(list: Json): boolean {
    const cursor = typeof list.cursor === "number" ? list.cursor : -1;
    if (this.list && cursor < this.list.cursor) return false;
    const rows = (Array.isArray(list.sections) ? list.sections : []).flatMap((section: Json) => (Array.isArray(section.threads) ? section.threads : []));
    const projects = Array.isArray(list.projects) ? list.projects : [];
    this.list = {
      cursor,
      rows: rows.map((row: InboxListRow) => ({ ...row, machine: this.id })),
      projects: projects.map((project: Json) => ({ ...project, machine: this.id })),
    };
    this.options.onChange();
    return true;
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
      const copy = (await response.clone().json().catch(() => ({}))) as Json;
      if (copy.code === "device_revoked" || copy.code === "device_token_invalid") this.stream?.abort();
    } else if (this.state !== "online") {
      this.poke();
    } else {
      this.flush();
    }
    return response;
  }

  /** One outbox try: the entry's route and body under its own key (rule 1). */
  private send = async (entry: OutboxEntry): Promise<OutboxAnswer> => {
    try {
      const response = await this.options.transport.request(entry.route, "", {
        method: "POST",
        headers: this.auth({ "Content-Type": "application/json" }),
        body: JSON.stringify(entry.body),
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
