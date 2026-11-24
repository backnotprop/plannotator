/**
 * A fake Codex control socket (packages/server/inbox-codex-control.ts): WebSocket over a Unix socket at
 * `<codex home>/app-server-control/app-server-control.sock`, in a scratch Codex home, answering the subset the Codex
 * wake's steer uses: `initialize`, `initialized`, `thread/loaded/list`, `thread/read`, `thread/turns/list`,
 * `turn/steer`. A scripted thread state; every call is kept. The real Codex is never run and no real socket is touched.
 */
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export interface FakeCodexControlState {
  /** The threads the server holds. */
  loaded: string[];
  /** The running turn's id per thread (absent or null: idle). */
  running: Record<string, string | null>;
  /** Turn ids `turn/steer` refuses as moved, once each: the turn ended (`"ended"`), or another began (`{ next }`). */
  moved?: Record<string, "ended" | { next: string }>;
  /** `turn/steer` never answers (the socket stays open). */
  silentSteer?: boolean;
  /** `turn/steer` refuses every turn with this message (a review turn: "cannot steer a review turn"). */
  refuseSteer?: string;
  /** `thread/turns/list` is unknown (an older server): the whole thread is read instead. */
  noTurnsList?: boolean;
}

export interface FakeCodexControl {
  socketPath: string;
  state: FakeCodexControlState;
  calls: { method: string; params: Record<string, any> }[];
  steers(): { threadId: string; expectedTurnId: string; text: string }[];
  stop(): void;
}

export function startFakeCodexControl(codexHome: string, state: FakeCodexControlState): FakeCodexControl {
  const dir = join(codexHome, "app-server-control");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketPath = join(dir, "app-server-control.sock");
  // A Unix socket's path has a short limit (104 bytes on macOS): the socket sits in a short temp folder and the
  // advertised path links to it, as Codex's own does (`/tmp/codex-daemon-<uid>/…`).
  const real = join(mkdtempSync("/tmp/cxc-"), "s.sock");
  const calls: FakeCodexControl["calls"] = [];
  const turnOf = (id: string) => ({ id, status: "inProgress", items: [] });
  const server = Bun.serve({
    unix: real,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("websocket only", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as { id?: string | number; method: string; params?: Record<string, any> };
        const params = message.params ?? {};
        calls.push({ method: message.method, params });
        if (message.id === undefined) return;
        const reply = (result: unknown) => ws.send(JSON.stringify({ id: message.id, result }));
        const fail = (text: string, code = -32600) => ws.send(JSON.stringify({ id: message.id, error: { code, message: text } }));
        const running = (thread: string) => state.running[thread] ?? null;
        switch (message.method) {
          case "initialize":
            return reply({ userAgent: "codex_cli_rs/0.172.0", codexHome, platformFamily: "unix", platformOs: "macos" });
          case "thread/loaded/list":
            return reply({ data: state.loaded, nextCursor: null });
          case "thread/read": {
            if (!state.loaded.includes(params.threadId)) return fail(`thread not loaded: ${params.threadId}`);
            const turn = running(params.threadId);
            return reply({ thread: { id: params.threadId, status: turn ? { type: "active", activeFlags: [] } : { type: "idle" }, turns: params.includeTurns ? (turn ? [{ id: "t-old", status: "completed" }, turnOf(turn)] : []) : [] } });
          }
          case "thread/turns/list": {
            if (state.noTurnsList) return fail(`unknown method ${message.method}`, -32601);
            const turn = running(params.threadId);
            return reply({ data: turn ? [turnOf(turn)] : [{ id: "t-old", status: "completed" }], nextCursor: null });
          }
          case "turn/steer": {
            if (state.silentSteer) return;
            if (state.refuseSteer) return fail(state.refuseSteer);
            const turn = running(params.threadId);
            const moved = state.moved?.[params.expectedTurnId];
            if (moved) {
              delete state.moved![params.expectedTurnId];
              state.running[params.threadId] = moved === "ended" ? null : moved.next;
              return fail(moved === "ended" ? "no active turn to steer" : `expected active turn id \`${params.expectedTurnId}\` but found \`${moved.next}\``);
            }
            if (!turn) return fail("no active turn to steer");
            if (turn !== params.expectedTurnId) return fail(`expected active turn id \`${params.expectedTurnId}\` but found \`${turn}\``);
            return reply({ turnId: turn });
          }
          default:
            return fail(`unknown method ${message.method}`, -32601);
        }
      },
    },
  });
  symlinkSync(real, socketPath);
  return {
    socketPath,
    state,
    calls,
    steers: () =>
      calls
        .filter((call) => call.method === "turn/steer")
        .map((call) => ({ threadId: call.params.threadId, expectedTurnId: call.params.expectedTurnId, text: (call.params.input ?? []).map((i: { text?: string }) => i.text ?? "").join("") })),
    stop: () => server.stop(true),
  };
}
