/**
 * A fake Rex server (superlogical.com/rex) for the Inbox's Rex code (packages/server/inbox-rex.ts): a unix socket
 * speaking just the control API calls the Inbox makes. Shapes and error codes follow Rex's own API manual (revision
 * 7: `target.resolve`, `client.list` with `info` and `principal`, `client.perform`'s `performed_by`, the codes
 * `bad_request`, `not_found`, `session_not_found`, `conflict`, `refused`), and the replies a real server gave
 * for `session.create`, `target.resolve` and `session.new_window`. The person's own Rex is never reached: the
 * socket lives in a temp folder of the test's own.
 *
 * The model: sessions with labelled windows ("tabs") of blocks ("panes"), an optional Mac app client, and the app's
 * Remote Control setting. `session.new_window` and `session.focus_block` need a `session.attach` on the same
 * connection first (409 `conflict`), as the real server does. So do `block.method` and `block.close` on Rex 0.1
 * (API revision 18, as a real one answered on 2026-11-18: 409 `conflict`, "stream is not attached to session …"),
 * where `session.attach_all` (scope `session`) also counts for every session; `revision: 7` is the older server,
 * which answered them on any connection and has no `session.attach_all`. With Remote Control off, the app answers every
 * action `refused` (403) with the real app's words (as a real one answered, 2026-11-18). What a
 * real app answers with Remote Control on was never seen: here, the documented success (`performed_by`).
 *
 * A headless Rex (Linux, FreeBSD: a server with no app on its machine) is `app: false` with `apps`: the Rex apps
 * attached to it from other computers, each as Rex's manual says `client.list` gives one (`info.platform`, a
 * `principal` of kind `tailscale`, or `peer` over the unix socket for one that came in by ssh), with its own Remote
 * Control setting. An app that listed its actions without the one asked answers `not_supported`, as the manual says
 * of `client.perform`. What a real app attached from another computer answers was never seen.
 *
 * Program status (OSC 7501, Rex's `build/program-status`): each block holds the records its programs reported, read
 * with `block.method` `program_status` as a real server answered it (`{ records: [{ id?, state, kind?, app,
 * effective_app, title?, msg?, updated_at, owner }] }`, the root record with no `id`).
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What Rex's app answers an action while its Remote Control setting is off, as a real one answered. */
export const FAKE_REX_REFUSAL = "Rex.app is not accepting actions. Turn on Remote Control in its Settings under Rex Server.";

export interface FakeRexWindow {
  window_id: string;
  label: string;
  blocks: string[];
}

export interface FakeRexSession {
  session_id: string;
  label: string;
  windows: FakeRexWindow[];
}

export interface FakeRexCall {
  method: string;
  payload: Record<string, unknown>;
}

/** A Rex app attached from another computer (a headless server's only kind). */
export interface FakeRexFarApp {
  /** Its client id's last digits (a full id is made from it). */
  id: string;
  platform?: "macos" | "ios" | "linux" | "windows";
  /** How it came in: over the tailnet (default), or by ssh (the server sees a local peer on its unix socket). */
  transport?: "tailscale" | "ssh";
  /** Its Remote Control setting. Default true. */
  remote?: boolean;
  /** The actions it listed (`client.perform` answers `not_supported` for any other). Default: none listed, so it is asked anyway. */
  actions?: string[];
  /** Its connection dropped without closing (`connection_state: lost`). */
  lost?: boolean;
  /** By ssh: the account it came in as (default the app connection's uid). Another uid is another person's app. */
  uid?: number;
  /** The name the app gives itself (`info.label`). Default `far-<id>`. */
  label?: string;
}

export interface FakeRexOptions {
  /** The socket's folder; a new temp folder by default (its path has a space, as Rex's own under Application Support). */
  dir?: string;
  /** Rex's app attached to this server (a Mac client). Default true. */
  app?: boolean;
  /** The app's Remote Control setting. Default false. */
  remote?: boolean;
  /** How the app is attached: this computer's socket (default), or over the tailnet (another computer's app). */
  appTransport?: "unix" | "tailscale";
  /** The app connection's uid (default this process's). */
  appUid?: number;
  /** The app's process id in its connection's `principal` (Rex 0.1 says it); none by default. */
  appPid?: number;
  /** Rex apps attached from other computers, beside (or, with `app: false`, instead of) this computer's own. */
  apps?: FakeRexFarApp[];
  /** The server's API revision: 18 (default, Rex 0.1) or 7 (the older server: no `session.attach_all`, no attach for a block's methods). */
  revision?: 7 | 18;
}

