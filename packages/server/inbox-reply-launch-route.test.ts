/**
 * A reply sent to a new session in place of the one that ended, through the real reply route
 * (`POST /api/inbox/messages/:id/reply` with `to.launch`), with the launch engine's fake host. Starts Inboxes: CI
 * runs it. What each test guards: the route writes the reply on the launch's placeholder, takes the thread over and
 * starts the agent once, a replayed key starts nothing more, the thread's run line follows that launch; with starting
 * agents off the route refuses in the switch's words and writes nothing; a linked machine's call without the mark of
 * a press in its window is refused at this machine's door, as New message's launch is.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxMessageWire, InboxRun } from "@plannotator/core/inbox-types";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { startInboxServer, type InboxServer } from "./inbox";
import { MACHINE_WINDOW_HEADER } from "./inbox-outbox";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function setEnv(name: string, value: string | undefined) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

/** No real tailscale ever runs: the loopback transport is the test sandbox's, and serve holds nothing. */
const tailscale: TailscaleRunner = (args) => ({ status: 0, stdout: args[1] === "status" ? "{}" : "", stderr: "" });
/**
 * The Inbox's sessions clock. A fresh Inbox counts every session as there for its first minute, so the test moves it on
 * ten minutes after the start: the asker, never heard from, has ended as a real one does.
 */
const clock = { ahead: 0 };
const sessionsNow = () => Date.now() + clock.ahead;

async function setup(enabled = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-reply-launch-route-")));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const folder = join(root, "ledger");
  mkdirSync(dataDir);
  mkdirSync(folder);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled } }));
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", dataDir);
  setEnv("HOME", join(root, "home"));
  setEnv("PLANNOTATOR_RELAY_URL", "http://127.0.0.1:9");
  const fake = fakeLaunchHost();
  clock.ahead = 0;
  const server: InboxServer = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale, readProjectRepo: async () => null, sessionsNow, launchHosts: () => [fake.host] });
  restore.push(() => server.stop());
  clock.ahead = 10 * 60_000;
  const store = server.store;
  const project = store.ensureProject({ name: "ledger", root: folder });
  const asked = store.sendMessage({
    project_id: project.id,
    author: { kind: "agent", host: "claude-code", session: "ses-asker", name: "Claude Code" },
    body: "How should the nightly sync retry?",
    subject: "Retry policy for the nightly ledger sync",
    wakes: true,
    idempotency_key: "asked",
  }).message;
  const base = `http://127.0.0.1:${server.port}`;
  const replyBody = (key: string) => ({ idempotency_key: key, words: "Retry 3 times with backoff.", questions: [], to: { launch: { agent: FAKE, project_id: project.id } } });
  const reply = (key: string) =>
    fetch(`${base}/api/inbox/messages/${asked.id}/reply`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, ...replyBody(key) }),
    });
  const run = async () => ((await (await fetch(`${base}/api/inbox/threads/${asked.thread_id}`)).json()) as { run?: InboxRun | null }).run;
  return { root, server, store, fake, asked, base, reply, replyBody, run };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

const starts = (calls: string[]) => calls.filter((call) => call.startsWith("start "));

describe("the reply route's `to.launch`", () => {
  test("writes the reply on the launch's placeholder, takes the thread over, starts the agent once; a replay starts nothing more", async () => {
    const { store, fake, asked, reply, run } = await setup();
    const first = await reply("k1");
    expect(first.status).toBe(200);
    const sent = ((await first.json()) as { reply: InboxMessageWire }).reply;
    expect(sent.reply_to).toBe(asked.id);
    expect(sent.to!.session.startsWith("launch:")).toBe(true);
    expect(sent.took_over).toBe(true);
    expect(sent.launch?.agent).toBe(FAKE);
    await until(() => store.message(sent.id)!.launch!.session_ref === "f1");
    expect((await run())?.state).toBe("starting");

    const again = await reply("k1");
    expect(again.status).toBe(200);
    expect((await again.json()) as { reply: InboxMessageWire; replayed: boolean }).toMatchObject({ replayed: true, reply: { id: sent.id } });
    await Bun.sleep(30);
    expect(starts(fake.calls)).toHaveLength(1);
  });

  test("starting agents off: refused in the switch's words, and nothing is written", async () => {
    const { store, fake, asked, reply } = await setup(false);
    const refused = await reply("k1");
    expect(((await refused.json()) as { code: string }).code).toBe("launch_off");
    expect(store.threadMessageIds(asked.thread_id)).toHaveLength(1);
    expect(fake.calls).toEqual([]);
  });

  test("a linked machine's call without the mark of a press in its window is refused at the door; with it, the agent starts", async () => {
    const { root, store, fake, asked, base, replyBody } = await setup();
    // The other machine: a second Inbox, linked to this one as the person links them.
    const otherData = join(root, "other");
    mkdirSync(otherData);
    const other = await startInboxServer({ dataDir: otherData, binaryPath: null, phones: false, tailscale, readProjectRepo: async () => null });
    restore.push(() => other.stop());
    const offered = (await (await fetch(`${base}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as { link: string };
    const otherBase = `http://127.0.0.1:${other.port}`;
    const linked = await fetch(`${otherBase}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: base, back: otherBase }) });
    expect(linked.status).toBe(201);
    const token = (JSON.parse(readFileSync(join(otherData, "inbox", "machines.json"), "utf8")) as { links: { token: string }[] }).links[0]!.token;
    const door = (key: string, window: boolean) =>
      fetch(`${base}/api/inbox/device/messages/${asked.id}/reply`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(window ? { [MACHINE_WINDOW_HEADER]: "1" } : {}) },
        body: JSON.stringify(replyBody(key)),
      });

    const bare = await door("door-1", false);
    expect([bare.status, ((await bare.json()) as { code?: string }).code]).toEqual([403, "window_only"]);
    expect(store.threadMessageIds(asked.thread_id)).toHaveLength(1);
    await Bun.sleep(30);
    expect(fake.calls).toEqual([]);

    const pressed = await door("door-2", true);
    expect(pressed.status).toBe(200);
    await until(() => starts(fake.calls).length === 1);
  }, 60_000);
});
