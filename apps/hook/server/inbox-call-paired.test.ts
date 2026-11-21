/**
 * A paired cloud agent's commands (`PLANNOTATOR_PAIRING`), with the paired call's one request stubbed
 * (`CallCommandDeps.pairedTransport`): no relay, no Inbox. The failures these guard: a command that looks for an
 * Inbox on the agent's own machine (and says the Inbox is off) instead of going through the pairing, an identity sent
 * through the door, a picture in the body that never reaches the person, a path on the person's computer read (and
 * refused) on the agent's machine instead of passed to the Inbox, and `inbox rows`, `projects`, `icon` or
 * `export-decisions` saying they are not available over a pairing instead of reaching the person's Inbox.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeInboxAgentPairing } from "@plannotator/shared/inbox/agent-pairing";
import { runCardCommand } from "./card-command";
import { inboxPairedRouteFetch, runInboxCallCommand, type CallCommandDeps } from "./inbox-call-command";
import { runInboxExportDecisionsCommand } from "./inbox-export-decisions-command";
import { runInboxIconCommand } from "./inbox-icon-command";
import { runInboxProjectsCommand } from "./inbox-projects-command";
import { runInboxRowsCommand } from "./inbox-rows-command";
import { runInboxPullsCommand } from "./inbox-pulls-command";
import { runInboxStepsCommand } from "./inbox-steps-command";
import { runRoutineCommand } from "./routine-command";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PAIRING = encodeInboxAgentPairing({
  device_id: "dev_01K7PAIRINGTEST00000000000",
  token: `tok_${"A".repeat(43)}`,
  secret: "B".repeat(43),
  relay: { url: "https://relay.example", mailbox_id: `mbx_${"C".repeat(22)}` },
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A cloud machine: a folder of its own, the pairing, and a door that answers every call with `ok`. */
function cloudMachine() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-paired-call-")));
  roots.push(cwd);
  const calls: { tool: string; body: Record<string, unknown> }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: CallCommandDeps = {
    cwd,
    env: { PLANNOTATOR_PAIRING: PAIRING },
    ensureRunning: () => {
      throw new Error("a paired call must not look for an Inbox on this machine");
    },
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
    pairedTransport: async (tool, body) => {
      calls.push({ tool, body: structuredClone(body) });
      return { kind: "answer", status: 200, body: JSON.stringify({ result: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } } }) };
    },
  };
  return { cwd, deps, calls, out, err };
}

