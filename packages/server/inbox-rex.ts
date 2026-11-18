/**
 * Plannotator Inbox and Rex (superlogical.com/rex), a terminal server with sessions, tabs ("windows") and panes
 * ("blocks"): where an agent lives, what its pane says it is doing, starting agents in Rex and Show in Rex
 * (backnotprop/plannotator#3303).
 *
 *  - Where it lives. A session in a Rex pane says so on its poll (INBOX_PLACE_POLL_FIELD: Rex's ids, a hint). Rex is
 *    asked whether that block exists and sits in a window of that session, and the session's and the tab's names are
 *    read then. A list never waits on Rex: `places` answers from what the last read confirmed and starts the next
 *    read in the background (`onChange` says when it brought something new). The names live in memory only, for a
 *    few seconds; a miss, no Rex, a slow Rex: nothing is shown.
 *  - What it is doing. The same read asks Rex for that confirmed block's program status (OSC 7501, the record a
 *    program in the pane reported: `block.method` `program_status`), and keeps only the root record's `state` and
 *    `kind`: its `title` and `msg` are a program's free text and are never kept. Never another block's, never a
 *    pane's contents, never an event stream (that would carry every pane of the session).
 *  - Start in Rex (the launch backend, inbox-launch.ts). A new agent's command opens in a new tab of a Rex session the
 *    Inbox made for the project, recognised by the id it recorded when it made it (`sessionsFile`), never by its name: the Inbox never
 *    makes a tab in, or changes the active tab of, a session it did not make. The command runs through the person's
 *    login shell (Rex's own `login` option), with the Inbox's login PATH added (Rex's `path_prepend`; a real login profile puts its own first).
 *    A start never moves Rex's app: the tab is made without being selected (`focus: false`, no `session.select`).
 *  - Show in Rex. Rex's app goes to an agent's pane (`session.select`, then `session.focus_block` in a session the
 *    Inbox made: never in one it did not), on the person's click only. It is offered while Rex's app is attached here,
 *    and hidden once that app refused, failed or timed out on one (its Remote Control setting is off) until Rex is
 *    seen without that app (it quit or restarted): the only way to know is the app's own answer to an action, and
 *    nothing asks it in the background or when a menu opens.
 *
 * What it never does: start a Rex server (no `rex` binary: only an existing socket, owned by this user, is connected
 * to), type into a pane, read a pane's contents, list or show sessions that did not connect to the Inbox themselves,
 * write Rex's config, act through an app that is not attached over this computer's own socket. Only on macOS, where
 * the app runs; every failure is "no Rex", silently.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { graphemesOf } from "@plannotator/core/inbox-format";
import type { InboxPlace } from "@plannotator/shared/inbox/connection";
import { connectRex, RexCallError, RexUnavailable, type RexConnection } from "./inbox-rex-socket";

/** The longest a background read (where agents live) may take, connecting included; past it nothing is shown. */
export const INBOX_REX_READ_TIMEOUT_MS = 400;
/** The longest starting in Rex may take to make its tab (it is never retried elsewhere once asked). */
export const INBOX_REX_OPEN_TIMEOUT_MS = 10_000;
/** The longest Show in Rex waits for the app. */
export const INBOX_REX_SHOW_TIMEOUT_MS = 3_000;
/** After a Rex that did not answer in time, how long nothing asks it again. */
export const INBOX_REX_SLOW_BACKOFF_MS = 30_000;
/** How old the last read may be before a list starts another (it still answers from the last one at once). */
export const INBOX_REX_FRESH_MS = 2_000;
/** A status read longer ago than this draws no mark on an icon (stale: today's icon until the next read). */
export const INBOX_REX_MARK_STALE_MS = 15_000;
/** How long Show in Rex stays hidden after the app refused one (Remote Control off), then offered again; Rex's app restarting brings it back at once. */
export const INBOX_REX_SHOW_REFUSED_MS = 60_000;
/** A read connection is closed once nothing used it this long. */
const IDLE_CLOSE_MS = 3_000;
/** The longest a name shown from Rex is, in characters. */
const NAME_MAX = 60;
const TERMINAL_FLAVOR = "com.superlogical.terminal.shell";
const SESSION_ID = /^session:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A program's state in its pane, as Rex keeps it (OSC 7501's root record): only `state` and `kind`, never its free text. */
export interface InboxRexStatus {
  state: "idle" | "working" | "done" | "blocked" | "error";
  /** With `blocked` only: what it waits for. */
  kind?: "permission" | "question" | "auth";
}
const STATUS_STATES = new Set<string>(["idle", "working", "done", "blocked", "error"]);
const STATUS_KINDS = new Set<string>(["permission", "question", "auth"]);

