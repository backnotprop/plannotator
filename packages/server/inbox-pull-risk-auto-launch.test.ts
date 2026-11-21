import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxPullStacks, type InboxLaunchAgent, type InboxPull } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";
import { readLastLaunchChoice, writeLastLaunchChoice } from "./inbox-launch-choice";
import type { LaunchHost } from "./inbox-launch-host";
import { lastStartedReviewAgent, pullRiskAutoAgent, pullRiskAutoSettled, pullRiskAutoStart } from "./inbox-pull-risk-auto-start";

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

const pull: InboxPull = {
  key: "github.com/northwind/web-app#880",
  platform: "github",
  host: "github.com",
  repo: "northwind/web-app",
  number: 880,
  url: "https://github.com/northwind/web-app/pull/880",
  title: "Retry failed charges",
  author: "tomas",
  mine: false,
  author_member: true,
  requested: true,
  state: "open",
  base: "main",
  head: "retry",
  head_repo: "northwind/web-app",
  head_sha: "a".repeat(40),
  additions: 3,
  deletions: 1,
  files: 1,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: "success",
  updated_at: "2026-11-18T09:00:00.000Z",
  merged_at: null,
};

const CODEX = "codex" as InboxLaunchAgent;
const codexHost = (available = true): LaunchHost => ({
  ...fakeLaunchHost().host,
  agent: CODEX,
  name: "Codex",
  available: async () => (available ? { ok: true, version: "1.0.0" } : { ok: false, code: "not_installed", text: "Codex isn't installed." }),
  choices: async () => ({ models: ["gpt-5", "gpt-5-mini"], efforts: ["low", "high"], effort_word: "Reasoning" }),
});

function setup(full: boolean, more: LaunchHost[] = []) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-pull-risk-auto-launch-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "web-app");
  for (const dir of [dataDir, home, folder]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "web-app", root: folder });
  const fake = fakeLaunchHost();
  const host = { ...fake.host, startOf: () => ({ full, ownMode: false, bypass: full }), choices: async () => ({ models: ["opus", "sonnet"], efforts: ["low", "high"], effort_word: "Effort" }) };
  const launch = createInboxLaunch({
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
    hosts: () => [host, ...more],
  });
  restore.push(() => launch.stop());
  const pick = { launch, lastReviewAgent: () => lastStartedReviewAgent(store, store.threadsOf(project.id).map((thread) => thread.thread_id)) };
  const start = pullRiskAutoStart({
    ...pick,
    store,
    resolveProject: async () => project,
    projectOf: async () => project.id,
    skillsBlock: () => "",
    own: () => {},
  });
  const job = { key: pull.key, stack: inboxPullStacks([pull])[0]!, made: "picture_it" as const, agent: FAKE, level: "high" as const };
  const reviewOn = (agent: InboxLaunchAgent, at: string, key = `review-${agent}`) =>
    store.startPersonThread({ project_id: project.id, body: `Review on ${agent}`, to: { host: agent, session: `launch:${key}` }, idempotency_key: key, launch: { id: key, agent, session_ref: null, folder, scratch: false, started_at: at } });
  return { dataDir, store, project, fake, start, job, pick, reviewOn };
}

test("an automatic start keeps the person's remembered model and effort, and its thread says the Inbox sent it", async () => {
  const w = setup(false);
  writeLastLaunchChoice(w.dataDir, FAKE, { model: "opus", effort: "high" });
  const { thread_id } = await w.start(w.job);
  expect(readLastLaunchChoice(w.dataDir, FAKE)).toEqual({ model: "opus", effort: "high" });
  const root = w.store.message(thread_id)!;
  expect(root.body.split("\n")[0]).toBe("The Inbox sent this on its own, because this pull request ranked High risk.");
  expect(root.launch?.agent).toBe(FAKE);
});

test("with full permissions on it still starts by itself", async () => {
  const w = setup(true);
  const { thread_id } = await w.start(w.job);
  expect(w.store.message(thread_id)!.launch?.full_permissions).toBe(true);
});

