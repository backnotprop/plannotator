import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_RUN_START_GRACE_MS } from "@plannotator/core/inbox-run-line";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function setEnv(name: string, value: string) {
  const before = process.env[name];
  process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("one pending-replies pass per sweep, signature, agents and list read; a reply after Stop still restarts the session once", async () => {
  const root = mkdtempSync(join(tmpdir(), "plannotator-launch-one-pass-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "project");
  for (const dir of [dataDir, home, folder]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const clock = { now: Date.parse("2026-11-20T15:00:00.000Z") };
  const store = InboxStore.open(dataDir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "project", root: folder });
  const fake = fakeLaunchHost();
  const engine = () => {
    const made = createInboxLaunch({
      store,
      live: { runStateOf: () => null },
      dataDir,
      serverSession: "srv",
      homeDir: home,
      platform: "darwin",
      loginEnv: async () => ({ HOME: home, PATH: "" }),
      ownEnv: () => ({ HOME: home, PATH: "" }),
      installDirs: [],
      displayFolder: (path) => path,
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      json: (body, status = 200) => Response.json(body, { status }),
      onChange: () => {},
      selfCommand: ["plannotator"],
      hosts: () => [fake.host],
      now: () => clock.now,
    });
    restore.push(() => made.stop());
    return made;
  };
  let launch = engine();

  const answers: string[] = [];
  const launchIds: string[] = [];
  for (const i of [1, 2, 3]) {
    const target = launch.target({ launch: { agent: FAKE, project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: `Task ${i}`, body: `Do ${i}.`, resolveProject: async () => project });
    const message = store.startPersonThread({ project_id: project.id, body: `Do ${i}.`, to: prepared.to, idempotency_key: `send-${i}`, thread_name: `Task ${i}`, launch: prepared.launch }).message;
    launch.begin(message);
    await until(() => !!store.message(message.id)!.launch!.session_ref);
    const session = store.message(message.id)!.to!.session;
    fake.poll(session, false, clock.now);
    store.recordDelivery(message.id, { host: FAKE, session });
    answers.push(store.sendMessage({ project_id: project.id, author: { kind: "agent", host: FAKE, session, name: "Fake Agent" }, body: "Done.", reply_to: message.id, idempotency_key: `answer-${i}` }).message.id);
    launchIds.push(prepared.launch.id);
  }
  await launch.route(
    new Request(`http://127.0.0.1/api/inbox/launch/${launchIds[0]}/stop`, { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv" }) }),
    `/api/inbox/launch/${launchIds[0]}/stop`,
    "local",
  );
  launch.stop();
  clock.now += INBOX_RUN_START_GRACE_MS + 1_000;
  const reply = store.sendReply(answers[0]!, { words: "One more thing.", idempotency_key: "reply-1" }).reply;
  launch = engine();
  store.setDeliveryPresence({ connection: () => null, askerLive: () => false, launchResumes: (threadId, session) => launch.resumes(threadId, session), onePass: (read) => launch.onePass(read) });

  const walks = { each: 0, onePass: 0 };
  const each = store.pendingReplies.bind(store);
  const all = store.pendingRepliesFor.bind(store);
  store.pendingReplies = (...args) => (walks.each++, each(...args));
  store.pendingRepliesFor = (...args) => (walks.onePass++, all(...args));
  restore.push(() => {
    store.pendingReplies = each;
    store.pendingRepliesFor = all;
  });
  const read = (fn: () => unknown) => {
    walks.each = 0;
    walks.onePass = 0;
    fn();
    return { ...walks };
  };

  expect(read(() => launch.sweep(false))).toEqual({ each: 0, onePass: 1 });
  await until(() => fake.calls.includes("resume f1"));
  expect(read(() => launch.signature())).toEqual({ each: 0, onePass: 1 });
  expect(read(() => launch.agents())).toEqual({ each: 0, onePass: 1 });
  expect(read(() => store.listRows())).toEqual({ each: 0, onePass: 1 });
  expect(read(() => store.listRows())).toEqual({ each: 0, onePass: 1 });
  const rows = store.listRows();
  expect(
    read(() => {
      const decorate = launch.rowDecorator();
      for (const row of rows) decorate(row);
    }),
  ).toEqual({ each: 0, onePass: 1 });
  clock.now += INBOX_RUN_START_GRACE_MS + 1_000;
  launch.sweep(false);
  expect(fake.calls.filter((call) => call === "resume f1")).toHaveLength(1);
  const session = store.message(answers[0]!)!.author.session!;
  expect(store.pendingReplies(session, { tags: true }).map((m) => m.id)).toEqual([reply.id]);
  expect(store.pendingRepliesFor(new Set([session]), { tags: true }).get(session)!.map((m) => m.id)).toEqual([reply.id]);
});