/** `program_status`'s answer: the root record's state and kind (a record with no `id`); null when none or unknown. */
export function inboxRexStatusOf(answer: unknown): InboxRexStatus | null {
  const records = answer && typeof answer === "object" && Array.isArray((answer as { records?: unknown }).records) ? ((answer as { records: unknown[] }).records as Record<string, unknown>[]) : [];
  const root = records.find((r) => r && typeof r === "object" && (r.id === undefined || r.id === null || r.id === ""));
  if (!root || typeof root.state !== "string" || !STATUS_STATES.has(root.state)) return null;
  const state = root.state as InboxRexStatus["state"];
  return state === "blocked" && typeof root.kind === "string" && STATUS_KINDS.has(root.kind) ? { state, kind: root.kind as InboxRexStatus["kind"] } : { state };
}
const statusKey = (status: InboxRexStatus | null | undefined) => (status ? `${status.state}:${status.kind ?? ""}` : "");

/** Where this computer's Rex server listens, on macOS (the app's server); null elsewhere. */
export function inboxRexSocketPath(platform: string, homeDir: string): string | null {
  return platform === "darwin" ? join(homeDir, "Library", "Application Support", "rex", "server.sock") : null;
}

/** A name from Rex as the window may draw it: no control, separator or bidi characters, one line, cut. */
function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, " ").replace(/\s+/g, " ").trim();
  const parts = graphemesOf(text);
  return parts.length > NAME_MAX ? `${parts.slice(0, NAME_MAX - 1).join("").trimEnd()}…` : text;
}

/** "Rex · <session> / <tab>", with what Rex names. */
export function inboxRexLine(session: string, tab: string): string {
  return session && tab ? `Rex · ${session} / ${tab}` : session || tab ? `Rex · ${session || tab}` : "Rex";
}

type Resolved = { status?: unknown; target?: Record<string, unknown> | null };
const resultsOf = (answer: Record<string, unknown>): Resolved[] => (Array.isArray(answer.results) ? (answer.results as Resolved[]) : []);
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The socket is a socket (not a link to one, not a file) and this user's own. */
export function inboxRexSocketOk(path: string, uid: number | null): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isSocket() && (uid === null || stat.uid === uid);
  } catch {
    return false;
  }
}

/**
 * Rex sessions the Inbox made for agents it started in Rex, by project: their ids and the label the Inbox gave them. Only these
 * ever get a tab from it, and only while Rex still names them so: a session the person renamed is theirs now.
 */
type KeptSession = { id: string; label: string };
function sessionsKept(file: string | null) {
  let memory: Record<string, KeptSession> = {};
  if (file) {
    try {
      const read = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; sessions?: Record<string, unknown> };
      for (const [key, kept] of Object.entries(read.sessions ?? {})) {
        const { id, label } = (kept ?? {}) as { id?: unknown; label?: unknown };
        if (typeof id === "string" && SESSION_ID.test(id) && typeof label === "string") memory[key] = { id, label };
      }
    } catch {
      memory = {};
    }
  }
  const save = () => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 2, sessions: memory }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // Memory still has it for this run.
    }
  };
  return {
    of: (project: string): KeptSession | null => memory[project] ?? null,
    set(project: string, session: KeptSession) {
      memory = { ...memory, [project]: session };
      save();
    },
    forget(project: string) {
      if (!(project in memory)) return;
      const { [project]: _gone, ...rest } = memory;
      memory = rest;
      save();
    },
  };
}

