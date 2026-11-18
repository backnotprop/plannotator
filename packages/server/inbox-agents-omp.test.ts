/**
 * Oh My Pi as its own Inbox agent (inbox-agents.ts): with `omp` on PATH the
 * connect step installs Plannotator's extension with OMP's own plugin command
 * (or moves an old one whose Inbox tool is off), and writes no `inboxTool`
 * key, since that key is Pi's too. Settings shows OMP's own state. Fake CLIs
 * in a scratch home (tests/helpers/fake-agents.ts); no real omp is run.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { loadConfig, resolveInboxTool } from "@plannotator/shared/config";
import { connectInboxAgents, createAgentEnvironmentFor, inboxAgentReach, readInboxAgents, setInboxAgentReach, type AgentEnvironment } from "./inbox-agents";

const SELF = ["/opt/plannotator/bin/plannotator"];
const PKG = "@plannotator/pi-extension";

let fake: FakeAgents;
let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  fake = createFakeAgents();
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  fake.remove();
});

const environment = (extra: Record<string, string> = {}): AgentEnvironment => createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, ...extra } });
const options = (extra: Record<string, string> = {}) => ({ dataDir, selfCommand: SELF, environment: environment(extra) });
const connect = (extra: Record<string, string> = {}) => connectInboxAgents(options(extra));
const ompCalls = () => fake.calls().filter((call) => call.name === "omp").map((call) => call.args.join(" "));
const configText = () => (existsSync(join(dataDir, "config.json")) ? readFileSync(join(dataDir, "config.json"), "utf8") : "");

/** OMP's plugin folder with Plannotator's extension at `version`, as `omp plugin install` leaves it. */
function ompHas(version: string): void {
  const dir = join(fake.home, ".omp", "plugins");
  mkdirSync(join(dir, "node_modules", "@plannotator", "pi-extension"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "omp-plugins", private: true, dependencies: { [PKG]: `^${version}` } }));
  writeFileSync(join(dir, "node_modules", "@plannotator", "pi-extension", "package.json"), JSON.stringify({ name: PKG, version }));
}

function installedVersion(): string | null {
  try {
    return JSON.parse(readFileSync(join(fake.home, ".omp", "plugins", "node_modules", "@plannotator", "pi-extension", "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

describe("Oh My Pi", () => {
  test("found on PATH without the extension: the run installs it from the home folder, writes no inboxTool key, and it reaches the Inbox", async () => {
    fake.install("omp");
    const cwdLog = join(fake.root, "cwd.log");
    expect((await inboxAgentReach("oh-my-pi", options())).state).toBe("not_connected");
    const report = await connect({ FAKE_AGENT_CWD_LOG: cwdLog });
    expect(report.added).toEqual(["oh-my-pi"]);
    expect(report.failed).toEqual([]);
    expect(ompCalls()).toEqual([`plugin install ${PKG}`]);
    const cwds = readFileSync(cwdLog, "utf8").trim().split("\n").map((line) => JSON.parse(line).cwd as string);
    expect(cwds.map((cwd) => realpathSync(cwd))).toEqual([realpathSync(fake.home)]);
    expect(installedVersion()).toBe("9.9.9");
    // The `pi` key would turn Pi's tool on too: nothing is written.
    expect(configText()).not.toContain("inboxTool");
    const reach = await inboxAgentReach("oh-my-pi", options());
    expect({ kind: reach.kind, on: reach.on, state: reach.state }).toEqual({ kind: "tool", on: true, state: "connected" });
    // A second run has a record and runs nothing.
    expect((await connect()).added).toEqual([]);
    expect(ompCalls()).toHaveLength(1);
  });

  test("an extension too old to have the tool on in OMP (0.29.0) is moved with omp plugin upgrade", async () => {
    fake.install("omp");
    ompHas("0.29.0");
    expect((await connect()).added).toEqual(["oh-my-pi"]);
    expect(ompCalls()).toEqual([`plugin upgrade ${PKG}`]);
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(true);
  });

  test("a current extension: nothing is run, and OMP shows its tool on while Pi's own default stays off", async () => {
    fake.install("omp");
    ompHas("0.29.1");
    expect((await connect()).added).toEqual(["oh-my-pi"]);
    expect(ompCalls()).toEqual([]);
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(true);
    // Pi's Settings row reads Pi's own value, which this left alone.
    expect(resolveInboxTool(loadConfig(), {}, "pi")).toBe(false);
  });

  test("the person turned the tool off by name (inboxTool.pi false): left off, nothing installed", async () => {
    fake.install("omp");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: false } }));
    await connect();
    expect(ompCalls()).toEqual([]);
    expect(readInboxAgents(dataDir).agents["oh-my-pi"]?.state).toBe("off");
    const reach = await inboxAgentReach("oh-my-pi", options());
    expect({ on: reach.on, state: reach.state }).toEqual({ on: false, state: "off" });
  });

  test("omp fails: reported with its reason, nothing recorded, tried again at the next run", async () => {
    fake.install("omp");
    const report = await connect({ FAKE_AGENT_FAIL: "omp" });
    expect(report.added).toEqual([]);
    expect(report.failed).toEqual([
      { agent: "oh-my-pi", reason: `omp plugin install ${PKG} exited with code 3 (boom: omp could not write its config (permission denied))`, path: null },
    ]);
    expect(readInboxAgents(dataDir).agents["oh-my-pi"]).toBeUndefined();
    expect((await connect()).added).toEqual(["oh-my-pi"]);
    expect(installedVersion()).toBe("9.9.9");
  });

  test("Settings' switch on installs the extension; on again after off clears pi:false so Pi's own default comes back", async () => {
    fake.install("omp");
    const before = await inboxAgentReach("oh-my-pi", options());
    expect(before.reason).toBe(`Turning this on runs omp plugin install ${PKG}`);
    expect(await setInboxAgentReach("oh-my-pi", true, options())).toBeNull();
    expect(ompCalls()).toEqual([`plugin install ${PKG}`]);
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(true);
    expect(await setInboxAgentReach("oh-my-pi", false, options())).toBeNull();
    expect(JSON.parse(configText()).inboxTool).toEqual({ pi: false });
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(false);
    expect(await setInboxAgentReach("oh-my-pi", true, options())).toBeNull();
    expect(JSON.parse(configText()).inboxTool).toEqual({});
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(true);
    expect(ompCalls()).toHaveLength(1);
  });

  test("omp on PATH is not Pi: Pi is neither found nor connected by it", async () => {
    fake.install("omp");
    const report = await connect();
    expect(report.added).not.toContain("pi");
    expect(report.manual).not.toContain("pi");
    expect(fake.calls().filter((call) => call.name === "pi")).toEqual([]);
  });
});