describe("a paired cloud agent's commands go through its pairing", () => {
  test("plannotator card: the card call through the door, --project as the door's project, no folder and no identity", async () => {
    const m = cloudMachine();
    expect(await runCardCommand(["list"], m.deps)).toBe(0);
    expect(await runCardCommand(["move", "crd_1", "in_progress", "--project", "https://github.com/acme/api"], m.deps)).toBe(0);
    expect(m.calls).toEqual([
      { tool: "card", body: { op: "list" } },
      { tool: "card", body: { op: "move", card_id: "crd_1", column: "in_progress", project: "https://github.com/acme/api" } },
    ]);
    expect(m.err).toEqual([]);
  });

  test("inbox pulls, inbox steps and routine: each its door action, nothing looked for here", async () => {
    const m = cloudMachine();
    expect(await runInboxPullsCommand(["ls", "thr_1"], m.deps)).toBe(0);
    expect(await runInboxStepsCommand(["thr_1", "--json", '[{"step":"Tests","status":"done"}]'], m.deps)).toBe(0);
    expect(await runRoutineCommand(["list"], m.deps)).toBe(0);
    expect(m.calls.map((call) => call.tool)).toEqual(["thread_pulls", "steps", "routine"]);
    expect(m.err).toEqual([]);
  });

  test("a picture shown by its path on this machine is sent with the message under its file's name, as a local agent writes it", async () => {
    const m = cloudMachine();
    mkdirSync(join(m.cwd, "out"));
    mkdirSync(join(m.cwd, "b"));
    writeFileSync(join(m.cwd, "out", "shot.png"), PNG);
    writeFileSync(join(m.cwd, "b", "shot.png"), PNG);
    const body = "Before ![before](out/shot.png) and after ![after](b/shot.png).";
    expect(await runInboxCallCommand(["send_message", JSON.stringify({ reply_to: "msg_1", body })], m.deps)).toBe(0);
    const sent = m.calls.at(-1)!;
    expect(sent.tool).toBe("send_message");
    expect(sent.body.body).toBe("Before ![before](out/shot.png) and after ![after](shot-2.png).");
    expect(sent.body.attachments).toEqual([
      { name: "shot.png", data: PNG.toString("base64") },
      { name: "shot-2.png", data: PNG.toString("base64") },
    ]);
  });

  test("a body with no picture on this machine is sent as written, with no attachments added", async () => {
    const m = cloudMachine();
    expect(await runInboxCallCommand(["send_message", JSON.stringify({ reply_to: "msg_1", body: "See ![it](nowhere.png) and ![web](https://example.com/a.png)." })], m.deps)).toBe(0);
    expect(m.calls.at(-1)!.body).toEqual({ reply_to: "msg_1", body: "See ![it](nowhere.png) and ![web](https://example.com/a.png)." });
  });

  test("an attachment path that is a file here is sent as bytes; one that is not is passed as written, for the person's computer; a routine's go as written", async () => {
    const m = cloudMachine();
    writeFileSync(join(m.cwd, "report.txt"), "all green");
    const there = "/Users/person/code/api/notes.md";
    expect(await runInboxCallCommand(["send_message", JSON.stringify({ reply_to: "msg_1", body: "Both.", attachments: ["report.txt", there, "src/elsewhere.ts"] })], m.deps)).toBe(0);
    expect(m.calls.at(-1)!.body.attachments).toEqual([{ name: "report.txt", data: Buffer.from("all green").toString("base64") }, there, "src/elsewhere.ts"]);
    expect(await runInboxCallCommand(["routine", JSON.stringify({ op: "create", name: "T", prompt: "T.", attachments: ["report.txt"] })], m.deps)).toBe(0);
    expect(m.calls.at(-1)!).toEqual({ tool: "routine", body: { op: "create", name: "T", prompt: "T.", attachments: ["report.txt"] } });
    expect(m.err).toEqual([]);
  });
});

