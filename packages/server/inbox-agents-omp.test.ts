/**
 * Oh My Pi as its own Inbox agent (inbox-agents.ts): with `omp` on PATH the
 * connect step installs Plannotator's extension with OMP's own plugin command
 * (or moves one without the OMP default), off the step's total limit, once,
 * and writes no `inboxTool` key, since that key is Pi's too. A failure is not
 * run again under the same Plannotator; a version the person pinned in OMP is
 * left alone. Fake CLIs in a scratch home (tests/helpers/fake-agents.ts); no
 * real omp is run.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { INBOX_TOOL_OMP_DEFAULT, loadConfig, resolveInboxTool } from "@plannotator/shared/config";
import {
  OMP_EXTENSION_FEATURE,
  agentInstallsSettled,
  connectInboxAgents,
  createAgentEnvironmentFor,
  formatConnectReport,
  inboxAgentReach,
  readInboxAgents,
  setInboxAgentReach,
  type AgentEnvironment,
} from "./inbox-agents";

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
afterEach(async () => {
  await agentInstallsSettled();
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  fake.remove();
});

const environment = (extra: Record<string, string> = {}): AgentEnvironment => createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, ...extra } });
const options = (extra: Record<string, string> = {}, version = "0.29.1") => ({ dataDir, selfCommand: SELF, environment: environment(extra), version });
/** A start of the Inbox: the connect step, then its background install to the end. */
async function start(extra: Record<string, string> = {}, more: { version?: string; totalTimeoutMs?: number } = {}) {
  const report = await connectInboxAgents({ ...options(extra, more.version), ...(more.totalTimeoutMs ? { totalTimeoutMs: more.totalTimeoutMs } : {}) });
  await agentInstallsSettled();
  return report;
}
const ompCalls = () => fake.calls().filter((call) => call.name === "omp").map((call) => call.args.join(" "));
const configText = () => (existsSync(join(dataDir, "config.json")) ? readFileSync(join(dataDir, "config.json"), "utf8") : "");
const pkgFile = () => join(fake.home, ".omp", "plugins", "node_modules", "@plannotator", "pi-extension", "package.json");

/** OMP's plugin folder with Plannotator's extension, as `omp plugin install` leaves it. */
function ompHas(version: string, opts: { spec?: string; feature?: boolean } = {}): void {
  const dir = join(fake.home, ".omp", "plugins");
  mkdirSync(join(dir, "node_modules", "@plannotator", "pi-extension"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "omp-plugins", private: true, dependencies: { [PKG]: opts.spec ?? `^${version}` } }));
  const features = opts.feature === false ? {} : { plannotator: { features: [OMP_EXTENSION_FEATURE] } };
  writeFileSync(pkgFile(), JSON.stringify({ name: PKG, version, ...features }));
}

function installedVersion(): string | null {
  try {
    return JSON.parse(readFileSync(pkgFile(), "utf8")).version;
  } catch {
    return null;
  }
}

