/**
 * `plannotator inbox canvas` (inbox-canvas-command.ts): what it asks the Inbox, what it prints, and that the commands
 * the Inbox's answers offer are ones it takes. No Inbox runs: a stand-in for the Inbox's route. What regresses: an ask
 * sent as someone else (the canvas then forgets what it showed this session, and the person's change could be
 * overwritten unseen); bad usage starting the Inbox; a refused change printed as a result; an Inbox too old for the
 * command not said so; an answer's "next" command that the command itself refuses.
 */
import { expect, test } from "bun:test";
import { canvasReadCommand } from "@plannotator/shared/inbox/canvas/command";
import { INBOX_CANVAS_USAGE, parseCanvasCommand, runInboxCanvasCommand } from "./inbox-canvas-command";

test("each operation's arguments are the ask the route takes", () => {
  expect(parseCanvasCommand(["msg_1"])).toEqual({ ok: true, ask: { thread_id: "msg_1" }, doFromStdin: false, session: null });
  expect(parseCanvasCommand(["msg_1", "--in", "Payment", "--after", "kX3v9QpL"])).toMatchObject({ ok: true, ask: { thread_id: "msg_1", in: "Payment", after_thing: "kX3v9QpL" } });
  expect(parseCanvasCommand(["msg_1", "--things", "a1,b2", "--things", "c3"])).toMatchObject({ ok: true, ask: { things: ["a1", "b2", "c3"] } });
  expect(parseCanvasCommand(["msg_1", "--picture"])).toMatchObject({ ok: true, ask: { picture: true } });
  expect(parseCanvasCommand(["msg_1", "--picture", "kX3v9QpL"])).toMatchObject({ ok: true, ask: { picture: "kX3v9QpL" } });
  expect(parseCanvasCommand(["msg_1", "--picture", "a1", "--picture", "Fraud check"])).toMatchObject({ ok: true, ask: { picture: ["a1", "Fraud check"] } });
  expect(parseCanvasCommand(["msg_1", "--base", "4", "--do", '[{"add": "box", "text": "Ledger"}]', "--session", "s1"])).toEqual({ ok: true, ask: { thread_id: "msg_1", base: 4, do: [{ add: "box", text: "Ledger" }] }, doFromStdin: false, session: "s1" });
  // One change alone is a list of one.
  expect(parseCanvasCommand(["msg_1", "--base", "4", "--do", '{"remove": "a1"}'])).toMatchObject({ ok: true, ask: { do: [{ remove: "a1" }] } });
  expect(parseCanvasCommand(["msg_1", "--base", "4", "--do", "-"])).toMatchObject({ ok: true, doFromStdin: true });
});

test("bad usage is refused before anything is sent", () => {
  for (const argv of [[], ["msg_1", "msg_2"], ["msg_1", "--do", "not json"], ["msg_1", "--do", "3"], ["msg_1", "--base", "x", "--do", "[]"], ["msg_1", "--base", "4"], ["msg_1", "--do", "[]", "--picture"], ["msg_1", "--do", "[]", "--in", "F"], ["msg_1", "--force"], ["msg_1", "--in"]]) {
    expect([argv, parseCanvasCommand(argv).ok]).toEqual([argv, false]);
  }
});

/** A command line as a shell splits it: words, and single-quoted words as they are. */
const shellWords = (line: string): string[] => [...line.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]!));

test("every next command an answer offers is one the command takes, with the same ask", () => {
  for (const [more, ask] of [
    [{}, {}],
    [{ after_thing: "kX3v9QpL" }, { after_thing: "kX3v9QpL" }],
    [{ in: "Payment flow's frame", after_thing: "a1" }, { in: "Payment flow's frame", after_thing: "a1" }],
    [{ things: ["a1", "b2"] }, { things: ["a1", "b2"] }],
  ] as const) {
    const words = shellWords(canvasReadCommand("msg_1", more));
    expect(words.slice(0, 3)).toEqual(["plannotator", "inbox", "canvas"]);
    expect(parseCanvasCommand(words.slice(3))).toEqual({ ok: true, ask: { ...ask, thread_id: "msg_1" }, doFromStdin: false, session: null });
  }
});