describe("which computer a path is read on", () => {
  test('{ "path": … } is the person\'s computer\'s, even when this machine has the file; a folder here is passed as written too', async () => {
    const m = cloudMachine();
    mkdirSync(join(m.cwd, "docs"));
    writeFileSync(join(m.cwd, "docs", "plan.md"), "the agent's copy");
    expect(await runInboxCallCommand(["send_message", JSON.stringify({ reply_to: "msg_1", body: "Theirs.", attachments: [{ path: "docs/plan.md" }, "docs", "docs/plan.md"] })], m.deps)).toBe(0);
    expect(m.calls.at(-1)!.body.attachments).toEqual(["docs/plan.md", "docs", { name: "plan.md", data: Buffer.from("the agent's copy").toString("base64") }]);
    expect(await runInboxCallCommand(["routine", JSON.stringify({ op: "create", name: "T", prompt: "T.", attachments: [{ path: "docs/plan.md" }] })], m.deps)).toBe(0);
    expect(m.calls.at(-1)!.body.attachments).toEqual(["docs/plan.md"]);
  });

  test("a refusal of a path left for the person's computer says it was looked for there; one of a file sent from here does not", async () => {
    const m = cloudMachine();
    writeFileSync(join(m.cwd, "here.txt"), "x");
    m.deps.pairedTransport = async (tool, body) => {
      m.calls.push({ tool, body: structuredClone(body) });
      const at = (body.attachments as unknown[]).findIndex((item) => typeof item === "string");
      return { kind: "answer", status: 200, body: JSON.stringify({ result: { isError: true, content: [{ type: "text", text: `validation_error: attachments[${at < 0 ? 0 : at}]: gone.txt: no such file.` }] } }) };
    };
    expect(await runInboxCallCommand(["send_message", JSON.stringify({ reply_to: "msg_1", body: "x", attachments: ["here.txt", "gone.txt"] })], m.deps)).toBe(1);
    expect(m.err.join("")).toBe('validation_error: attachments[1]: gone.txt: no such file. (Looked for on the person\'s computer: it is no file on this machine, or was given as { "path": … }.)\n');
    const n = cloudMachine();
    writeFileSync(join(n.cwd, "here.txt"), "x");
    n.deps.pairedTransport = async () => ({ kind: "answer", status: 200, body: JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "validation_error: attachments[0]: here.txt: too big." }] } }) });
    expect(await runInboxCallCommand(["send_message", JSON.stringify({ reply_to: "msg_1", body: "x", attachments: ["here.txt"] })], n.deps)).toBe(1);
    expect(n.err.join("")).toBe("validation_error: attachments[0]: here.txt: too big.\n");
  });

  test("a guide's intent shows a picture on this machine as a body does: sent with it under its file's name", async () => {
    const m = cloudMachine();
    mkdirSync(join(m.cwd, "out"));
    writeFileSync(join(m.cwd, "out", "flow.png"), PNG);
    const guide = { title: "How it works", intent: "See ![flow](out/flow.png).", sections: [] };
    expect(await runInboxCallCommand(["submit_guide", JSON.stringify({ guide: JSON.stringify(guide) })], m.deps)).toBe(0);
    const sent = m.calls.at(-1)!.body;
    expect(JSON.parse(sent.guide as string).intent).toBe("See ![flow](out/flow.png).");
    expect(sent.attachments).toEqual([{ name: "flow.png", data: PNG.toString("base64") }]);
  });

  test("an older Inbox on the person's computer: its refusal of an action this command knows says to update it there", async () => {
    const m = cloudMachine();
    m.deps.pairedTransport = async () => ({ kind: "answer", status: 200, body: JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "tool_not_allowed: fetch_file is not an Inbox action. Actions: whoami, send_message." }] } }) });
    expect(await runInboxCallCommand(["fetch_file", JSON.stringify({ message_id: "msg_1", file: "att_1" })], m.deps)).toBe(1);
    expect(m.err.join("")).toContain("Plannotator on the person's computer is older than this one: ask the person to update it.");
    const n = cloudMachine();
    n.deps.pairedTransport = async () => ({ kind: "answer", status: 200, body: JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "attachment_path_refused: attachments[0]: a path." }] } }) });
    expect(await runInboxCallCommand(["send_message", JSON.stringify({ reply_to: "msg_1", body: "x", attachments: ["/elsewhere/a.txt"] })], n.deps)).toBe(1);
    expect(n.err.join("")).toContain("ask the person to update it.");
    // A tool this command does not know, refused: as the Inbox says it.
    const o = cloudMachine();
    o.deps.pairedTransport = async () => ({ kind: "answer", status: 200, body: JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "tool_not_allowed: shell is not an Inbox action." }] } }) });
    await runInboxCallCommand(["send_message", JSON.stringify({ reply_to: "msg_1", body: "x" })], o.deps);
    expect(o.err.join("")).not.toContain("update");
    // routine: an older Inbox's own refusal of it says to update; a current one with Routines off does not.
    const old = cloudMachine();
    old.deps.pairedTransport = async () => ({ kind: "answer", status: 200, body: JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "tool_not_allowed: routine: a routine runs an agent on the person's computer, and you run elsewhere, so nothing was written." }] } }) });
    expect(await runRoutineCommand(["list"], old.deps)).toBe(1);
    expect(old.err.join("")).toContain("ask the person to update it.");
    const off = cloudMachine();
    off.deps.pairedTransport = async () => ({ kind: "answer", status: 200, body: JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "tool_not_allowed: routine is not an Inbox action. Actions: whoami, send_message." }] } }) });
    expect(await runRoutineCommand(["list"], off.deps)).toBe(1);
    expect(off.err.join("")).not.toContain("update");
  });
});