export interface FakeRex {
  socketPath: string;
  sessions: FakeRexSession[];
  /** Every request, in order (the hello is not one). */
  calls: FakeRexCall[];
  methods(): string[];
  /** Change the app: attached or not, its Remote Control on or off. */
  setApp(app: boolean): void;
  /** The apps attached from other computers now (replaces them all). */
  setFarApps(apps: FakeRexFarApp[]): void;
  /** A far app's full client id. */
  farAppId(id: string): string;
  setRemote(on: boolean): void;
  /** Answer every request (or only `method`'s) this much later (a slow Rex); Infinity never answers. */
  setDelay(ms: number, method?: string): void;
  /** The app answers its next actions with this instead (an answer of a shape the Inbox does not know). */
  setPerformAnswer(answer: Record<string, unknown> | null): void;
  /** Answer every `method` request with this error (Rex's own "no": an option it does not take, Remote Control off); null: as usual. */
  setRefusal(method: string, error: { code: string; message: string; status: number } | null): void;
  /** Rename a session or a window (labels are read at show time). */
  rename(id: string, label: string): void;
  /** A block's program status records, as programs reported them (replaces them all; [] clears). */
  setStatus(block: string, records: Record<string, unknown>[]): void;
  /** Add a session of one window of one block; its ids. */
  addSession(label: string, windowLabel: string): { session: string; window: string; block: string };
  /** Connections opened so far, and those still open. */
  connections(): { opened: number; open: number };
  stop(): Promise<void>;
}

const APP_CLIENT = "client:01a1eb00-0000-7000-8000-00000000a99a";
const farClient = (id: string) => `client:01a1eb00-0000-7000-8000-${id.padStart(12, "0")}`;
const uuid = () => crypto.randomUUID();

type Socket = Bun.ServerWebSocket<{ attached: Set<string>; all: boolean }>;