function inbox(answer: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  const asked: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let started = 0;
  const deps = {
    env: { CODEX_THREAD_ID: "019a2b3c-1111-7222-8333-444455556666" } as Record<string, string | undefined>,
    ensureRunning: async () => {
      started++;
      return {} as never;
    },
    stdin: async () => '[{"connect": "Checkout", "to": "Fraud check"}]',
    out: async (text: string) => void out.push(text),
    err: (text: string) => void err.push(text),
    fetchRoute: async (path: string, init?: { method?: string; body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      asked.push({ method: init?.method ?? "GET", path, body });
      const { status, json } = answer(body);
      return Response.json(json, { status });
    },
  };
  return { deps, asked, out, err, started: () => started };
}

test("a read is a POST as this shell's session; the answer's text is stdout", async () => {
  const text = "Canvas of thread msg_1, rev 3, 2 things, 600x200:\nbox kX3v9QpL \"Checkout\" at 0,0 140x64";
  const w = inbox(() => ({ status: 200, json: { text, thread_id: "msg_1", rev: 3 } }));
  expect(await runInboxCanvasCommand(["msg_1"], w.deps)).toBe(0);
  expect(w.asked).toEqual([{ method: "POST", path: "/api/inbox/canvas/agent", body: { thread_id: "msg_1", by: expect.objectContaining({ host: "codex", session: "019a2b3c-1111-7222-8333-444455556666" }) } }]);
  expect(w.out.join("")).toBe(`${text}\n`);
  expect(w.err).toEqual([]);
});

test("a change read from stdin is sent as the list; a refused one is stderr and exit 1, with nothing on stdout", async () => {
  const text = "Nothing changed. A thing you are changing is not as you were last shown it:\n  the person renamed (rev 5): box kX3v9QpL \"Checkout v2\"";
  const w = inbox(() => ({ status: 409, json: { code: "canvas_unchanged", error: text, rev: 5 } }));
  expect(await runInboxCanvasCommand(["msg_1", "--base", "4", "--do", "-"], w.deps)).toBe(1);
  expect(w.asked[0]!.body).toMatchObject({ thread_id: "msg_1", base: 4, do: [{ connect: "Checkout", to: "Fraud check" }] });
  expect(w.out).toEqual([]);
  expect(w.err.join("")).toBe(`canvas_unchanged: ${text}\n`);
});

test("off, and an Inbox from before the command, are said as such", async () => {
  const off = inbox(() => ({ status: 409, json: { code: "canvas_off", error: "The canvas is off in this Inbox." } }));
  expect(await runInboxCanvasCommand(["msg_1"], off.deps)).toBe(1);
  expect(off.err.join("")).toStartWith("canvas_off: ");
  const old = inbox(() => ({ status: 404, json: { error: "Not found", code: "not_found" } }));
  expect(await runInboxCanvasCommand(["msg_1"], old.deps)).toBe(1);
  expect(old.err.join("")).toStartWith("inbox_needs_update: ");
});

test("--help prints the how-to and asks nothing; bad usage starts no Inbox and exits 2", async () => {
  const help = inbox(() => ({ status: 500, json: {} }));
  expect(await runInboxCanvasCommand(["--help"], help.deps)).toBe(0);
  expect(help.out.join("")).toBe(`${INBOX_CANVAS_USAGE}\n`);
  const bad = inbox(() => ({ status: 500, json: {} }));
  const { fetchRoute: _unused, ...local } = bad.deps;
  expect(await runInboxCanvasCommand(["msg_1", "--do", "nope"], local)).toBe(2);
  expect(bad.started()).toBe(0);
  expect(help.asked).toEqual([]);
});

test("the help has one worked example for each operation the Inbox takes", () => {
  for (const verb of ["add", "connect", "set", "move", "remove", "frame", "replace"]) expect(INBOX_CANVAS_USAGE).toContain(`{"${verb}": `);
  for (const flag of ["--in", "--after", "--things", "--picture", "--base", "--do"]) expect(INBOX_CANVAS_USAGE).toContain(flag);
});