describe("Oh My Pi", () => {
  test("the extension this repo publishes says the OMP default the Inbox looks for", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "apps", "pi-extension", "package.json"), "utf8")) as { plannotator?: { features?: string[] } };
    expect(INBOX_TOOL_OMP_DEFAULT).toBe(true);
    expect(pkg.plannotator?.features).toContain(OMP_EXTENSION_FEATURE);
  });

  test("found without the extension: the start installs it in the background from the home folder, says so and the restart, and writes no inboxTool key", async () => {
    fake.install("omp");
    const cwdLog = join(fake.root, "cwd.log");
    expect((await inboxAgentReach("oh-my-pi", options())).state).toBe("not_connected");
    const report = await connectInboxAgents(options({ FAKE_AGENT_CWD_LOG: cwdLog }));
    expect(report.installing).toEqual(["oh-my-pi"]);
    expect(formatConnectReport(report)).toContain("Installing Plannotator's extension in Oh My Pi in the background; the Inbox says when it is done.");
    await agentInstallsSettled();
    expect(ompCalls()).toEqual([`plugin install ${PKG}`]);
    const cwds = readFileSync(cwdLog, "utf8").trim().split("\n").map((line) => JSON.parse(line).cwd as string);
    expect(cwds.map((cwd) => realpathSync(cwd))).toEqual([realpathSync(fake.home)]);
    expect(installedVersion()).toBe("9.9.9");
    expect(configText()).not.toContain("inboxTool");
    const file = readInboxAgents(dataDir);
    expect(file.agents["oh-my-pi"]?.state).toBe("added");
    expect(file.last_report?.installed).toEqual(["oh-my-pi"]);
    expect(formatConnectReport(file.last_report!)).toContain("Installed Plannotator's extension in Oh My Pi. Type /restart in each open Oh My Pi session to load it.");
    const reach = await inboxAgentReach("oh-my-pi", options());
    expect({ kind: reach.kind, on: reach.on, state: reach.state }).toEqual({ kind: "tool", on: true, state: "connected" });
    // A record now: the next start runs nothing.
    await start();
    expect(ompCalls()).toHaveLength(1);
  });

  test("an install slower than the step's total limit is not cut off: it finishes in the background", async () => {
    fake.install("omp");
    const report = await connectInboxAgents({ ...options({ FAKE_OMP_DELAY_MS: "1200" }), totalTimeoutMs: 200 });
    expect(report.unfinished).toEqual([]);
    expect(report.installing).toEqual(["oh-my-pi"]);
    expect(installedVersion()).toBeNull();
    await agentInstallsSettled();
    expect(installedVersion()).toBe("9.9.9");
    expect(readInboxAgents(dataDir).agents["oh-my-pi"]?.state).toBe("added");
  });

  test("one install at a time: a start while one runs, and Settings' switch, wait for it instead of starting another", async () => {
    fake.install("omp");
    await connectInboxAgents(options({ FAKE_OMP_DELAY_MS: "800" }));
    const again = await connectInboxAgents(options({ FAKE_OMP_DELAY_MS: "800" }));
    expect(again.installing ?? []).toEqual([]);
    expect(await setInboxAgentReach("oh-my-pi", true, options({ FAKE_OMP_DELAY_MS: "800" }))).toBeNull();
    await agentInstallsSettled();
    expect(ompCalls()).toEqual([`plugin install ${PKG}`]);
  });

  test("an extension without the OMP default (0.29.0) is moved with omp plugin upgrade", async () => {
    fake.install("omp");
    ompHas("0.29.0", { feature: false });
    await start();
    expect(ompCalls()).toEqual([`plugin upgrade ${PKG}`]);
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(true);
  });

  test("npm has no release with the OMP default yet: said as it is, and not fetched again under the same Plannotator", async () => {
    fake.install("omp");
    ompHas("0.29.0", { feature: false });
    const lagging = { FAKE_OMP_LATEST: "0.29.0", FAKE_OMP_FEATURE: "0" };
    await start(lagging);
    const file = readInboxAgents(dataDir);
    expect(file.last_report?.failed).toEqual([{ agent: "oh-my-pi", reason: `omp plugin upgrade ${PKG} ran, but Oh My Pi still has an older Plannotator extension (0.29.0)`, path: null }]);
    await start(lagging);
    expect(ompCalls()).toHaveLength(1);
    // After an update (another Plannotator), it is tried again.
    await start({}, { version: "0.29.2" });
    expect(ompCalls()).toHaveLength(2);
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(true);
  });

  test("a folder whose package can't be read (an install cut short) is installed again", async () => {
    fake.install("omp");
    ompHas("0.29.1");
    rmSync(pkgFile());
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(false);
    await start();
    expect(ompCalls()).toEqual([`plugin install ${PKG}`]);
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(true);
  });

  test("a version the person pinned in OMP is left as is; Settings says why its tool is off and does not offer to turn it on", async () => {
    fake.install("omp");
    ompHas("0.28.60", { spec: "0.28.60", feature: false });
    await start();
    expect(ompCalls()).toEqual([]);
    const reach = await inboxAgentReach("oh-my-pi", options());
    expect({ on: reach.on, state: reach.state }).toEqual({ on: false, state: "off" });
    expect(reach.reason).toBe(`Plannotator's extension is pinned to 0.28.60 in Oh My Pi, which has no Inbox tool there by default. omp plugin install ${PKG} moves it to the newest`);
    // Turned on by name, the old extension has its tool: on.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: true } }));
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(true);
  });

  test("a current extension: nothing is run, and OMP shows its tool on while Pi's own default stays off", async () => {
    fake.install("omp");
    ompHas("0.29.1");
    await start();
    expect(ompCalls()).toEqual([]);
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(true);
    expect(resolveInboxTool(loadConfig(), {}, "pi")).toBe(false);
  });

  test("the person turned the tool off by name (inboxTool.pi false): left off, nothing installed", async () => {
    fake.install("omp");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: false } }));
    await start();
    expect(ompCalls()).toEqual([]);
    expect(readInboxAgents(dataDir).agents["oh-my-pi"]?.state).toBe("off");
    const reach = await inboxAgentReach("oh-my-pi", options());
    expect({ on: reach.on, state: reach.state }).toEqual({ on: false, state: "off" });
  });

  test("omp fails: said once with its reason, not run again under the same Plannotator, run again after an update", async () => {
    fake.install("omp");
    await start({ FAKE_AGENT_FAIL: "omp" });
    const file = readInboxAgents(dataDir);
    expect(file.last_report?.failed).toEqual([
      { agent: "oh-my-pi", reason: `omp plugin install ${PKG} exited with code 3 (boom: omp could not write its config (permission denied))`, path: null },
    ]);
    expect(file.agents["oh-my-pi"]).toBeUndefined();
    await start({ FAKE_AGENT_FAIL: "omp" });
    expect(ompCalls()).toHaveLength(1);
    await start({}, { version: "0.29.2" });
    expect(ompCalls()).toHaveLength(2);
    expect(installedVersion()).toBe("9.9.9");
  });

  test("Settings' switch installs the extension; off and on again puts back a Pi turned on by name", async () => {
    fake.install("omp");
    expect((await inboxAgentReach("oh-my-pi", options())).reason).toBe(`Turning this on runs omp plugin install ${PKG}`);
    expect(await setInboxAgentReach("oh-my-pi", true, options())).toBeNull();
    expect(ompCalls()).toEqual([`plugin install ${PKG}`]);
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(true);
    // Nothing set: off writes pi:false, on takes it out again.
    expect(await setInboxAgentReach("oh-my-pi", false, options())).toBeNull();
    expect(JSON.parse(configText()).inboxTool).toEqual({ pi: false });
    expect(await setInboxAgentReach("oh-my-pi", true, options())).toBeNull();
    expect(JSON.parse(configText()).inboxTool).toEqual({});
    // Pi on by name: off, then on, leaves Pi on.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: true } }));
    expect(await setInboxAgentReach("oh-my-pi", false, options())).toBeNull();
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(false);
    expect(await setInboxAgentReach("oh-my-pi", true, options())).toBeNull();
    expect(JSON.parse(configText()).inboxTool).toEqual({ pi: true });
    expect(ompCalls()).toHaveLength(1);
  });

  test("omp on PATH is not Pi: Pi is neither found nor connected by it", async () => {
    fake.install("omp");
    const report = await start();
    expect(report.added).not.toContain("pi");
    expect(report.manual).not.toContain("pi");
    expect(fake.calls().filter((call) => call.name === "pi")).toEqual([]);
  });
});
