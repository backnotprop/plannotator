/**
 * The model menu's lists through the launch engine (a real engine over a temp data dir, the test fake as the agent):
 * while a host's lists are being read or could not be read, compose gets them with no saved pick (Default stays
 * picked), a Send is accepted (Default, or a model by the API) and a Default Send keeps the saved pick; OpenCode's
 * default is asked for the folder the owner's window picked in To and said to be for it, never for a folder outside
 * home, gone, or on a network drive; a host's login-read hook that throws never fails
 * the login read. No Inbox is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxLaunchChoices } from "@plannotator/core/inbox-launch-choice";
import { INBOX_SCRATCH_PICK } from "@plannotator/core/inbox-scratch";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";
import { writeLastLaunchChoice } from "./inbox-launch-choice";

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

type Lists = Omit<InboxLaunchChoices, "last">;
const listed: Lists = { models: ["opencode/big-pickle", "ollama/qwen2.5-coder:32b"], efforts: ["low", "high"], effort_word: "Variant" };
const reading: Lists = { models: [], efforts: [], effort_word: "Variant", reading: true };
const unread: Lists = { models: [], efforts: [], effort_word: "Variant", unread: "exit" };

/** `lists`: what the fake's `choices` answers (a function of what it was asked; a never-settling promise for "slow"). */
function setup(lists: (options: { defaultIn?: string | null }) => Promise<Lists | null>, extra: { loginReadThrows?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-choice-engine-")));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(home, "harbor-api");
  // A project outside home, and one on a network drive mounted in home that doesn't answer.
  const outside = join(root, "elsewhere", "billing-svc");
  const nas = join(home, "nas");
  const onNas = join(nas, "footage-tools");
  for (const dir of [dataDir, folder, outside, onNas]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  setEnv("PLANNOTATOR_RELAY_URL", "http://127.0.0.1:9");
  setEnv("PLANNOTATOR_TEST_DRIVES", JSON.stringify({ drives: [{ path: nas, network: true }], slow: [nas] }));
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "harbor-api", root: folder });
  const fake = fakeLaunchHost();
  const asked: { defaultIn?: string | null }[] = [];
  fake.host.choices = (options = {}) => (asked.push(options), lists(options));
  Object.assign(fake.host, { choicesWhileReading: reading });
  if (extra.loginReadThrows) {
    fake.host.loginRead = () => {
      throw new Error("a host's hook broke");
    };
  }
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: "darwin",
    loginEnv: async () => ({ HOME: home, PATH: "/usr/bin:/bin" }),
    ownEnv: () => ({ HOME: home, PATH: "" }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    selfCommand: ["plannotator"],
    hosts: () => [fake.host],
  });
  restore.push(() => launch.stop());
  /** `pick`: the folder the owner's window picked in To (null: the owner's window with none picked); `owner: false`: another site or the device door. */
  const agentOf = async (pick: { agent: string; project: string } | null = null, owner = true) => (await launch.composeBlock(owner ? { pick } : null))!.agents.find((a) => a.agent === FAKE)!;
  const saved = () => JSON.parse(readFileSync(join(dataDir, "inbox", "launch", "last-choice.json"), "utf8"))[FAKE];
  const send = async (launchTo: Record<string, unknown>) => {
    const target = launch.target({ launch: { agent: FAKE, project_id: project.id, ...launchTo } })!;
    return launch.prepare(target, { name: "Tidy the readme", body: "Tidy the readme.", resolveProject: async () => project });
  };
  const projects = {
    outside: store.ensureProject({ name: "billing-svc", root: outside }),
    gone: store.ensureProject({ name: "old-api", root: join(home, "old-api") }),
    onNas: store.ensureProject({ name: "footage-tools", root: onNas }),
  };
  return { dataDir, home, folder, project, projects, fake, launch, asked, agentOf, saved, send };
}