export interface InboxRexOptions {
  /** This computer's Rex socket (`inboxRexSocketPath`); null: no Rex here. */
  socketPath: string | null;
  /** This user's id: the socket and the app's connection must be this user's. Default: the process's own. */
  uid?: number | null;
  readTimeoutMs?: number;
  openTimeoutMs?: number;
  showTimeoutMs?: number;
  /** How long a refused Show stays hidden (INBOX_REX_SHOW_REFUSED_MS; tests shorten it). */
  showRefusedMs?: number;
  now?: () => number;
  /** Said in the hello. */
  version?: string;
  /** Where the ids of the Rex sessions the Inbox made are kept, by project. Null: this run's memory only. */
  sessionsFile?: string | null;
  /** A background read changed what the list would show (a place line, the app attached or gone). */
  onChange?: () => void;
}

/**
 * What a start in Rex did. `sent`: the tab was asked for and no answer came (a timeout, a dropped connection), so it
 * may exist: the agent must not start elsewhere as well. `refused`: Rex answered the ask with an error, so it made
 * nothing (an option this Rex does not take, Remote Control off): the agent starts in the background.
 */
export type InboxRexOpened = { opened: true; session: string; window: string; block: string | null; line: string } | { opened: false; sent: boolean; refused?: true };

export type InboxRex = ReturnType<typeof createInboxRex>;

/** The first block id in a Rex answer's `block_ids` (the pane a new window starts with), or null. */
function firstBlock(ids: unknown): string | null {
  const first = Array.isArray(ids) ? ids[0] : null;
  return typeof first === "string" && first.length > 0 && first.length <= 200 ? first : null;
}

