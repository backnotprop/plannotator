/**
 * Plannotator Inbox and Rex (superlogical.com/rex), a terminal server with sessions, tabs ("windows") and panes
 * ("blocks"): where an agent lives, Open in Rex and Show in Rex (backnotprop/plannotator#3303).
 *
 *  - Where it lives. A session in a Rex pane says so on its poll (INBOX_PLACE_POLL_FIELD: Rex's ids, a hint). Before
 *    anything is shown, `places` asks this computer's Rex whether that block exists and sits in a window of that
 *    session, and reads the session's and the tab's names then, for that answer only: they are never kept. A miss, no
 *    Rex, a slow Rex: nothing is shown.
 *  - Open in Rex. A launched session's Open in Terminal opens its attach command in a new Rex tab, in the Rex session
 *    named for the project (made when there is none), when Rex is where the person works: Rex's app is attached to
 *    its server here. Otherwise the caller opens Terminal as before.
 *  - Show in Rex. Rex's app goes to an agent's pane (`session.select`, then `session.focus_block`). Offered only while
 *    the app performs actions for other programs (its Remote Control setting): `remoteOn` is the last answer the app
 *    gave, kept for a minute.
 *
 * What it never does: start a Rex server (no `rex` binary, no autostart: only an existing socket is connected to),
 * type into a pane, read a pane's contents, list or show sessions that did not connect to the Inbox themselves, write
 * Rex's config. Only on macOS, where the app runs; every failure is "no Rex", silently.
 */
import { join } from "node:path";
import { graphemesOf } from "@plannotator/core/inbox-format";
import type { InboxPlace } from "@plannotator/shared/inbox/connection";
import { connectRex, RexCallError, RexUnavailable, type RexConnection } from "./inbox-rex-socket";

/** The longest a read (where agents live) may take, connecting included; past it nothing is shown. */
export const INBOX_REX_READ_TIMEOUT_MS = 400;
/** The longest Open in Rex or Show in Rex may take. */
export const INBOX_REX_ACTION_TIMEOUT_MS = 3_000;
/** How long the app's last answer about performing actions (Remote Control) stands. */
export const INBOX_REX_REMOTE_MS = 60_000;
/** After a Rex that did not answer in time, how long nothing asks it again (the list never waits on it twice). */
export const INBOX_REX_SLOW_BACKOFF_MS = 30_000;
/** A read connection is closed once nothing used it this long. */
const IDLE_CLOSE_MS = 3_000;
/** The longest a name shown from Rex is, in characters. */
const NAME_MAX = 60;
const TERMINAL_FLAVOR = "com.superlogical.terminal.shell";

/** Where this computer's Rex server listens, on macOS (the app's server); null elsewhere. */
export function inboxRexSocketPath(platform: string, homeDir: string): string | null {
  return platform === "darwin" ? join(homeDir, "Library", "Application Support", "rex", "server.sock") : null;
}