describe("compose's lists while they are being read or could not be read", () => {
  test("the saved pick is not sent with them, so Default stays picked; with a list it is", async () => {
    let answer: Lists = unread;
    const t = setup(async () => answer);
    writeLastLaunchChoice(t.dataDir, FAKE, { model: "ollama/qwen2.5-coder:32b", effort: "high" });
    const failed = await t.agentOf();
    expect(failed.choices).toEqual(unread);
    answer = listed;
    expect((await t.agentOf()).choices!.last).toEqual({ model: "ollama/qwen2.5-coder:32b", effort: "high" });
  });

  test("a read longer than the wait answers the host's being-read lists, with no saved pick", async () => {
    const t = setup(() => new Promise(() => {}));
    writeLastLaunchChoice(t.dataDir, FAKE, { model: "ollama/qwen2.5-coder:32b" });
    expect((await t.agentOf()).choices).toEqual(reading);
  });

  test("a Send with Default, and one with a model by the API, are accepted; a Default Send keeps the saved pick", async () => {
    const t = setup(async () => unread);
    writeLastLaunchChoice(t.dataDir, FAKE, { model: "ollama/qwen2.5-coder:32b", effort: "high" });
    const plain = await t.send({});
    expect(plain.launch.model).toBeUndefined();
    expect(t.saved()).toEqual({ model: "ollama/qwen2.5-coder:32b", effort: "high" });
    const picked = await t.send({ model: "opencode/big-pickle", effort: "low" });
    expect(picked.launch).toMatchObject({ model: "opencode/big-pickle", effort: "low" });
    expect(t.saved()).toEqual({ model: "opencode/big-pickle", effort: "low" });
  });

  test("with a list read, a Default Send is remembered as Default", async () => {
    const t = setup(async () => listed);
    writeLastLaunchChoice(t.dataDir, FAKE, { model: "ollama/qwen2.5-coder:32b" });
    await t.send({});
    expect(t.saved()).toEqual({});
  });
});

describe("the default model is asked for in the folder To names", () => {
  test("a project here: read in its folder and said to be for it; the scratch pick: the home folder; another agent's pick or none: not asked", async () => {
    const t = setup(async (options) => (options.defaultIn !== undefined ? { ...listed, default_model: "opencode/big-pickle" } : listed));
    const named = await t.agentOf({ agent: FAKE, project: t.project.id });
    expect(t.asked.at(-1)).toEqual({ defaultIn: t.folder });
    expect(named.choices).toMatchObject({ default_model: "opencode/big-pickle", default_for: t.project.id });
    const scratch = await t.agentOf({ agent: FAKE, project: INBOX_SCRATCH_PICK });
    expect(t.asked.at(-1)).toEqual({ defaultIn: null });
    expect(scratch.choices!.default_for).toBe(INBOX_SCRATCH_PICK);
    await t.agentOf({ agent: "claude-code", project: t.project.id });
    expect(t.asked.at(-1)).toEqual({});
    await t.agentOf(null);
    expect(t.asked.at(-1)).toEqual({});
    // A project id this Inbox does not have: no default is asked for (never a name read somewhere else).
    const unknown = await t.agentOf({ agent: FAKE, project: "prj_not_here" });
    expect(t.asked.at(-1)).toEqual({});
    expect(unknown.choices!.default_for).toBeUndefined();
  });

  test("a project outside home, one whose folder is gone, and one on a network drive that doesn't answer: no folder is read", async () => {
    const t = setup(async (options) => (options.defaultIn !== undefined ? { ...listed, default_model: "opencode/big-pickle" } : listed));
    for (const project of [t.projects.outside, t.projects.gone, t.projects.onNas]) {
      const block = await t.agentOf({ agent: FAKE, project: project.id });
      expect({ project: project.name, asked: t.asked.at(-1) }).toEqual({ project: project.name, asked: {} });
      expect(block.choices!.default_for).toBeUndefined();
    }
  });
});

describe("a host's login-read hook", () => {
  test("that throws never fails the login read a Send waits on", async () => {
    const t = setup(async () => listed, { loginReadThrows: true });
    const prepared = await t.send({});
    expect(prepared.launch.agent).toBe(FAKE);
  });
});
