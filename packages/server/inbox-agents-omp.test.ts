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
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { INBOX_TOOL_OMP_DEFAULT, loadConfig, resolveInboxTool } from "@plannotator/shared/config";
import {
  OMP_EXTENSION_FEATURE,
  agentInstallsSettled,
  connectInboxAgents,
  createAgentEnvironmentFor,
  forgetOmpToolBeforeOff,
  formatConnectReport,
  inboxAgentReach,
  ompPluginDirs,
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

/**
 * A local build as OMP records it: `omp plugin link <path>` (and `omp plugin install <path>`) writes a symlink at
 * `<plugins>/node_modules/@plannotator/pi-extension` and a lock entry, and nothing in the manifest (oh-my-pi
 * plugins/manager.ts `link`, directory-link.ts).
 */
function ompLinked(version: string, opts: { feature?: boolean; manifest?: boolean } = {}): string {
  const dir = join(fake.home, ".omp", "plugins");
  const checkout = join(fake.root, "work", "plannotator", "apps", "pi-extension");
  mkdirSync(checkout, { recursive: true });
  const features = opts.feature === false ? {} : { plannotator: { features: [OMP_EXTENSION_FEATURE] } };
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: PKG, version, ...features }));
  mkdirSync(join(dir, "node_modules", "@plannotator"), { recursive: true });
  const entry = join(dir, "node_modules", "@plannotator", "pi-extension");
  if (!existsSync(entry)) symlinkSync(checkout, entry, "dir");
  if (opts.manifest !== false) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }));
  writeFileSync(join(dir, "omp-plugins.lock.json"), JSON.stringify({ plugins: { [PKG]: { version, enabledFeatures: null, enabled: true } }, settings: {} }));
  return checkout;
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
    const report = await start();
    expect(ompCalls()).toEqual([]);
    // Not "Connected": said once, with why.
    expect(report.added).not.toContain("oh-my-pi");
    expect(report.manual_why).toEqual([{ agent: "oh-my-pi", why: `Plannotator's extension is pinned to 0.28.60 in Oh My Pi, a version with its Inbox tool off there by default. omp plugin install ${PKG} moves it to the newest.` }]);
    expect((await start()).manual_why ?? []).toEqual([]);
    const reach = await inboxAgentReach("oh-my-pi", options());
    expect({ on: reach.on, state: reach.state }).toEqual({ on: false, state: "off" });
    expect(reach.reason).toBe(`Plannotator's extension is pinned to 0.28.60 in Oh My Pi, a version with its Inbox tool off there by default. omp plugin install ${PKG} moves it to the newest.`);
    // Turned on by name, the old extension has its tool: on.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: true } }));
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(true);
  });

  test("a local build in OMP (omp plugin link: a symlink and a lock entry, no manifest entry) is never installed or upgraded over; Settings says so", async () => {
    fake.install("omp");
    for (const manifest of [true, false]) {
      // Without the OMP default: off, with the line, nothing run, also from Settings' switch.
      const checkout = ompLinked("0.28.60", { feature: false, manifest });
      expect((await start()).added).not.toContain("oh-my-pi");
      const reach = await inboxAgentReach("oh-my-pi", options());
      expect({ on: reach.on, state: reach.state, reason: reach.reason }).toEqual({ on: false, state: "off", reason: "A local build is installed in Oh My Pi, left as is." });
      expect(await setInboxAgentReach("oh-my-pi", true, options())).toBeNull();
      // With it: on, still said.
      ompLinked("0.29.1", { manifest });
      const current = await inboxAgentReach("oh-my-pi", options());
      expect({ on: current.on, reason: current.reason }).toEqual({ on: true, reason: "A local build is installed in Oh My Pi, left as is." });
      // Its package unreadable (the checkout moved): still not installed over.
      renameSync(checkout, `${checkout}-moved`);
      await start({}, { version: "0.29.3" });
      rmSync(join(fake.root, "work"), { recursive: true, force: true });
      rmSync(join(fake.home, ".omp"), { recursive: true, force: true });
      rmSync(join(dataDir, "inbox"), { recursive: true, force: true });
    }
    expect(ompCalls()).toEqual([]);
  });

  test("a git spec in OMP's manifest is a local build too: never installed or upgraded over", async () => {
    fake.install("omp");
    ompHas("0.28.60", { spec: "git+https://github.com/backnotprop/plannotator.git", feature: false });
    await start();
    const reach = await inboxAgentReach("oh-my-pi", options());
    expect({ on: reach.on, reason: reach.reason }).toEqual({ on: false, reason: "A local build is installed in Oh My Pi, left as is." });
    expect(ompCalls()).toEqual([]);
  });

  test("OMP's plugin folder: $XDG_DATA_HOME/omp/plugins once $XDG_DATA_HOME/omp exists, on Linux and macOS only, then ~/.omp/plugins", () => {
    const xdg = join(fake.root, "xdg");
    const home = join(fake.home, ".omp", "plugins");
    const dirsOn = (platform: NodeJS.Platform) => ompPluginDirs(createAgentEnvironmentFor({ platform, homeDir: fake.home, env: { ...fake.env, XDG_DATA_HOME: xdg } }));
    expect(dirsOn("linux")).toEqual([home]);
    // omp switches on the omp folder, before it has a plugins folder.
    mkdirSync(join(xdg, "omp"), { recursive: true });
    expect(dirsOn("linux")).toEqual([join(xdg, "omp", "plugins"), home]);
    expect(dirsOn("darwin")).toEqual([join(xdg, "omp", "plugins"), home]);
    expect(dirsOn("win32")).toEqual([home]);
  });

  test("with the XDG omp folder there, a local build linked in ~/.omp/plugins (another agent dir or a profile) is still left as is", async () => {
    fake.install("omp");
    const xdg = join(fake.root, "xdg");
    const xdgPlugins = join(xdg, "omp", "plugins");
    for (const xdgHas of [false, true]) {
      mkdirSync(join(xdg, "omp"), { recursive: true });
      // An older ordinary install in the XDG folder, which would otherwise be upgraded.
      if (xdgHas) {
        mkdirSync(join(xdgPlugins, "node_modules", "@plannotator", "pi-extension"), { recursive: true });
        writeFileSync(join(xdgPlugins, "package.json"), JSON.stringify({ name: "omp-plugins", private: true, dependencies: { [PKG]: "^0.28.60" } }));
        writeFileSync(join(xdgPlugins, "node_modules", "@plannotator", "pi-extension", "package.json"), JSON.stringify({ name: PKG, version: "0.28.60" }));
      }
      ompLinked("0.28.60", { feature: false });
      const withXdg = { XDG_DATA_HOME: xdg };
      expect((await start(withXdg)).added).not.toContain("oh-my-pi");
      const reach = await inboxAgentReach("oh-my-pi", options(withXdg));
      expect({ state: reach.state, reason: reach.reason }).toEqual({ state: "off", reason: "A local build is installed in Oh My Pi, left as is." });
      rmSync(xdg, { recursive: true, force: true });
      rmSync(join(fake.root, "work"), { recursive: true, force: true });
      rmSync(join(fake.home, ".omp"), { recursive: true, force: true });
      rmSync(join(dataDir, "inbox"), { recursive: true, force: true });
    }
    expect(ompCalls()).toEqual([]);
  });

  test("a pin whose package can't be read is still the person's pin: not installed over, said once with why", async () => {
    fake.install("omp");
    ompHas("0.28.60", { spec: "0.28.60" });
    rmSync(pkgFile());
    const reason = `Plannotator's extension is pinned to 0.28.60 in Oh My Pi, a version with its Inbox tool off there by default. omp plugin install ${PKG} moves it to the newest.`;
    const report = await start();
    expect(ompCalls()).toEqual([]);
    expect(report.added).not.toContain("oh-my-pi");
    expect(report.manual_why).toEqual([{ agent: "oh-my-pi", why: reason }]);
    const reach = await inboxAgentReach("oh-my-pi", options());
    expect({ on: reach.on, state: reach.state, reason: reach.reason }).toEqual({ on: false, state: "off", reason });
    expect(await setInboxAgentReach("oh-my-pi", true, options())).toBeNull();
    expect(ompCalls()).toEqual([]);
  });

  test("two starts at once: one install, and only the run that started it says it is installing", async () => {
    fake.install("omp");
    const reports = await Promise.all([connectInboxAgents(options({ FAKE_OMP_DELAY_MS: "300" })), connectInboxAgents(options({ FAKE_OMP_DELAY_MS: "300" }))]);
    await agentInstallsSettled();
    expect(reports.map((report) => report.installing ?? []).flat()).toEqual(["oh-my-pi"]);
    expect(ompCalls()).toEqual([`plugin install ${PKG}`]);
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
    expect((await inboxAgentReach("oh-my-pi", options())).reason).toBe(`Turning this on runs omp plugin install ${PKG}.`);
    expect(await setInboxAgentReach("oh-my-pi", true, options())).toBeNull();
    expect(ompCalls()).toEqual([`plugin install ${PKG}`]);
    expect((await inboxAgentReach("oh-my-pi", options())).on).toBe(true);
    // The switch owned the install: it writes the "Installed… /restart" line.
    expect(readInboxAgents(dataDir).last_report?.installed).toEqual(["oh-my-pi"]);
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

  test("Pi's own switch written after OMP's off: OMP on again never turns Pi back on", async () => {
    fake.install("omp");
    ompHas("0.29.1");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: true } }));
    expect(await setInboxAgentReach("oh-my-pi", false, options())).toBeNull();
    // Pi's own switch in Settings → Agents writes the key: the memory goes.
    fake.install("pi");
    mkdirSync(join(fake.home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(fake.home, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:@plannotator/pi-extension"] }));
    expect(await setInboxAgentReach("pi", false, options())).toBeNull();
    expect(readInboxAgents(dataDir).tool_before_off?.["oh-my-pi"]).toBeUndefined();
    expect(await setInboxAgentReach("oh-my-pi", true, options())).toBeNull();
    expect(JSON.parse(configText()).inboxTool?.pi).not.toBe(true);
    // The same through the inbox_tool settings route's helper.
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: true } }));
    expect(await setInboxAgentReach("oh-my-pi", false, options())).toBeNull();
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: false } }));
    forgetOmpToolBeforeOff(dataDir);
    expect(await setInboxAgentReach("oh-my-pi", true, options())).toBeNull();
    expect(JSON.parse(configText()).inboxTool?.pi).not.toBe(true);
  });

  test("an install that ends while a second run works keeps its record and its /restart line", async () => {
    fake.install("omp");
    await connectInboxAgents(options({ FAKE_OMP_DELAY_MS: "300" }));
    fake.install("amp");
    // The second run reads before the install ends and writes after it (amp hangs until its limit).
    const second = await connectInboxAgents({ ...options({ FAKE_AGENT_HANG: "amp" }), agentTimeoutMs: 1500 });
    await agentInstallsSettled();
    expect(second.installed).toEqual(["oh-my-pi"]);
    const file = readInboxAgents(dataDir);
    expect(file.agents["oh-my-pi"]?.state).toBe("added");
    expect(file.last_report?.installed).toEqual(["oh-my-pi"]);
    expect(ompCalls()).toEqual([`plugin install ${PKG}`]);
  });

  test("an install Settings' switch started is the one install: a start meanwhile waits for it", async () => {
    fake.install("omp");
    const switched = setInboxAgentReach("oh-my-pi", true, options({ FAKE_OMP_DELAY_MS: "600" }));
    await Bun.sleep(100);
    const report = await connectInboxAgents(options({ FAKE_OMP_DELAY_MS: "600" }));
    expect(report.installing ?? []).toEqual([]);
    expect(await switched).toBeNull();
    await agentInstallsSettled();
    expect(ompCalls()).toEqual([`plugin install ${PKG}`]);
  });

  test("omp on PATH is not Pi: Pi is neither found nor connected by it", async () => {
    fake.install("omp");
    const report = await start();
    expect(report.added).not.toContain("pi");
    expect(report.manual).not.toContain("pi");
    expect(fake.calls().filter((call) => call.name === "pi")).toEqual([]);
  });
});