test("an automatic run is done once its thread has what was asked for after it started, or its agent ended", async () => {
  const w = setup(false);
  const { thread_id } = await w.start(w.job);
  const links = {
    threadsOf: () => [],
    threadMessageIds: (id: string) => w.store.threadMessageIds(id),
    message: (id: string) => w.store.message(id),
    threadSubject: () => null,
    threadProject: () => w.project.id,
    sessionLive: () => true,
    launchDead: () => false,
  };
  const run = { made: "picture_it" as const, at: "2026-11-18T09:00:00.000Z", started_at: w.store.message(thread_id)!.created_at, thread_id };
  expect(pullRiskAutoSettled(links, run)).toBe(false);
  expect(pullRiskAutoSettled({ ...links, launchDead: () => true }, run)).toBe(true);
  const page = { ...w.store.message(thread_id)!, id: "msg_page", reply_to: thread_id, author: { kind: "agent" as const, host: "fake-agent", session: "s1", name: null }, created_at: "2099-01-01T00:00:00.000Z", picture_it: { attachment_id: "att_1", title: "Retries" } };
  const withPage = { ...links, threadMessageIds: (id: string) => [...w.store.threadMessageIds(id), page.id], message: (id: string) => (id === page.id ? page : w.store.message(id)) };
  expect(pullRiskAutoSettled(withPage, run)).toBe(true);
  expect(pullRiskAutoSettled(withPage, { ...run, made: "guide" })).toBe(false);
  expect(pullRiskAutoSettled(withPage, { ...run, started_at: "2100-01-01T00:00:00.000Z" })).toBe(false);
});

test("an automatic run whose thread was deleted is done, so the next one can start", async () => {
  const w = setup(false);
  const thread_id = w.store.startPersonThread({ project_id: w.project.id, body: "Review #880", to: { host: "codex", session: "ses_c" }, idempotency_key: "pull-risk-auto:880" }).message.thread_id;
  const links = {
    threadsOf: () => [],
    threadMessageIds: (id: string) => w.store.threadMessageIds(id),
    message: (id: string) => w.store.message(id),
    threadSubject: () => null,
    threadProject: () => w.project.id,
    sessionLive: () => true,
    launchDead: () => false,
  };
  const run = { made: "guide" as const, at: "2026-11-18T09:00:00.000Z", started_at: w.store.message(thread_id)!.created_at, thread_id };
  expect(pullRiskAutoSettled(links, run)).toBe(false);
  w.store.deleteThread(thread_id);
  expect(pullRiskAutoSettled(links, run)).toBe(true);
});

test("with no agent set, the run starts the agent of the review the person started last, with its remembered model, and names it", async () => {
  const w = setup(false, [codexHost()]);
  writeLastLaunchChoice(w.dataDir, FAKE, { model: "sonnet", effort: "low" });
  w.reviewOn(CODEX, "2026-11-18T08:00:00.000Z");
  w.reviewOn(FAKE, "2026-11-18T09:00:00.000Z");
  w.reviewOn(CODEX, "2026-11-18T10:00:00.000Z", "pull-risk-auto:github.com/northwind/web-app#1");
  const named = await pullRiskAutoAgent(w.pick, null);
  const { thread_id } = await w.start({ ...w.job, agent: null });
  const launched = w.store.message(thread_id)!.launch!;
  expect([launched.agent, launched.model, launched.effort]).toEqual([FAKE, "sonnet", "low"]);
  expect(named).toMatchObject({ agent: launched.agent, name: "Fake Agent" });
  expect(readLastLaunchChoice(w.dataDir, FAKE)).toEqual({ model: "sonnet", effort: "low" });
});

test("the agent set in config wins over the last review's", async () => {
  const w = setup(false, [codexHost()]);
  w.reviewOn(CODEX, "2026-11-18T09:00:00.000Z");
  const { thread_id } = await w.start(w.job);
  expect(w.store.message(thread_id)!.launch?.agent).toBe(FAKE);
});

test("the last review's agent no longer available: the first one that is", async () => {
  const w = setup(false, [codexHost(false)]);
  w.reviewOn(CODEX, "2026-11-18T09:00:00.000Z");
  const { thread_id } = await w.start({ ...w.job, agent: null });
  expect(w.store.message(thread_id)!.launch?.agent).toBe(FAKE);
  expect(await pullRiskAutoAgent(w.pick, null)).toMatchObject({ agent: FAKE, name: "Fake Agent" });
});

test("a remembered effort the agent no longer offers is dropped, and the run starts on its remembered model", async () => {
  const w = setup(false);
  writeLastLaunchChoice(w.dataDir, FAKE, { model: "opus", effort: "max" });
  const { thread_id } = await w.start(w.job);
  const launched = w.store.message(thread_id)!.launch!;
  expect([launched.agent, launched.model, launched.effort]).toEqual([FAKE, "opus", undefined]);
});

test("the agent set in config can't start: the run says why in its name and starts no other", async () => {
  const signedOut: LaunchHost = { ...codexHost(), available: async () => ({ ok: false, missing: false, reason: "signed out", code: "signed_out" }) };
  const w = setup(false, [signedOut]);
  const words = "Codex isn't signed in on this computer. Run `codex login` on this computer, then try again. Already signed in there? In Terminal on this computer itself, run `plannotator inbox restart`.";
  expect(await pullRiskAutoAgent(w.pick, CODEX)).toEqual({ unavailable: words });
  await expect(w.start({ ...w.job, agent: CODEX })).rejects.toThrow(words);
  expect(w.store.threadsOf(w.project.id)).toEqual([]);
});