/** A place as a window draws it: one quiet line, and whether Show in Rex is offered. */
export interface InboxRexShown {
  line: string;
  show: boolean;
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

type Resolved = { status?: unknown; target?: Record<string, unknown> | null; candidates?: unknown };
const resultsOf = (answer: Record<string, unknown>): Resolved[] => (Array.isArray(answer.results) ? (answer.results as Resolved[]) : []);
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The app's answer to an action says it performs none for other programs (Remote Control off). */
function refusesActions(cause: unknown): boolean {
  if (!(cause instanceof RexCallError)) return true;
  if (/not accepting actions|remote control/i.test(cause.message)) return true;
  return cause.code === "refused" || cause.code === "not_supported" || cause.code === "client_unavailable" || cause.code === "timeout";
}

export interface InboxRexOptions {
  /** This computer's Rex socket (`inboxRexSocketPath`); null: no Rex here. */
  socketPath: string | null;
  readTimeoutMs?: number;
  actionTimeoutMs?: number;
  now?: () => number;
  /** Said in the hello. */
  version?: string;
}

export type InboxRex = ReturnType<typeof createInboxRex>;

export function createInboxRex(options: InboxRexOptions) {
  const now = options.now ?? Date.now;
  const readTimeout = options.readTimeoutMs ?? INBOX_REX_READ_TIMEOUT_MS;
  const actionTimeout = options.actionTimeoutMs ?? INBOX_REX_ACTION_TIMEOUT_MS;
  /** No asking before this (a Rex that did not answer in time). */
  let quietUntil = 0;
  /** The app's last answer about actions, by its client id. */
  let remote: { app: string; on: boolean; at: number } | null = null;
  let probing: Promise<void> | null = null;

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
    if (!options.socketPath) return Promise.reject(new RexUnavailable("no Rex here"));
    reader ??= connectRex(options.socketPath, { timeoutMs: readTimeout, version: options.version });
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

  /** Run `work` on a connection of its own (an action: it may attach to a session), closed after. */
  const act = async <T>(work: (rex: RexConnection) => Promise<T>): Promise<T | null> => {
    if (!options.socketPath) return null;
    let rex: RexConnection | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const connected = await connectRex(options.socketPath, { timeoutMs: actionTimeout, version: options.version });
      rex = connected;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          connected.close();
          resolve(null);
        }, actionTimeout);
      });
      return await Promise.race([work(connected), late]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      rex?.close();
    }
  };

  /** Rex's app attached here: its client id. One Mac app, else none (another device's app is never asked). */
  const appOf = async (rex: RexConnection): Promise<string | null> => {
    const answer = await rex.call("client.list", { kinds: ["app"] });
    const apps = (Array.isArray(answer.clients) ? answer.clients : []) as { client_id?: unknown; info?: { platform?: unknown }; connection_state?: unknown }[];
    const here = apps.filter((c) => typeof c.client_id === "string" && (c.info?.platform ?? "macos") === "macos" && (c.connection_state ?? "connected") === "connected");
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

  /** Ask the app to go to a session's tab; whether it did. Its answer about actions is kept (`remote`). */
  const select = async (rex: RexConnection, app: string, session: string, window: string): Promise<boolean> => {
    try {
      await rex.call("client.perform", { client_id: app, action: "session.select", args: { session_id: session, window_id: window }, origin: "api", timeout_ms: Math.max(500, actionTimeout - 500) });
      remote = { app, on: true, at: now() };
      return true;
    } catch (cause) {
      if (refusesActions(cause)) remote = { app, on: false, at: now() };
      return false;
    }
  };

  /**
   * Whether the app performs actions for other programs, asked once a minute at most and never while a read waits:
   * `session.select` with no session, which changes nothing; the app refuses every action while Remote Control is off.
   */
  const probeRemote = (app: string) => {
    if (probing || (remote && remote.app === app && now() - remote.at < INBOX_REX_REMOTE_MS)) return;
    probing = (async () => {
      await act(async (rex) => {
        try {
          await rex.call("client.perform", { client_id: app, action: "session.select", args: { session_id: "" }, origin: "api", timeout_ms: 1_000 });
          remote = { app, on: true, at: now() };
        } catch (cause) {
          remote = { app, on: !refusesActions(cause), at: now() };
        }
      });
    })().finally(() => {
      probing = null;
    });
  };

  return {
    /**
     * Each place Rex confirms, by session: the line (the session's and the tab's names, read now) and whether Show in
     * Rex is offered (`actions`: the window asking is on this computer). Places Rex does not confirm are left out.
     */
    async places(hints: ReadonlyMap<string, InboxPlace>, actions: boolean): Promise<Map<string, InboxRexShown>> {
      const out = new Map<string, InboxRexShown>();
      if (hints.size === 0) return out;
      const found = await read(async (rex) => {
        const bySession = new Map<string, { session: string; block: string }[]>();
        for (const [session, place] of hints) bySession.set(place.session, [...(bySession.get(place.session) ?? []), { session, block: place.block }]);
        const rows: { session: string; rexSession: string; window: string }[] = [];
        const windowNames = new Map<string, string>();
        for (const [rexSession, blocks] of bySession) {
          const answer = await rex.call("target.resolve", { kinds: ["block"], queries: blocks.map((b) => b.block), scope: { session: rexSession } });
          const results = resultsOf(answer);
          blocks.forEach((b, i) => {
            const target = results[i]?.status === "resolved" ? results[i]!.target : null;
            const window = target && target.kind === "block" && target.block_id === b.block && target.session_id === rexSession ? text(target.window_id) : "";
            if (window) rows.push({ session: b.session, rexSession, window });
          });
          const windows = [...new Set(rows.filter((r) => r.rexSession === rexSession).map((r) => r.window))];
          if (windows.length === 0) continue;
          const named = resultsOf(await rex.call("target.resolve", { kinds: ["window"], queries: windows, scope: { session: rexSession } }));
          windows.forEach((w, i) => windowNames.set(w, named[i]?.status === "resolved" ? cleanName(named[i]!.target?.label) : ""));
        }
        if (rows.length === 0) return { rows, sessionNames: new Map<string, string>(), windowNames, app: null as string | null };
        const sessions = [...new Set(rows.map((r) => r.rexSession))];
        const named = resultsOf(await rex.call("target.resolve", { kinds: ["session"], queries: sessions }));
        const sessionNames = new Map(sessions.map((s, i) => [s, named[i]?.status === "resolved" && named[i]!.target?.session_id === s ? cleanName(named[i]!.target?.label) : ""]));
        const app = actions ? await appOf(rex) : null;
        return { rows, sessionNames, windowNames, app };
      });
      if (!found) return out;
      const app = found.app;
      if (app) probeRemote(app);
      const showable = !!app && remote?.app === app && remote.on && now() - remote.at < INBOX_REX_REMOTE_MS;
      for (const row of found.rows) {
        out.set(row.session, { line: inboxRexLine(found.sessionNames.get(row.rexSession) ?? "", found.windowNames.get(row.window) ?? ""), show: showable });
      }
      return out;
    },

    /** Whether Open in Terminal opens in Rex here: Rex's app is attached to its server on this computer. */
    async opensHere(): Promise<boolean> {
      return (await read(appOf)) !== null;
    },

    /**
     * Open `command` in a new Rex tab named `tab`, in the Rex session named `project` (made when there is none), and
     * have the app go to it when it performs actions. Null when Rex's app is not attached here or Rex said no before
     * the tab was made: the caller opens Terminal instead. Never types into a pane: the command is the tab's program.
     */
    async open(request: { project: string; tab: string; command: string }): Promise<{ session: string; window: string } | null> {
      const project = cleanName(request.project).slice(0, 128) || "Plannotator";
      const tab = cleanName(request.tab).slice(0, 128);
      return act(async (rex) => {
        const app = await appOf(rex);
        if (!app) return null;
        const layout = { block: { flavor: TERMINAL_FLAVOR, options: { command: ["/bin/sh", "-c", request.command] } } };
        // The session named for the project: by its label only (Rex would also take an id's end, another session's).
        const result = resultsOf(await rex.call("target.resolve", { kinds: ["session"], queries: [project] }))[0];
        const sameName = (t: Record<string, unknown> | null | undefined) => !!t && t.kind === "session" && typeof t.session_id === "string" && text(t.label).toLowerCase() === project.toLowerCase();
        const candidates = (Array.isArray(result?.candidates) ? result.candidates : []) as Record<string, unknown>[];
        const existing = result?.status === "resolved" && sameName(result.target) ? (result.target!.session_id as string) : result?.status === "ambiguous" ? ((candidates.find(sameName)?.session_id as string | undefined) ?? null) : null;
        let session: string;
        let window: string;
        if (existing) {
          await rex.call("session.attach", { session_id: existing });
          const made = await rex.call("session.new_window", { session_id: existing, ...(tab ? { window_label: tab } : {}), layout, focus: true });
          session = existing;
          window = text(made.window_id);
        } else {
          const made = await rex.call("session.create", { label: project, initial_windows: [{ ...(tab ? { window_label: tab } : {}), layout }] });
          session = text(made.session_id);
          window = text((made.initial_windows as { window_id?: unknown }[] | undefined)?.[0]?.window_id);
        }
        if (!session || !window) return null;
        await select(rex, app, session, window);
        return { session, window };
      }).catch(() => null);
    },

    /** Have Rex's app go to `place`'s pane. Whether it did; false when the pane is gone or the app performs no actions. */
    async show(place: InboxPlace): Promise<boolean> {
      return (
        (await act(async (rex) => {
          const window = await windowOf(rex, place);
          const app = window ? await appOf(rex) : null;
          if (!window || !app) return false;
          if (!(await select(rex, app, place.session, window))) return false;
          // The pane itself, in a tab of several.
          await rex.call("session.attach", { session_id: place.session });
          await rex.call("session.focus_block", { session_id: place.session, block_id: place.block }).catch(() => undefined);
          return true;
        })) === true
      );
    },

    /** Close what is open (the Inbox stops). */
    close(): void {
      dropReader();
    },
  };
}