export function createInboxRex(options: InboxRexOptions) {
  const now = options.now ?? Date.now;
  const uid = options.uid !== undefined ? options.uid : (process.getuid?.() ?? null);
  const readTimeout = options.readTimeoutMs ?? INBOX_REX_READ_TIMEOUT_MS;
  const openTimeout = options.openTimeoutMs ?? INBOX_REX_OPEN_TIMEOUT_MS;
  const showTimeout = options.showTimeoutMs ?? INBOX_REX_SHOW_TIMEOUT_MS;
  const showRefused = options.showRefusedMs ?? INBOX_REX_SHOW_REFUSED_MS;
  const kept = sessionsKept(options.sessionsFile ?? null);
  const socketPath = () => (options.socketPath && inboxRexSocketOk(options.socketPath, uid) ? options.socketPath : null);

  /** No asking before this (a Rex that did not answer in time). */
  let quietUntil = 0;
  /** What the last reads confirmed: each hinted session's place and line, and the app attached here. */
  const confirmed = new Map<string, { place: InboxPlace; line: string; status: InboxRexStatus | null; at: number }>();
  let app: { id: string | null; at: number } = { id: null, at: 0 };
  /**
   * The app that last refused (or failed or timed out on) a Show, and when: Show in Rex is hidden for it for
   * `showRefused`, or until its app goes and comes back or does a Show again. A new tab or a closed pane
   * says nothing of it: those are Rex's server's, which takes them with Remote Control off too.
   */
  let refusedShow: { app: string; at: number } | null = null;
  let showBack: ReturnType<typeof setTimeout> | null = null;
  const jumped = (appId: string, ok: boolean) => {
    const next = ok ? null : { app: appId, at: now() };
    if (!next && !refusedShow) return;
    refusedShow = next;
    if (showBack) clearTimeout(showBack);
    showBack = null;
    if (next) {
      // The windows hear when it is offered again (nothing else may change meanwhile).
      showBack = setTimeout(() => {
        showBack = null;
        changed();
      }, showRefused + 50);
      (showBack as { unref?: () => void }).unref?.();
    }
    changed();
  };
  /** One start at a time per project: two Sends never make two sessions for it (the second waits for the first's). */
  const opening = new Map<string, Promise<unknown>>();
  let lastRead = 0;
  let lastKey = "";
  let lastHints: ReadonlyMap<string, InboxPlace> = new Map();
  let reading: Promise<void> | null = null;
  /** Bumped whenever what the list shows from Rex changes (the delivery watch compares it). */
  let version = 0;
  const changed = () => {
    version++;
    options.onChange?.();
  };

  /** One read connection, reused while reads come, closed once idle. */
  let reader: Promise<RexConnection> | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const dropReader = () => {
    const was = reader;
    reader = null;
    if (idle) clearTimeout(idle);
    idle = null;
    void was?.then((c) => c.close()).catch(() => undefined);
  };
  const readConnection = (): Promise<RexConnection> => {
    const path = socketPath();
    if (!path) return Promise.reject(new RexUnavailable("no Rex here"));
    reader ??= connectRex(path, { timeoutMs: readTimeout, version: options.version });
    const mine = reader;
    mine.catch(() => {
      if (reader === mine) reader = null;
    });
    return mine;
  };
  const keepReader = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(dropReader, IDLE_CLOSE_MS);
    (idle as { unref?: () => void }).unref?.();
  };

  /** Run `work` on the read connection within the read deadline; null on any failure (and a slow Rex is left alone a while). */
  const read = async <T>(work: (rex: RexConnection) => Promise<T>): Promise<T | null> => {
    if (!options.socketPath || now() < quietUntil) return null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), readTimeout);
    });
    try {
      const answer = await Promise.race([readConnection().then(work), late]);
      if (answer === "late") {
        quietUntil = now() + INBOX_REX_SLOW_BACKOFF_MS;
        dropReader();
        return null;
      }
      keepReader();
      return answer as T;
    } catch {
      dropReader();
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** A connection of its own (an action may attach to a session), closed after; `work` gets it and its deadline. */
  const act = async <T>(timeoutMs: number, work: (rex: RexConnection) => Promise<T>): Promise<T | null> => {
    const path = socketPath();
    if (!path) return null;
    let rex: RexConnection | null = null;
    try {
      rex = await connectRex(path, { timeoutMs, version: options.version });
      return await work(rex);
    } catch {
      return null;
    } finally {
      rex?.close();
    }
  };

  /** A call that gives up after `ms` (the connection is closed by the caller). */
  const within = <T>(ms: number, call: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RexUnavailable("late")), ms);
      call.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (cause) => {
          clearTimeout(timer);
          reject(cause);
        },
      );
    });

  /**
   * Rex's app attached here: its client id. Exactly one Mac app, connected over this computer's own socket as this
   * user (`principal`: peer, unix, this uid). An app on another computer (a tailnet connection) is never one.
   */
  const appOf = async (rex: RexConnection): Promise<string | null> => {
    const answer = await rex.call("client.list", { kinds: ["app"] });
    const clients = (Array.isArray(answer.clients) ? answer.clients : []) as Record<string, unknown>[];
    const here = clients.filter((c) => {
      const info = (c.info ?? {}) as Record<string, unknown>;
      const principal = (c.principal ?? {}) as Record<string, unknown>;
      const state = c.connection_state;
      return (
        typeof c.client_id === "string" &&
        info.kind === "app" &&
        info.platform === "macos" &&
        (state === undefined || state === "connected") &&
        principal.kind === "peer" &&
        principal.transport === "unix" &&
        (uid === null || principal.uid === uid)
      );
    });
    return here.length === 1 ? (here[0]!.client_id as string) : null;
  };

  /** Where `place`'s block is now: its window, when it sits in one of that session's windows; null otherwise. */
  const windowOf = async (rex: RexConnection, place: InboxPlace): Promise<string | null> => {
    const answer = await rex.call("target.resolve", { kinds: ["block"], queries: [place.block], scope: { session: place.session } });
    const result = resultsOf(answer)[0];
    const target = result?.status === "resolved" ? result.target : null;
    if (!target || target.kind !== "block" || target.block_id !== place.block || target.session_id !== place.session) return null;
    return text(target.window_id) || null;
  };

  /** One read: the hinted places Rex confirms, with names, and the app attached here. */
  const readNow = async (hints: ReadonlyMap<string, InboxPlace>) => {
    const found = await read(async (rex) => {
      const bySession = new Map<string, { session: string; place: InboxPlace }[]>();
      for (const [session, place] of hints) bySession.set(place.session, [...(bySession.get(place.session) ?? []), { session, place }]);
      const rows: { session: string; place: InboxPlace; window: string }[] = [];
      const windowNames = new Map<string, string>();
      for (const [rexSession, entries] of bySession) {
        const results = resultsOf(await rex.call("target.resolve", { kinds: ["block"], queries: entries.map((e) => e.place.block), scope: { session: rexSession } }));
        const mine: typeof rows = [];
        entries.forEach((e, i) => {
          const target = results[i]?.status === "resolved" ? results[i]!.target : null;
          const window = target && target.kind === "block" && target.block_id === e.place.block && target.session_id === rexSession ? text(target.window_id) : "";
          if (window) mine.push({ ...e, window });
        });
        rows.push(...mine);
        const windows = [...new Set(mine.map((r) => r.window))];
        if (windows.length === 0) continue;
        const named = resultsOf(await rex.call("target.resolve", { kinds: ["window"], queries: windows, scope: { session: rexSession } }));
        windows.forEach((w, i) => windowNames.set(w, named[i]?.status === "resolved" ? cleanName(named[i]!.target?.label) : ""));
      }
      const sessions = [...new Set(rows.map((r) => r.place.session))];
      const named = sessions.length ? resultsOf(await rex.call("target.resolve", { kinds: ["session"], queries: sessions })) : [];
      const sessionNames = new Map(sessions.map((s, i) => [s, named[i]?.status === "resolved" && named[i]!.target?.session_id === s ? cleanName(named[i]!.target?.label) : ""]));
      // Each confirmed block's own status record, read together; one that fails is no status (never an attach).
      const statuses = await Promise.all(
        rows.map((r) =>
          rex.call("block.method", { session_id: r.place.session, block_id: r.place.block, method: "program_status" }).then(
            (answer) => inboxRexStatusOf(answer),
            () => null,
          ),
        ),
      );
      return { rows, statuses, sessionNames, windowNames, app: await appOf(rex) };
    });
    const at = now();
    lastRead = at;
    let moved = false;
    if (!found) {
      // No answer (no Rex, a slow one): nothing confirmed stands, and an app that may be gone is not acted on.
      if (app.id !== null || confirmed.size > 0) moved = true;
      confirmed.clear();
      app = { id: null, at };
    } else {
      const lines = new Map(found.rows.map((r, i) => [r.session, { place: r.place, status: found.statuses[i] ?? null, line: inboxRexLine(found.sessionNames.get(r.place.session) ?? "", found.windowNames.get(r.window) ?? "") }]));
      for (const session of hints.keys()) {
        const next = lines.get(session);
        const was = confirmed.get(session);
        if (!next) {
          if (was) moved = true;
          confirmed.delete(session);
        } else {
          if (!was || was.line !== next.line || was.place.block !== next.place.block || statusKey(was.status) !== statusKey(next.status)) moved = true;
          // A status gone stale (no mark drawn) is fresh again: the marks come back.
          else if (next.status && at - was.at > INBOX_REX_MARK_STALE_MS) moved = true;
          confirmed.set(session, { ...next, at });
        }
      }
      if (found.app !== app.id) moved = true;
      app = { id: found.app, at };
      // Rex answered with no app, or another one (it went and came back): a Show it refused may be offered again.
      if (refusedShow && found.app !== refusedShow.app) refusedShow = null;
    }
    if (moved) changed();
  };

  /** Start a read when the last one is stale or asked about other places; never more than one at a time. */
  const refresh = (hints: ReadonlyMap<string, InboxPlace>) => {
    const key = [...hints].map(([s, p]) => `${s}=${p.session}/${p.block}`).sort().join(",");
    if (reading || (key === lastKey && now() - lastRead < INBOX_REX_FRESH_MS)) return;
    lastKey = key;
    lastHints = hints;
    reading = readNow(hints)
      .catch(() => undefined)
      .finally(() => {
        reading = null;
      });
  };

  /** `open`'s work, one project at a time. */
  const openNow = async (request: { project: string; projectKey: string; tab: string; command: string; pathPrepend?: readonly string[] }): Promise<InboxRexOpened> => {
    const project = cleanName(request.project).slice(0, 128) || "Plannotator";
    const tab = cleanName(request.tab).slice(0, 128);
    let sent = false;
    const result = await act(openTimeout, async (rex): Promise<InboxRexOpened> => {
      const appId = await within(openTimeout, appOf(rex));
      if (!appId) return { opened: false, sent: false };
      const layout = {
        block: {
          flavor: TERMINAL_FLAVOR,
          // The person's own shell as a login shell reads their profile; the Inbox's PATH is added (the profile's comes first).
          options: { command: ["/bin/sh", "-c", request.command], login: true, ...(request.pathPrepend?.length ? { path_prepend: [...request.pathPrepend] } : {}) },
        },
      };
      // The session the Inbox made for this project, by the id it kept (never one found by its name), while Rex
      // still names it as the Inbox did: renamed, it is the person's now, and the Inbox makes another.
      // Rex's own "no" to an ask (an error answer, not a timeout or a dropped connection): it made nothing.
      const refusedBy = (error: unknown): InboxRexOpened => {
        if (error instanceof RexCallError) return { opened: false, sent: false, refused: true };
        throw error;
      };
      const keptOne = kept.of(request.projectKey);
      let own: string | null = null;
      let ownLabel = project;
      if (keptOne) {
        let resolved: Record<string, unknown>;
        try {
          resolved = await within(openTimeout, rex.call("target.resolve", { kinds: ["session"], queries: [keptOne.id] }));
        } catch (error) {
          return refusedBy(error);
        }
        const result = resultsOf(resolved)[0];
        if (result?.status === "resolved" && result.target?.session_id === keptOne.id && result.target?.label === keptOne.label) {
          own = keptOne.id;
          ownLabel = cleanName(keptOne.label) || project;
        } else kept.forget(request.projectKey);
      }
      let session: string;
      let window: string;
      let block: string | null = null;
      if (own) {
        try {
          await within(openTimeout, rex.call("session.attach", { session_id: own }));
        } catch (error) {
          return refusedBy(error);
        }
        sent = true;
        let made: Record<string, unknown>;
        try {
          made = await within(openTimeout, rex.call("session.new_window", { session_id: own, ...(tab ? { window_label: tab } : {}), layout, focus: false }));
        } catch (error) {
          return refusedBy(error);
        }
        session = own;
        window = text(made.window_id);
        block = firstBlock(made.block_ids);
      } else {
        sent = true;
        let made: Record<string, unknown>;
        try {
          made = await within(openTimeout, rex.call("session.create", { label: project, initial_windows: [{ ...(tab ? { window_label: tab } : {}), layout }] }));
        } catch (error) {
          return refusedBy(error);
        }
        session = text(made.session_id);
        const first = (made.initial_windows as { window_id?: unknown; block_ids?: unknown }[] | undefined)?.[0];
        window = text(first?.window_id);
        block = firstBlock(first?.block_ids);
        if (SESSION_ID.test(session)) kept.set(request.projectKey, { id: session, label: project });
      }
      if (!session || !window) return { opened: false, sent: true };
      return { opened: true, session, window, block, line: inboxRexLine(ownLabel, tab) };
    });
    return result ?? { opened: false, sent };
  };

  // The last read's answer stands until the next read replaces it (a list read after a quiet spell starts that read:
  // a time limit here would drop the line for that one read).
  const appHere = () => app.id;

  return {
    /**
     * The places Rex confirmed for these hints, by session (one line each), from the last read: answered at once,
     * never waiting on Rex. A stale or different ask starts the next read in the background.
     */
    places(hints: ReadonlyMap<string, InboxPlace>): Map<string, string> {
      // Nothing to ask about: Rex is not contacted at all.
      if (hints.size === 0) return new Map();
      refresh(hints);
      const out = new Map<string, string>();
      for (const [session, place] of hints) {
        const known = confirmed.get(session);
        if (known && known.place.session === place.session && known.place.block === place.block) out.set(session, known.line);
      }
      return out;
    },

    /** What each of these sessions' confirmed panes says it is doing (its status record), from the last read; no read starts. */
    statuses(hints: ReadonlyMap<string, InboxPlace>): Map<string, InboxRexStatus> {
      const out = new Map<string, InboxRexStatus>();
      for (const [session, place] of hints) {
        const known = confirmed.get(session);
        if (known?.status && known.place.session === place.session && known.place.block === place.block) out.set(session, known.status);
      }
      return out;
    },

    /** Like `statuses`, but only those read in the last INBOX_REX_MARK_STALE_MS (an icon's mark is never stale). */
    freshStatuses(hints: ReadonlyMap<string, InboxPlace>): Map<string, InboxRexStatus> {
      const out = new Map<string, InboxRexStatus>();
      const cutoff = now() - INBOX_REX_MARK_STALE_MS;
      for (const [session, place] of hints) {
        const known = confirmed.get(session);
        if (known?.status && known.at >= cutoff && known.place.session === place.session && known.place.block === place.block) out.set(session, known.status);
      }
      return out;
    },

    /** Keep these places fresh while a window watches (the delivery watch's tick): a read when the last is stale. */
    watch(hints: ReadonlyMap<string, InboxPlace>): void {
      if (hints.size > 0) refresh(hints);
    },

    /** Rex's app is attached here over this computer's own socket (as the last read said); starts a read when stale. */
    appAttached(): boolean {
      refresh(lastHints);
      return appHere() !== null;
    },

    /**
     * The same, for this computer's Settings → Agents: a read older than a couple of seconds is made again first and
     * waited for (bounded by the read timeout), so the first answer after the Inbox starts is right, not the empty one.
     */
    async appAttachedNow(): Promise<boolean> {
      refresh(lastHints);
      if (reading) await reading;
      return appHere() !== null;
    },

    /** Show in Rex may be offered: Rex's app is attached here, and it has not refused a Show in the last minute. */
    offersShow(): boolean {
      const id = appHere();
      return id !== null && !(refusedShow && refusedShow.app === id && now() - refusedShow.at < showRefused);
    },

    /**
     * Whether the pane `place` names is gone from Rex (Rex answered, and has no such block in that session): a reply
     * may start its agent again without waiting. False: it is there. Null: no answer (no Rex, a slow one).
     */
    async paneGone(place: InboxPlace): Promise<boolean | null> {
      const answer = await read((rex) => rex.call("target.resolve", { kinds: ["block"], queries: [place.block], scope: { session: place.session } }));
      if (!answer) return null;
      const result = resultsOf(answer)[0];
      if (!result) return null;
      if (result.status === "not_found") return true;
      return result.status === "resolved" && result.target?.block_id === place.block ? false : null;
    },

    /**
     * Stop: close the pane `place` names, which ends the program in it (Rex hangs it up, as closing a terminal does).
     * True once Rex closed it or has no such pane any more; false when Rex is not here or did not do it.
     */
    async closePane(place: InboxPlace): Promise<boolean> {
      const closed = await act(showTimeout, async (rex) => {
        try {
          await within(showTimeout, rex.call("block.close", { session_id: place.session, block_id: place.block }));
          return true;
        } catch (error) {
          // Already gone (closed by hand, or the session went): nothing runs there.
          if (error instanceof RexCallError && (error.code === "not_found" || error.code === "session_not_found")) return true;
          throw error;
        }
      });
      return closed === true;
    },

    /** What the list's Rex part depends on (the delivery watch says `agents` when it moves). */
    version: () => version,

    /** Wait for the read under way (tests). */
    settled: async () => {
      while (reading) await reading;
    },

    /**
     * Open `command` in a new tab named `tab` of the Rex session the Inbox made for `projectKey` (made now, labelled
     * `project`, when it has none, that one is gone, or the person renamed it). Runs through the person's login shell,
     * with `pathPrepend` first on its PATH. Rex's app is never moved to it (no select, `focus: false`). `sent: true`
     * on a failure means the tab may exist: the caller opens nothing else; `refused`: Rex said no and made nothing.
     */
    async open(request: { project: string; projectKey: string; tab: string; command: string; pathPrepend?: readonly string[] }): Promise<InboxRexOpened> {
      // One at a time per project: a second Send waits, then finds the session the first made.
      const before = opening.get(request.projectKey) ?? Promise.resolve();
      const mine = before.then(() => openNow(request));
      const settled = mine.catch(() => undefined);
      opening.set(request.projectKey, settled);
      void settled.then(() => {
        if (opening.get(request.projectKey) === settled) opening.delete(request.projectKey);
      });
      return mine;
    },

    /**
     * Have Rex's app go to `place`'s pane, on the person's click. `shown` only for the app's confirmed success
     * (`performed_by` is that app). `refused`: the app was asked and did not (said no, failed, timed out or answered
     * in another shape): Show in Rex is hidden for a minute, or until Rex's app goes and comes back. Otherwise the pane
     * or the app is gone. In the session, the pane itself gets the focus (best effort).
     */
    async show(place: InboxPlace): Promise<{ shown: boolean; refused?: true }> {
      const outcome = await act(showTimeout, async (rex) => {
        const window = await within(showTimeout, windowOf(rex, place));
        const appId = window ? await within(showTimeout, appOf(rex)) : null;
        if (!window || !appId) return { shown: false, app: null as string | null };
        let answer: Record<string, unknown> | null = null;
        try {
          answer = await within(showTimeout, rex.call("client.perform", { client_id: appId, action: "session.select", args: { session_id: place.session, window_id: window }, origin: "api", timeout_ms: Math.max(500, showTimeout - 500) }));
        } catch {
          answer = null;
        }
        if (!answer || answer.performed_by !== appId) return { shown: false, app: appId };
        // The pane itself, in a tab of several: best effort, the app already went there.
        try {
          await within(1_500, rex.call("session.attach", { session_id: place.session }));
          await within(1_500, rex.call("session.focus_block", { session_id: place.session, block_id: place.block }));
        } catch {
          // Shown all the same.
        }
        return { shown: true, app: appId };
      });
      if (outcome?.app) jumped(outcome.app, outcome.shown);
      return outcome?.shown ? { shown: true } : outcome?.app ? { shown: false, refused: true } : { shown: false };
    },

    /** Close what is open (the Inbox stops). */
    close(): void {
      dropReader();
      if (showBack) clearTimeout(showBack);
    },
  };
}