export function startFakeRex(options: FakeRexOptions = {}): FakeRex {
  const dir = options.dir ?? join(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "fake-rex-")), "Rex Support");
  mkdirSync(dir, { recursive: true });
  const socketPath = join(dir, "server.sock");
  let app = options.app ?? true;
  let farApps = options.apps ?? [];
  let remote = options.remote ?? false;
  let delay = 0;
  const delays = new Map<string, number>();
  const refusals = new Map<string, { code: string; message: string; status: number }>();
  let performAnswer: Record<string, unknown> | null = null;
  const appTransport = options.appTransport ?? "unix";
  const appUid = options.appUid ?? process.getuid?.() ?? 501;
  const older = options.revision === 7;
  /** Rex 0.1: a block's methods and `block.close` only on a connection attached to its session (or to all). */
  const unattached = (ws: Socket, session: string) => (older || ws.data.all || ws.data.attached.has(session) ? null : fail("conflict", `stream is not attached to session ${session}`, 409));
  let opened = 0;
  let open = 0;
  const sessions: FakeRexSession[] = [];
  const calls: FakeRexCall[] = [];
  const statuses = new Map<string, Record<string, unknown>[]>();

  const sessionOf = (id: unknown) => sessions.find((s) => s.session_id === id);
  const fail = (code: string, message: string, status: number) => ({ error: { code, message, status } });

  /** `target.resolve`, as Rex matches: full id, then label (any case), then nothing (the fake skips position and id suffix). */
  const resolve = (payload: Record<string, unknown>) => {
    const kinds = (payload.kinds as string[] | undefined) ?? [];
    const queries = (payload.queries as string[] | undefined) ?? [];
    const scope = (payload.scope as { session?: string } | undefined)?.session;
    const kind = kinds[0];
    if (kind === "session" && scope) return fail("bad_request", "a session target takes no scope", 400);
    if ((kind === "block" || kind === "window") && !scope) return fail("bad_request", "a scope is needed", 400);
    const inScope = scope ? sessions.filter((s) => s.session_id === scope || s.label.toLowerCase() === scope.toLowerCase()) : sessions;
    const results = queries.map((query) => {
      if (kind === "session") {
        const hits = sessions.filter((s) => s.session_id === query || s.label.toLowerCase() === query.toLowerCase());
        if (hits.length > 1) return { query, status: "ambiguous", candidates: hits.map((s) => ({ kind: "session", session_id: s.session_id, label: s.label })) };
        const s = hits[0];
        return s ? { query, status: "resolved", target: { kind: "session", session_id: s.session_id, label: s.label } } : { query, status: "not_found" };
      }
      for (const s of inScope) {
        for (const [i, w] of s.windows.entries()) {
          if (kind === "window" && (w.window_id === query || w.label.toLowerCase() === query.toLowerCase())) {
            return { query, status: "resolved", target: { kind: "window", session_id: s.session_id, window_id: w.window_id, label: w.label, ordinal: i + 1 } };
          }
          if (kind === "block" && w.blocks.includes(query)) {
            return { query, status: "resolved", target: { kind: "block", session_id: s.session_id, window_id: w.window_id, block_id: query, label: "shell", where: `window ${i + 1}` } };
          }
        }
      }
      return { query, status: "not_found" };
    });
    return { payload: { results } };
  };

  const answer = (ws: Socket, method: string, payload: Record<string, unknown>): Record<string, unknown> => {
    switch (method) {
      case "session.list":
        return { payload: { sessions: sessions.map((s) => ({ session_id: s.session_id, label: s.label })) } };
      case "target.resolve":
        return resolve(payload);
      case "client.list":
        return {
          payload: {
            clients: [
              ...farApps.map((far) => ({
                client_id: farClient(far.id),
                info: { kind: "app", platform: far.platform ?? "macos", name: "Rex.app", version: "0.1.0", label: far.label ?? `far-${far.id}` },
                principal:
                  far.transport === "ssh"
                    ? { kind: "peer", transport: "unix", display: `uid ${far.uid ?? appUid}`, uid: far.uid ?? appUid, gid: 20, pid: 4000 }
                    : { kind: "tailscale", transport: "tailscale", display: "someone@example.com", user_id: "u1", login_name: "someone@example.com", node: `far-${far.id}` },
                connected_at: "2026-11-18T08:00:00Z",
                connection_state: far.lost ? "lost" : "connected",
              })),
              ...(app
              ? [
                  {
                    client_id: APP_CLIENT,
                    info: { kind: "app", platform: "macos", name: "Rex.app", version: "0.1.0", label: "this-mac" },
                    principal:
                      appTransport === "unix"
                        ? { kind: "peer", transport: "unix", display: `uid ${appUid}`, uid: appUid, gid: 20, ...(options.appPid !== undefined ? { pid: options.appPid } : {}) }
                        : { kind: "tailscale", transport: "tailscale", display: "someone@example.com", user_id: "u1", node: "other-mac" },
                    connected_at: "2026-11-17T08:00:00Z",
                    connection_state: "connected",
                  },
                ]
              : []),
            ],
          },
        };
      case "client.perform": {
        const far = farApps.find((one) => farClient(one.id) === payload.client_id && !one.lost);
        if (!far && (!app || payload.client_id !== APP_CLIENT)) return fail("not_found", "no such client", 404);
        if (far?.actions && !far.actions.includes(String(payload.action))) return fail("not_supported", `the client does not offer ${String(payload.action)}`, 501);
        if (far ? far.remote === false : !remote) return fail("refused", FAKE_REX_REFUSAL, 403);
        if (performAnswer) return performAnswer;
        const args = (payload.args as Record<string, unknown> | undefined) ?? {};
        if (payload.action === "session.select" && !sessionOf(args.session_id)) return fail("session_not_found", "no such session", 404);
        return { payload: { performed_by: payload.client_id } };
      }
      case "session.attach": {
        const s = sessionOf(payload.session_id);
        if (!s) return fail("session_not_found", "no such session", 404);
        ws.data.attached.add(s.session_id);
        return { payload: { client_id: `client:${uuid()}`, view: { revision: 1, session_id: s.session_id, label: s.label, active_window_id: s.windows[0]?.window_id, windows: [] } } };
      }
      case "session.attach_all": {
        if (older) return fail("method_not_found", "unknown method session.attach_all", 404);
        if (payload.event_scope !== "session" && payload.event_scope !== "all") return fail("bad_request", "event_scope must be session or all", 400);
        ws.data.all = true;
        return { payload: { sessions: sessions.map((s) => ({ session_id: s.session_id, label: s.label })) } };
      }
      case "session.create": {
        const initial = ((payload.initial_windows as Record<string, unknown>[] | undefined) ?? [{}]).map((w) => ({ window_id: `window:${uuid()}`, label: typeof w.window_label === "string" ? w.window_label : "", blocks: [`block:${uuid()}`] }));
        const s: FakeRexSession = { session_id: `session:${uuid()}`, label: typeof payload.label === "string" ? payload.label : "", windows: initial };
        sessions.push(s);
        return { payload: { session_id: s.session_id, initial_windows: initial.map((w) => ({ window_id: w.window_id, block_ids: w.blocks, revision: 1 })) } };
      }
      case "session.new_window": {
        const s = sessionOf(payload.session_id);
        if (!s) return fail("session_not_found", "no such session", 404);
        if (!ws.data.attached.has(s.session_id)) return fail("conflict", "attach to the session first", 409);
        const w = { window_id: `window:${uuid()}`, label: typeof payload.window_label === "string" ? payload.window_label : "", blocks: [`block:${uuid()}`] };
        s.windows.push(w);
        return { payload: { window_id: w.window_id, block_ids: w.blocks, revision: s.windows.length } };
      }
      case "session.focus_block": {
        const s = sessionOf(payload.session_id);
        if (!s) return fail("session_not_found", "no such session", 404);
        if (!ws.data.attached.has(s.session_id)) return fail("conflict", "attach to the session first", 409);
        return s.windows.some((w) => w.blocks.includes(payload.block_id as string)) ? { payload: {} } : fail("not_found", "no such block", 404);
      }
      case "block.method": {
        const s = sessionOf(payload.session_id);
        if (!s) return fail("session_not_found", "no such session", 404);
        if (typeof payload.block_id !== "string") return fail("bad_request", "block_id is required", 400);
        const notAttached = unattached(ws, s.session_id);
        if (notAttached) return notAttached;
        if (!s.windows.some((w) => w.blocks.includes(payload.block_id as string))) return fail("not_found", "no such block", 404);
        if (payload.method !== "program_status") return fail("method_not_found", `no block method ${String(payload.method)}`, 404);
        return { payload: { records: statuses.get(payload.block_id) ?? [] } };
      }
      case "block.close": {
        // Closing a pane ends its program; its window goes with its last pane.
        const s = sessionOf(payload.session_id);
        if (!s) return fail("session_not_found", "no such session", 404);
        const notAttached = unattached(ws, s.session_id);
        if (notAttached) return notAttached;
        const w = s.windows.find((x) => x.blocks.includes(payload.block_id as string));
        if (!w) return fail("not_found", "no such block", 404);
        w.blocks = w.blocks.filter((b) => b !== payload.block_id);
        if (w.blocks.length === 0) s.windows.splice(s.windows.indexOf(w), 1);
        return { payload: {} };
      }
      case "session.destroy": {
        const at = sessions.findIndex((s) => s.session_id === payload.session_id);
        if (at < 0) return fail("session_not_found", "no such session", 404);
        sessions.splice(at, 1);
        return { payload: {} };
      }
      default:
        return fail("method_not_found", `unknown method ${method}`, 404);
    }
  };

  const server = Bun.serve<{ attached: Set<string>; all: boolean }, never>({
    unix: socketPath,
    fetch(req, srv) {
      if (new URL(req.url).pathname !== "/api/control") return new Response("not found", { status: 404 });
      if (srv.upgrade(req, { data: { attached: new Set<string>(), all: false }, headers: { "Sec-WebSocket-Protocol": "rex.control.v1" } })) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open() {
        opened++;
        open++;
      },
      close() {
        open--;
      },
      message(ws, raw) {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          ws.close(1002, "not JSON");
          return;
        }
        if (message.type === "hello") {
          ws.send(JSON.stringify({ type: "welcome", protocol: "rex.control.v1", api_revision: 7, server: { version: "0.0.0-fake" } }));
          return;
        }
        if (message.type !== "request" || typeof message.id !== "string" || typeof message.method !== "string") return;
        const payload = (message.payload as Record<string, unknown> | undefined) ?? {};
        calls.push({ method: message.method, payload });
        const reply = () => {
          try {
            const refusal = refusals.get(message.method as string);
            ws.send(JSON.stringify({ type: "response", id: message.id, ...(refusal ? { error: refusal } : answer(ws, message.method as string, payload)) }));
          } catch {}
        };
        const wait = delays.get(message.method) ?? delay;
        if (wait === Infinity) return;
        if (wait > 0) setTimeout(reply, wait);
        else reply();
      },
    },
  });

  return {
    socketPath,
    sessions,
    calls,
    methods: () => calls.map((c) => c.method),
    setApp: (on) => {
      app = on;
    },
    setFarApps: (next) => {
      farApps = next;
    },
    farAppId: farClient,
    setRemote: (on) => {
      remote = on;
    },
    setDelay: (ms, method) => {
      if (method) delays.set(method, ms);
      else delay = ms;
    },
    setPerformAnswer: (answer) => {
      performAnswer = answer;
    },
    setRefusal: (method, error) => {
      if (error) refusals.set(method, error);
      else refusals.delete(method);
    },
    rename(id, label) {
      for (const s of sessions) {
        if (s.session_id === id) s.label = label;
        for (const w of s.windows) if (w.window_id === id) w.label = label;
      }
    },
    setStatus(block, records) {
      statuses.set(block, records.map((r) => ({ effective_app: r.app, updated_at: "2026-11-18T08:00:00Z", owner: { pid: 4242, name: "claude" }, ...r })));
    },
    addSession(label, windowLabel) {
      const block = `block:${uuid()}`;
      const s: FakeRexSession = { session_id: `session:${uuid()}`, label, windows: [{ window_id: `window:${uuid()}`, label: windowLabel, blocks: [block] }] };
      sessions.push(s);
      return { session: s.session_id, window: s.windows[0]!.window_id, block };
    },
    connections: () => ({ opened, open }),
    async stop() {
      await server.stop(true);
    },
  };
}