describe("inbox rows, projects, icon and export-decisions over a pairing", () => {
  /** A cloud machine whose door answers each `route` as the person's Inbox would. */
  function routed(answer: (method: string, path: string, body: unknown) => { status: number; body: unknown; type?: string }) {
    const m = cloudMachine();
    m.deps.pairedTransport = async (tool, body) => {
      m.calls.push({ tool, body: structuredClone(body) });
      const got = answer(String(body.method), String(body.path), body.body);
      const text = typeof got.body === "string" ? got.body : JSON.stringify(got.body);
      return { kind: "answer", status: 200, body: JSON.stringify({ result: { content: [{ type: "text", text: "ok" }], structuredContent: { status: got.status, content_type: got.type ?? "application/json", body: text } } }) };
    };
    const fetchRoute = inboxPairedRouteFetch(m.deps);
    if ("code" in fetchRoute) throw new Error(fetchRoute.message);
    const base = { json: true, ensureRunning: m.deps.ensureRunning, out: m.deps.out, err: m.deps.err, fetchRoute };
    return { ...m, base };
  }

  test("each reaches its route on the person's Inbox through the door, and prints what it prints there", async () => {
    const m = routed((method, path) => {
      if (path === "/api/inbox/settings") return { status: 200, body: { rows: ["subject"] } };
      if (path === "/api/inbox/projects") return { status: 200, body: { projects: [{ id: "prj_1", name: "api", root: "/Users/person/api", threads: 2 }] } };
      if (path.startsWith("/api/inbox/tidy")) return { status: 200, body: { combine: [] } };
      if (path === "/api/inbox/icon-animate") return { status: 200, body: { applied: true, icon: "x" } };
      if (path.includes("/decisions")) return { status: 200, body: "# Decisions\n", type: "text/markdown" };
      return { status: 404, body: { code: "not_found", error: `${method} ${path}` } };
    });
    writeFileSync(join(m.cwd, "icon.svg"), "<svg/>");
    expect(await runInboxRowsCommand([], m.base)).toBe(0);
    expect(await runInboxProjectsCommand([], m.base)).toBe(0);
    expect(await runInboxIconCommand(["set", "icon.svg", "--request", "ia_1"], { ...m.base, cwd: m.cwd })).toBe(0);
    expect(await runInboxExportDecisionsCommand(["--thread", "thr_1"], { ...m.base, cwd: m.cwd })).toBe(0);
    expect(m.calls.map((call) => [call.tool, call.body.method, String(call.body.path).split("?")[0]])).toEqual([
      ["route", "GET", "/api/inbox/settings"],
      ["route", "GET", "/api/inbox/projects"],
      ["route", "GET", "/api/inbox/tidy"],
      ["route", "POST", "/api/inbox/icon-animate"],
      ["route", "GET", "/api/inbox/threads/thr_1/decisions"],
    ]);
    expect(m.out.join("")).toContain('"name": "api"');
    expect(m.out.at(-1)).toBe("# Decisions\n");
    // The file's dates are the person's zone, which their Inbox knows: no zone of this machine's is sent.
    const asked = m.calls.filter((call) => String(call.body.path).includes("/decisions"));
    expect(asked.map((call) => [String(call.body.path).includes("tz="), JSON.stringify(call.body.body ?? {}).includes('"tz"')])).toEqual([[false, false]]);
    expect(m.err).toEqual([]);
  });

  test("a rows change sends only the rows (the door names the agent), and the Inbox's refusal is printed as its own", async () => {
    const m = routed((method) => (method === "GET" ? { status: 200, body: { rows: ["smallNames"] } } : { status: 409, body: { code: "busy", error: "Try again." } }));
    expect(await runInboxRowsCommand(["set", "spacing=roomy"], m.base)).toBe(1);
    const post = m.calls.find((call) => call.body.method === "POST")!;
    expect(Object.keys(post.body.body as object)).toEqual(["rows"]);
    expect(m.err.join("")).toBe("busy: Try again.\n");
  });
});
