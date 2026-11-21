/**
 * A paired cloud agent's commands (`PLANNOTATOR_PAIRING`), with the paired call's one request stubbed
 * (`CallCommandDeps.pairedTransport`): no relay, no Inbox. The failures these guard: a command that looks for an
 * Inbox on the agent's own machine (and says the Inbox is off) instead of going through the pairing, a folder or an
 * identity sent through the door, and a picture in the body that never reaches the person.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeInboxAgentPairing } from "@plannotator/shared/inbox/agent-pairing";
import { runCardCommand } from "./card-command";
import { runInboxCallCommand, type CallCommandDeps } from "./inbox-call-command";
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
});
