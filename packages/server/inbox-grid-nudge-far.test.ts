/**
 * Grid's Nudge across linked computers (approval "inbox-agent-grid", round 4; the owner, 2026-11-24: "Whatever I can do
 * on one computer, I should be able to do across computers"), on two real Inboxes linked both ways, Grid on. Studio's
 * window nudges a stale line whose thread lives on the Mini: the row Studio reads carries where the nudge goes on the
 * Mini, the nudge goes through the reply route's forward and lands in the Mini's thread once, as the person's reply
 * with its words exactly, and Studio's next read says when it went. The Mini asleep: the press is held (202) and
 * delivered once when it is back, never twice. Starts two Inboxes: CI runs it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer } from "./inbox";
import { waitFor } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

/** No real tailscale ever runs: serve holds nothing. */
const tailscale: TailscaleRunner = (args) => ({ status: 0, stdout: args[1] === "status" ? "{}" : "", stderr: "" });
const ASK = "Please finish it, or tell me in a few words why it stopped.";

describe("a nudge on another computer's thread", () => {
  const dirs: string[] = [];
  const was = { sandbox: process.env.PLANNOTATOR_TEST_SANDBOX, experimental: process.env.PLANNOTATOR_EXPERIMENTAL };
  beforeAll(() => {
    process.env.PLANNOTATOR_TEST_SANDBOX = "1";
    process.env.PLANNOTATOR_EXPERIMENTAL = "grid";
  });
  afterAll(() => {
    if (was.sandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
    else process.env.PLANNOTATOR_TEST_SANDBOX = was.sandbox;
    if (was.experimental === undefined) delete process.env.PLANNOTATOR_EXPERIMENTAL;
    else process.env.PLANNOTATOR_EXPERIMENTAL = was.experimental;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  const start = (dataDir: string) => startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale });
  const at = (port: number) => `http://127.0.0.1:${port}`;
  const get = async (port: number, path: string) => (await (await fetch(`${at(port)}${path}`)).json()) as Json;
  const post = async (port: number, path: string, body: Json) => {
    const health = await get(port, "/api/inbox/health");
    return fetch(`${at(port)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: at(port) }, body: JSON.stringify({ serverSession: health.serverSession, ...body }) });
  };
  const gridRow = async (port: number, thread: string) =>
    ((await get(port, "/api/inbox/threads?archived=exclude&snoozed=exclude&machines=1&grid=1")).sections as Json[]).flatMap((s) => s.threads as Json[]).find((row) => row.thread_id === thread);

  test("lands once in the Mini's thread as the person's reply, its words exactly; held while the Mini sleeps, delivered once", async () => {
    const dataStudio = scratch("plannotator-grid-nudge-studio-");
    const dataMini = scratch("plannotator-grid-nudge-mini-");
    const studio = await start(dataStudio);
    let mini = await start(dataMini);
    try {
      const offered = (await (await fetch(`${at(mini.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(studio.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(mini.port), back: at(studio.port) }) });
      expect(linked.status).toBe(201);
      const miniId = (JSON.parse(readFileSync(join(dataStudio, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;

      // The Mini's agent opened a PR thread and went quiet.
      const project = mini.store.ensureProject({ name: "harbor", root: "/work/harbor" });
      const agent = { kind: "agent" as const, host: "claude-code", session: "ses_tide", name: "Claude Code" };
      const opened = mini.store.sendMessage({ project_id: project.id, author: agent, thread: "Haptics on save", body: "Opened #22." }).message;
      const failing = mini.store.sendMessage({ project_id: project.id, author: agent, body: "One test fails on the simulator.", reply_to: opened.id }).message;

      // Studio's Grid read carries where a nudge goes on the Mini.
      await waitFor("the Mini's row on Studio's Grid read", async () => (await gridRow(studio.port, opened.thread_id))?.grid_nudge?.to === failing.id, 20_000);
      const row = (await gridRow(studio.port, opened.thread_id))!;
      expect(row.machine).toBe(miniId);
      // `seq`: the thread's newest seq on the Mini, which a reply forwarded there must carry (Rule 11).
      expect(row.grid_nudge).toEqual({ to: failing.id, seq: mini.store.messageCursor(failing.id)!, last: null });

      const words = `Haptics on save has been quiet for 3 h 37 min, with tests failing on #22 since 8:05 PM. ${ASK}`;
      const nudge = (key: string) =>
        post(studio.port, `/api/inbox/m/${miniId}/messages/${failing.id}/reply`, { idempotency_key: key, words, questions: [], seen_through_seq: row.grid_nudge!.seq, nudge: { quiet_from: failing.created_at } });
      const nudgesOnMini = () => mini.store.thread(opened.thread_id)!.messages.filter((m) => m.nudge);

      expect((await nudge("grid-nudge-far-1")).status).toBe(200);
      expect((await nudge("grid-nudge-far-1")).status).toBe(200);
      expect(nudgesOnMini().length).toBe(1);
      const first = nudgesOnMini()[0]!;
      expect([first.author.kind, first.body, first.to?.session]).toEqual(["person", words, "ses_tide"]);
      expect("nudge" in mini.store.agentThread(opened.thread_id)!.messages.at(-1)!).toBe(false);
      await waitFor("the nudge on Studio's Grid read", async () => (await gridRow(studio.port, opened.thread_id))?.grid_nudge?.last?.at === first.created_at, 20_000);

      // The Mini asleep: held (202), delivered once when it is back, and a second press of the same key writes nothing.
      mini.stop();
      await waitFor("the Mini offline on Studio", async () => ((await get(studio.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === miniId)?.state === "offline", 30_000);
      expect((await nudge("grid-nudge-far-2")).status).toBe(202);
      mini = await start(dataMini);
      await waitFor("the held nudge on the Mini", () => nudgesOnMini().length === 2, 45_000);
      expect((await nudge("grid-nudge-far-2")).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(nudgesOnMini().length).toBe(2);
      expect(nudgesOnMini().map((m) => m.body)).toEqual([words, words]);
    } finally {
      studio.stop();
      mini.stop();
    }
  }, 120_000);
});
