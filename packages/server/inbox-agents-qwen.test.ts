/**
 * Qwen Code's connection to the Inbox (inbox-agents.ts), with a fake `qwen`
 * on a scratch PATH and a scratch home (tests/helpers/fake-agents.ts; the real
 * qwen is never run and the real ~/.qwen never read). Plannotator edits Qwen's
 * settings.json itself (JSON with comments), never through `qwen mcp add`,
 * which writes the person's other servers back with their `${VAR}` values
 * filled in (the fake does too). What is guarded here: only Plannotator's
 * entry ever changes, comments and `${VAR}` included, and a file that does not
 * parse or is read-only is left as it is.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { samePlace } from "./agent-files";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import {
  agentSpec,
  connectInboxAgents,
  createAgentEnvironmentFor,
  formatConnectReport,
  inboxAgentReach,
  planInboxAgentRemoval,
  qwenDir,
  readAgentEntry,
  readInboxAgents,
  setInboxAgentReach,
  setMoveRollbackHookForTests,
  type AgentEnvironment,
} from "./inbox-agents";

const SELF = ["/opt/plannotator/bin/plannotator"];

/** Whether the scratch volume ignores case (macOS and Windows by default; Linux never), looked at, never assumed. */
const IGNORES_CASE = (() => {
  const probe = mkdtempSync(join(tmpdir(), "plannotator-case-"));
  try {
    mkdirSync(join(probe, "q"));
    return existsSync(join(probe, "Q"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
const IS_ROOT = process.getuid?.() === 0;
const OURS = [...SELF, "inbox", "mcp"];

let fake: FakeAgents;
let dataDir: string;
let savedDataDir: string | undefined;
let cwdLog: string;

beforeEach(() => {
  fake = createFakeAgents("plannotator-qwen-");
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  cwdLog = join(fake.root, "cwd.log");
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  fake.remove();
});

function environment(extra: Record<string, string> = {}): AgentEnvironment {
  return createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, FAKE_AGENT_CWD_LOG: cwdLog, ...extra } });
}
const options = (extra: Record<string, string> = {}) => ({ dataDir, selfCommand: SELF, environment: environment(extra) });
const connect = (extra: Record<string, string> = {}) => connectInboxAgents(options(extra));
/** Every run of the fake qwen, `--version` included, with the folder it ran in. */
const qwenRuns = (): { args: string[]; cwd: string }[] =>
  existsSync(cwdLog)
    ? readFileSync(cwdLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { name: string; args: string[]; cwd: string })
        .filter((run) => run.name === "qwen")
    : [];
const settingsPath = () => join(fake.home, ".qwen", "settings.json");
const writeSettings = (text: string, path = settingsPath()) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const ENTRY = { command: OURS[0], args: ["inbox", "mcp"] };
/**
 * A person's settings.json as Qwen keeps it: comments, `$version`, and a
 * server whose token comes from the environment (`${GITHUB_TOKEN}`).
 */
const MINE = `{
  // Mine: the token stays in my environment.
  "$version": 3,
  "general": { "vimMode": true },
  "mcpServers": {
    "github": { "command": "gh-mcp", "args": ["--stdio"], "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" } } // keep
  }
}
`;
const SECRET = { GITHUB_TOKEN: "ghp_not_a_real_token_123" };

describe("connecting Qwen Code", () => {
  test("its settings.json gets the entry and nothing else: comments and the person's ${VAR} stay as written, qwen mcp is never run", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    const report = await connect(SECRET);
    expect(report.added).toEqual(["qwen"]);
    const text = readFileSync(settingsPath(), "utf8");
    // Byte for byte, the person's text is all still there; the only new text is the entry.
    expect(text).toContain('"GITHUB_TOKEN": "${GITHUB_TOKEN}" } }, // keep');
    expect(text).toContain("// Mine: the token stays in my environment.");
    expect(text).not.toContain(SECRET.GITHUB_TOKEN);
    expect(readAgentEntry("qwen", environment(), [OURS])).toEqual({ kind: "ours", argv: OURS });
    // `qwen mcp add` writes every server back resolved (the fake does as Qwen 0.26 does): it is never run.
    expect(fake.calls().filter((call) => call.name === "qwen" && call.args[0] === "mcp")).toEqual([]);
    expect(readInboxAgents(dataDir).agents.qwen).toMatchObject({ state: "added", reach: "mcp", path: settingsPath() });
    expect(formatConnectReport(report)[0]).toContain("Qwen Code");

    const again = await connect(SECRET);
    expect(again.added).toEqual([]);
    expect(again.already).toEqual(["qwen"]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(text);
  });

  test("every qwen run is in the home folder, never the Inbox's working folder (Qwen rewrites that folder's .qwen/settings.json); its version is asked once", async () => {
    fake.install("qwen");
    await connect();
    const runs = qwenRuns();
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run.cwd).toBe(fake.home);
    // The connect step and the trusted-sender check share one answer.
    expect(runs.filter((run) => run.args[0] === "--version")).toHaveLength(1);
  });

  test("found by its folder alone (no qwen on PATH): connected the same way", async () => {
    writeSettings(MINE);
    const report = await connect();
    expect(report.added).toEqual(["qwen"]);
    expect(readAgentEntry("qwen", environment(), [OURS])).toEqual({ kind: "ours", argv: OURS });
  });

  test("QWEN_HOME is the folder itself: the entry goes in $QWEN_HOME/settings.json, never ~/.qwen", async () => {
    fake.install("qwen");
    const home = join(fake.root, "elsewhere");
    const report = await connect({ QWEN_HOME: home });
    expect(report.added).toEqual(["qwen"]);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcpServers["plannotator-inbox"]).toEqual(ENTRY);
    expect(existsSync(join(fake.home, ".qwen"))).toBe(false);
    expect(readInboxAgents(dataDir).agents.qwen?.path).toBe(join(home, "settings.json"));
  });

  test("QWEN_HOME as Qwen reads it: `~` expanded, untrimmed, empty is unset, and from ~/.qwen/.env or ~/.env when not in the environment", () => {
    expect(qwenDir(environment({ QWEN_HOME: "~/q" }))).toBe(join(fake.home, "q"));
    expect(qwenDir(environment({ QWEN_HOME: "" }))).toBe(join(fake.home, ".qwen"));
    expect(qwenDir(environment({ QWEN_HOME: "/x/q " }))).toBe("/x/q ");
    writeFileSync(join(fake.home, ".env"), "OTHER=1\nQWEN_HOME=~/from-home-env\n");
    expect(qwenDir(environment())).toBe(join(fake.home, "from-home-env"));
    mkdirSync(join(fake.home, ".qwen"), { recursive: true });
    writeFileSync(join(fake.home, ".qwen", ".env"), "# Qwen's own\nexport QWEN_HOME=\"/srv/qwen\" # moved\n");
    expect(qwenDir(environment())).toBe("/srv/qwen");
    // The environment wins over both files, even empty.
    expect(qwenDir(environment({ QWEN_HOME: "/env/q" }))).toBe("/env/q");
    expect(qwenDir(environment({ QWEN_HOME: "" }))).toBe(join(fake.home, ".qwen"));
  });

  test("a relative QWEN_HOME names a different folder in every project: left to the person, nothing written", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    const report = await connect({ QWEN_HOME: "rel/q" });
    expect(report.manual).toEqual(["qwen"]);
    expect(report.manual_why?.[0]?.why).toContain("QWEN_HOME is a relative path");
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(existsSync(join(fake.home, "rel"))).toBe(false);
  });

  test("a program that only shares the name is never taken for Qwen Code; any Qwen Code version is (a nightly too)", async () => {
    fake.install("qwen");
    const foreign = await connect({ FAKE_QWEN_VERSION: "qwen (image viewer) 3.1" });
    expect(foreign.manual_why).toEqual([{ agent: "qwen", why: "this qwen did not answer like Qwen Code" }]);
    expect(existsSync(settingsPath())).toBe(false);
    const old = await connect({ FAKE_QWEN_VERSION: "0.0.7" });
    expect(old.added).toEqual(["qwen"]);
    const nightly = createFakeAgents("plannotator-qwen-nightly-");
    try {
      nightly.install("qwen");
      const report = await connectInboxAgents({
        dataDir: join(nightly.root, "data"),
        selfCommand: SELF,
        environment: createAgentEnvironmentFor({ platform: "linux", homeDir: nightly.home, env: { ...nightly.env, FAKE_QWEN_VERSION: "0.27.0-nightly.20261027.a1b2c3d" } }),
      });
      expect(report.added).toEqual(["qwen"]);
    } finally {
      nightly.remove();
    }
  });

  test("turned off in Settings: only the entry goes (the file back byte for byte), and a later run never adds it back", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    await connect(SECRET);
    expect(await setInboxAgentReach("qwen", false, options(SECRET))).toBeNull();
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(readInboxAgents(dataDir).agents.qwen?.state).toBe("off");
    const later = await connect(SECRET);
    expect(later.added).toEqual([]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
  });
});

describe("QWEN_HOME is not the same as when the entry was added (set in one shell, not in another)", () => {
  const other = () => join(fake.root, "other-qwen");
  const otherSettings = () => join(other(), "settings.json");
  /** Connected in ~/.qwen with the person's settings, as the shell without QWEN_HOME left it. */
  const connectedInA = async () => {
    fake.install("qwen");
    writeSettings(MINE);
    await connect();
    return { text: readFileSync(settingsPath(), "utf8"), record: readInboxAgents(dataDir).agents.qwen! };
  };

  test("uninstall removes the entry from the file it was written in, byte for byte, and touches nothing in the other home", async () => {
    await connectedInA();
    const plan = planInboxAgentRemoval(dataDir, environment({ QWEN_HOME: other() }), OURS);
    expect(plan.skipped).toEqual([]);
    expect(plan.items.map((item) => item.describe)).toEqual(["MCP server plannotator-inbox from Qwen Code (~/.qwen/settings.json, that entry only)"]);
    expect(await plan.items[0]!.apply()).toBeNull();
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(existsSync(other())).toBe(false);
  });

  test("a run under another QWEN_HOME touches neither file and moves nothing: said once, with how to move it; Settings still shows where it is", async () => {
    const a = await connectedInA();
    const run = await connect({ QWEN_HOME: other() });
    expect(run.added).toEqual([]);
    expect(run.failed).toEqual([]);
    expect(run.elsewhere).toEqual([{ agent: "qwen", path: "~/.qwen/settings.json", now: otherSettings() }]);
    const said = formatConnectReport(run).join("\n");
    expect(said).toContain("~/.qwen/settings.json");
    expect(said).toContain("Settings → Agents");
    expect(readFileSync(settingsPath(), "utf8")).toBe(a.text);
    expect(existsSync(other())).toBe(false);
    expect(readInboxAgents(dataDir).agents.qwen).toEqual(a.record);
    expect((await connect({ QWEN_HOME: other() })).elsewhere ?? []).toEqual([]);
    // Off here, where it is, and turning it on moves it.
    expect(await inboxAgentReach("qwen", options({ QWEN_HOME: other() }))).toMatchObject({ on: false, state: "elsewhere", path: "~/.qwen/settings.json" });
    expect(await inboxAgentReach("qwen", options())).toMatchObject({ on: true, state: "connected", path: "~/.qwen/settings.json" });
  });

  test("said once per change of home: a run from the matching shell keeps it said, and never leaves the other shell's line in this Inbox's band", async () => {
    await connectedInA();
    const said: number[] = [];
    for (const env of [{ QWEN_HOME: other() }, {}, { QWEN_HOME: other() }, {}, { QWEN_HOME: other() }]) {
      said.push((await connect(env)).elsewhere?.length ?? 0);
      // An Inbox whose QWEN_HOME is the recorded one never shows "this Inbox looks in …".
      if (!("QWEN_HOME" in env)) expect(readInboxAgents(dataDir).last_report?.elsewhere ?? []).toEqual([]);
    }
    expect(said).toEqual([1, 0, 0, 0, 0]);
  });

  test("said again after Settings acts: the entry moved here and back, then a run elsewhere", async () => {
    await connectedInA();
    expect((await connect({ QWEN_HOME: other() })).elsewhere).toHaveLength(1);
    expect(await setInboxAgentReach("qwen", true, options({ QWEN_HOME: other() }))).toBeNull();
    expect(await setInboxAgentReach("qwen", true, options())).toBeNull();
    expect(readInboxAgents(dataDir).agents.qwen?.path).toBe(settingsPath());
    expect((await connect({ QWEN_HOME: other() })).elsewhere).toHaveLength(1);
  });

  test("one folder spelled two ways is one place: a symlink, a trailing slash; no move is offered, and turning it on there keeps the entry", async () => {
    fake.install("qwen");
    const real = join(fake.root, "real-qwen");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(fake.home, ".qwen"));
    writeSettings(MINE, join(real, "settings.json"));
    await connect();
    const record = readInboxAgents(dataDir).agents.qwen!;
    expect(record.path).toBe(settingsPath());
    for (const env of [{ QWEN_HOME: real }, { QWEN_HOME: `${real}/` }, { QWEN_HOME: join(fake.home, ".qwen") + "/" }]) {
      expect((await connect(env)).elsewhere ?? []).toEqual([]);
      expect(await inboxAgentReach("qwen", options(env))).toMatchObject({ on: true, state: "connected" });
    }
    // Removed by hand, then turned on through the other spelling: an entry is left.
    writeFileSync(join(real, "settings.json"), MINE);
    await connect();
    expect(await setInboxAgentReach("qwen", true, options({ QWEN_HOME: real }))).toBeNull();
    expect(readAgentEntry("qwen", environment(), [OURS])).toEqual({ kind: "ours", argv: OURS });
  });

  test.if(IGNORES_CASE)("on a volume that ignores case (macOS, Windows), another case is the same folder: the case on disk is what counts", async () => {
    fake.install("qwen");
    await connect();
    for (const platform of ["darwin", "linux"] as const) {
      const env = createAgentEnvironmentFor({ platform, homeDir: fake.home, env: { ...fake.env, QWEN_HOME: join(fake.home, ".QWEN") } });
      expect((await connectInboxAgents({ dataDir, selfCommand: SELF, environment: env })).elsewhere ?? []).toEqual([]);
    }
  });

  test.if(!IGNORES_CASE)("on a case-sensitive volume (Linux), two homes that differ only by case are two homes: a run in the other says where it is, Settings shows it off there", async () => {
    fake.install("qwen");
    const lower = join(fake.root, "qwen");
    const upper = join(fake.root, "Qwen");
    mkdirSync(lower);
    mkdirSync(upper);
    for (const platform of ["darwin", "linux"] as const) {
      expect(samePlace(lower, upper)).toBe(false);
      const at = (home: string) => ({ dataDir, selfCommand: SELF, environment: createAgentEnvironmentFor({ platform, homeDir: fake.home, env: { ...fake.env, QWEN_HOME: home } }) });
      rmSync(join(dataDir, "inbox"), { recursive: true, force: true });
      rmSync(join(lower, "settings.json"), { force: true });
      expect((await connectInboxAgents(at(lower))).added).toEqual(["qwen"]);
      const run = await connectInboxAgents(at(upper));
      expect(run.elsewhere).toEqual([{ agent: "qwen", path: join(lower, "settings.json"), now: join(upper, "settings.json") }]);
      expect(existsSync(join(upper, "settings.json"))).toBe(false);
      expect(await inboxAgentReach("qwen", at(upper))).toMatchObject({ on: false, state: "elsewhere" });
    }
  });

  test("Plannotator never folds case itself: paths that differ only by case and are not made yet compare as written (on a case-sensitive volume they are two folders)", () => {
    const parent = join(fake.root, "not-made");
    expect(samePlace(join(parent, "qwen"), join(parent, "Qwen"))).toBe(false);
    expect(samePlace(join(parent, "qwen"), join(parent, "qwen", "."))).toBe(true);
  });

  test("an entry the person removed by hand: a run under another QWEN_HOME never says it is connected, and never adds it again", async () => {
    await connectedInA();
    writeFileSync(settingsPath(), MINE);
    const run = await connect({ QWEN_HOME: other() });
    expect(run.elsewhere ?? []).toEqual([]);
    expect(formatConnectReport(run).join("\n")).not.toContain("is connected in");
    expect(readInboxAgents(dataDir).agents.qwen?.removed_outside_at).toEqual(expect.any(String));
    expect(existsSync(other())).toBe(false);
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect((await connect()).added).toEqual([]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
  });

  test("an entry a move could not take back out is recorded with the old one, and uninstall removes both", async () => {
    await connectedInA();
    // What a failed rollback leaves (it cannot be forced here: the add and its undo write the same file).
    writeSettings('{\n  "mcpServers": {\n    "plannotator-inbox": { "command": "/opt/plannotator/bin/plannotator", "args": ["inbox", "mcp"] }\n  }\n}\n', otherSettings());
    const agents = JSON.parse(readFileSync(join(dataDir, "inbox", "agents.json"), "utf8"));
    agents.agents.qwen.strays = [{ path: otherSettings(), command: OURS }];
    writeFileSync(join(dataDir, "inbox", "agents.json"), JSON.stringify(agents));
    const plan = planInboxAgentRemoval(dataDir, environment(), OURS);
    expect(plan.items.map((item) => item.describe)).toEqual([
      "MCP server plannotator-inbox from Qwen Code (~/.qwen/settings.json, that entry only)",
      `MCP server plannotator-inbox from Qwen Code (${otherSettings()}, that entry only)`,
    ]);
    for (const item of plan.items) expect(await item.apply()).toBeNull();
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(JSON.parse(readFileSync(otherSettings(), "utf8")).mcpServers).toEqual({});
  });

  /**
   * A move whose rollback failed, made for real: the old file is read-only (its entry cannot go), and the new one
   * turns read-only just before the move takes its entry back out. Both entries are left, the new one recorded.
   */
  const leaveStray = async () => {
    const a = await connectedInA();
    chmodSync(settingsPath(), 0o444);
    setMoveRollbackHookForTests(() => chmodSync(otherSettings(), 0o444));
    try {
      const problem = await setInboxAgentReach("qwen", true, options({ QWEN_HOME: other() }));
      return { ...a, problem };
    } finally {
      setMoveRollbackHookForTests(null);
      chmodSync(settingsPath(), 0o644);
      if (existsSync(otherSettings())) chmodSync(otherSettings(), 0o644);
    }
  };

  test.skipIf(IS_ROOT)("a move that could not take its new entry back out: said plainly, both entries kept and recorded", async () => {
    const a = await leaveStray();
    expect(a.problem).toContain("could not be taken back out");
    expect(a.problem).toContain("plannotator uninstall removes both");
    expect(readAgentEntry("qwen", environment(), [OURS])).toEqual({ kind: "ours", argv: OURS });
    expect(JSON.parse(readFileSync(otherSettings(), "utf8")).mcpServers["plannotator-inbox"]).toEqual(ENTRY);
    const record = readInboxAgents(dataDir).agents.qwen!;
    expect(record).toMatchObject({ state: "added", path: settingsPath() });
    expect(record.strays).toEqual([expect.objectContaining({ path: otherSettings(), command: OURS, created: true })]);
  });

  test.skipIf(IS_ROOT)("the stray entry stays recorded when Settings turns it on where it is: recorded as added there, the old one moved out, uninstall removes it", async () => {
    await leaveStray();
    expect(await inboxAgentReach("qwen", options({ QWEN_HOME: other() }))).toMatchObject({ on: false, state: "elsewhere" });
    expect(await setInboxAgentReach("qwen", true, options({ QWEN_HOME: other() }))).toBeNull();
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    const record = readInboxAgents(dataDir).agents.qwen!;
    expect(record).toMatchObject({ state: "added", path: otherSettings() });
    expect(record.strays).toBeUndefined();
    const plan = planInboxAgentRemoval(dataDir, environment(), OURS);
    expect(plan.items.map((item) => item.describe)).toEqual([`MCP server plannotator-inbox from Qwen Code (${otherSettings()}, that entry only)`]);
    expect(await plan.items[0]!.apply()).toBeNull();
    // Plannotator created that file: it goes with its entry.
    expect(existsSync(otherSettings())).toBe(false);
  });

  test.skipIf(IS_ROOT)("Settings off removes the stray entry too; one that cannot go stays recorded, said, and uninstall removes it later", async () => {
    await leaveStray();
    writeFileSync(otherSettings(), "{ not json");
    const problem = await setInboxAgentReach("qwen", false, options());
    expect(problem).toContain(`Plannotator's entry in ${otherSettings()} could not be removed`);
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(readInboxAgents(dataDir).agents.qwen).toMatchObject({ state: "off", strays: [expect.objectContaining({ path: otherSettings() })] });
    writeSettings('{\n  "mcpServers": {\n    "plannotator-inbox": { "command": "/opt/plannotator/bin/plannotator", "args": ["inbox", "mcp"] }\n  }\n}\n', otherSettings());
    const plan = planInboxAgentRemoval(dataDir, environment(), OURS);
    expect(plan.items.map((item) => item.describe)).toEqual([`MCP server plannotator-inbox from Qwen Code (${otherSettings()}, that entry only)`]);
    expect(await plan.items[0]!.apply()).toBeNull();
    expect(existsSync(otherSettings())).toBe(false);
  });

  test.skipIf(IS_ROOT)("a stray entry the person replaced with their own is theirs: never touched, named once by uninstall, and no longer recorded", async () => {
    await leaveStray();
    const theirs = '{\n  "mcpServers": {\n    "plannotator-inbox": { "command": "/my/own" }\n  }\n}\n';
    writeFileSync(otherSettings(), theirs);
    const plan = planInboxAgentRemoval(dataDir, environment(), OURS);
    expect(plan.items.map((item) => item.describe)).toEqual(["MCP server plannotator-inbox from Qwen Code (~/.qwen/settings.json, that entry only)"]);
    expect(plan.skipped).toEqual([`Qwen Code's "plannotator-inbox" in ${otherSettings()} now runs something else (changed by hand), so it is yours`]);
    expect(await setInboxAgentReach("qwen", false, options())).toBeNull();
    expect(readInboxAgents(dataDir).agents.qwen?.strays).toBeUndefined();
    expect(readFileSync(otherSettings(), "utf8")).toBe(theirs);
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
  });

  test.skipIf(IS_ROOT)("a stray entry the person removed by hand is nothing to do: no item, no longer recorded", async () => {
    await leaveStray();
    writeFileSync(otherSettings(), '{\n  "mcpServers": {}\n}\n');
    expect(planInboxAgentRemoval(dataDir, environment(), OURS).items.map((item) => item.describe)).toEqual(["MCP server plannotator-inbox from Qwen Code (~/.qwen/settings.json, that entry only)"]);
    expect(await setInboxAgentReach("qwen", false, options())).toBeNull();
    expect(readInboxAgents(dataDir).agents.qwen?.strays).toBeUndefined();
  });

  test.skipIf(IS_ROOT)("a move out of a file whose entry the person changed never takes the stray entry instead: it stays, and stays recorded", async () => {
    await leaveStray();
    const theirs = `${MINE.replace('"mcpServers": {', '"mcpServers": {\n    "plannotator-inbox": { "command": "/my/own" },')}`;
    writeFileSync(settingsPath(), theirs);
    const third = join(fake.root, "third-qwen");
    expect(await setInboxAgentReach("qwen", true, options({ QWEN_HOME: third }))).toBeNull();
    expect(JSON.parse(readFileSync(otherSettings(), "utf8")).mcpServers["plannotator-inbox"]).toEqual(ENTRY);
    expect(readFileSync(settingsPath(), "utf8")).toBe(theirs);
    const record = readInboxAgents(dataDir).agents.qwen!;
    expect(record).toMatchObject({ state: "added", path: join(third, "settings.json") });
    expect(record.strays).toEqual([expect.objectContaining({ path: otherSettings() })]);
  });

  test.skipIf(IS_ROOT)("Settings off with both entries removable: both go, nothing left to uninstall", async () => {
    await leaveStray();
    expect(await setInboxAgentReach("qwen", false, options())).toBeNull();
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(existsSync(otherSettings())).toBe(false);
    expect(readInboxAgents(dataDir).agents.qwen?.strays).toBeUndefined();
    expect(planInboxAgentRemoval(dataDir, environment(), OURS).items).toEqual([]);
  });

  test("turning Qwen Code on in Settings under the new QWEN_HOME moves it: added there, then out of the old file (back byte for byte)", async () => {
    await connectedInA();
    await connect({ QWEN_HOME: other() });
    expect(readInboxAgents(dataDir).last_report?.elsewhere).toHaveLength(1);
    expect(await setInboxAgentReach("qwen", true, options({ QWEN_HOME: other() }))).toBeNull();
    // The band no longer says to move it.
    expect(readInboxAgents(dataDir).last_report?.elsewhere ?? []).toEqual([]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(JSON.parse(readFileSync(otherSettings(), "utf8")).mcpServers["plannotator-inbox"]).toEqual(ENTRY);
    expect(readInboxAgents(dataDir).agents.qwen).toMatchObject({ state: "added", path: otherSettings() });
    // Only the new file's entry is left for uninstall, from whichever shell it runs.
    expect(await planInboxAgentRemoval(dataDir, environment(), OURS).items[0]!.apply()).toBeNull();
    expect(existsSync(otherSettings())).toBe(false);
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
  });

  const cannotTake: [string, () => Record<string, string>, () => void][] = [
    ["its settings.json has a trailing comma", () => ({ QWEN_HOME: other() }), () => writeSettings('{\n  "mcpServers": { "x": { "command": "y" }, },\n}\n', otherSettings())],
    ["its settings.json is read-only", () => ({ QWEN_HOME: other() }), () => {
      writeSettings('{\n  "mcpServers": {}\n}\n', otherSettings());
      chmodSync(otherSettings(), 0o444);
    }],
    ["QWEN_HOME is relative", () => ({ QWEN_HOME: "rel/q" }), () => {}],
    ["the qwen on PATH is not Qwen Code", () => ({ QWEN_HOME: other(), FAKE_QWEN_VERSION: "qwen (image viewer) 3.1" }), () => {}],
  ];
  for (const [what, env, prepare] of cannotTake) {
    test.skipIf(process.getuid?.() === 0 && what.includes("read-only"))(`a new home that cannot take the entry (${what}): the old entry and its record stay, the run and Settings say why`, async () => {
      const a = await connectedInA();
      prepare();
      const otherBefore = existsSync(otherSettings()) ? readFileSync(otherSettings(), "utf8") : null;
      try {
        await connect(env());
        const problem = await setInboxAgentReach("qwen", true, options(env()));
        expect(problem).not.toBeNull();
        expect(readFileSync(settingsPath(), "utf8")).toBe(a.text);
        expect(readInboxAgents(dataDir).agents.qwen).toEqual(a.record);
        expect(existsSync(otherSettings()) ? readFileSync(otherSettings(), "utf8") : null).toBe(otherBefore);
        expect(existsSync(join(fake.home, "rel"))).toBe(false);
      } finally {
        if (existsSync(otherSettings())) chmodSync(otherSettings(), 0o644);
      }
    });
  }

  test("an old file the person broke is never cut around: the new entry is taken back out, the broken file stays as it is, the record kept", async () => {
    const a = await connectedInA();
    const broken = `${a.text.trimEnd()},\n`;
    writeFileSync(settingsPath(), broken);
    const problem = await setInboxAgentReach("qwen", true, options({ QWEN_HOME: other() }));
    expect(problem).toContain("can't be read");
    expect(problem).toContain("stays connected in ~/.qwen/settings.json");
    expect(readFileSync(settingsPath(), "utf8")).toBe(broken);
    // The entry it had added there is taken back out (the file it created with it, too).
    expect(existsSync(otherSettings())).toBe(false);
    expect(readInboxAgents(dataDir).agents.qwen).toEqual(a.record);
  });

  test.skipIf(process.getuid?.() === 0)("an old file that cannot be written: the new entry is taken back out, so only the recorded one is ever left", async () => {
    const a = await connectedInA();
    chmodSync(settingsPath(), 0o444);
    try {
      const problem = await setInboxAgentReach("qwen", true, options({ QWEN_HOME: other() }));
      expect(problem).toContain("could not be removed");
      expect(problem).toContain("stays connected in ~/.qwen/settings.json");
      expect(readFileSync(settingsPath(), "utf8")).toBe(a.text);
      expect(existsSync(otherSettings())).toBe(false);
      expect(readInboxAgents(dataDir).agents.qwen).toEqual(a.record);
    } finally {
      chmodSync(settingsPath(), 0o644);
    }
  });

  test("Settings off under another QWEN_HOME removes it from the recorded file", async () => {
    await connectedInA();
    expect(await setInboxAgentReach("qwen", false, options({ QWEN_HOME: other() }))).toBeNull();
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(existsSync(other())).toBe(false);
    expect(readInboxAgents(dataDir).agents.qwen?.state).toBe("off");
  });
});

describe("Qwen's settings.json is never left broken", () => {
  test("a settings.json that is not valid JSON: left byte for byte, the reason said", async () => {
    fake.install("qwen");
    const broken = '{ "mcpServers": { "github": { "command": "gh-mcp" }, \n';
    writeSettings(broken);
    const report = await connect();
    expect(report.failed).toEqual([{ agent: "qwen", reason: "~/.qwen/settings.json can't be read (it is not plain JSON), so Plannotator left it as it was", path: "~/.qwen/settings.json" }]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(broken);
    expect(readInboxAgents(dataDir).agents.qwen).toBeUndefined();
  });

  test("a trailing comma (which Qwen itself refuses) is not valid either: left as it is", async () => {
    const trailing = '{\n  "mcpServers": { "github": { "command": "gh-mcp" }, },\n}\n';
    writeSettings(trailing);
    const report = await connect();
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.reason).toContain("so Plannotator left it as it was");
    expect(readFileSync(settingsPath(), "utf8")).toBe(trailing);
  });

  test.skipIf(process.getuid?.() === 0)("a read-only settings.json: left as it is, the reason said, and a later run tries again", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    chmodSync(settingsPath(), 0o444);
    try {
      const report = await connect();
      expect(report.failed).toEqual([{ agent: "qwen", reason: "~/.qwen/settings.json is read-only, so Plannotator left it as it was", path: "~/.qwen/settings.json" }]);
      expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    } finally {
      chmodSync(settingsPath(), 0o644);
    }
    const later = await connect();
    expect(later.added).toEqual(["qwen"]);
  });

  test("uninstall removes only Plannotator's entry; an entry Qwen reformatted around is cut alone, comments kept", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    await connect();
    // Qwen rewrote the file meanwhile (its own format-keeping writer: another key, the entry where it was).
    const rewritten = readFileSync(settingsPath(), "utf8").replace('"$version": 3,', '"$version": 4,\n  "ui": { "theme": "dark" }, // new');
    writeFileSync(settingsPath(), rewritten);
    const plan = planInboxAgentRemoval(dataDir, environment(), OURS);
    expect(plan.items.map((item) => item.describe)).toEqual(["MCP server plannotator-inbox from Qwen Code (~/.qwen/settings.json, that entry only)"]);
    expect(await plan.items[0]!.apply()).toBeNull();
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE.replace('"$version": 3,', '"$version": 4,\n  "ui": { "theme": "dark" }, // new'));
    expect(fake.calls().filter((call) => call.name === "qwen" && call.args[0] === "mcp")).toEqual([]);
  });

  test("a settings.json Plannotator created is deleted again on removal once only the empty containers are left", async () => {
    fake.install("qwen");
    await connect();
    expect(readInboxAgents(dataDir).agents.qwen?.created).toBe(true);
    expect(await planInboxAgentRemoval(dataDir, environment(), OURS).items[0]!.apply()).toBeNull();
    expect(existsSync(settingsPath())).toBe(false);
  });

  test("an entry the person changed to run something else is theirs: never replaced, never removed", async () => {
    fake.install("qwen");
    writeSettings(JSON.stringify({ mcpServers: { "plannotator-inbox": { command: "my-proxy", args: [] } } }));
    const report = await connect();
    expect(report.foreign).toEqual([{ agent: "qwen", path: "~/.qwen/settings.json" }]);
    expect(planInboxAgentRemoval(dataDir, environment(), OURS).items).toEqual([]);
  });

  test("the spec names Qwen's own folder and file (read with comments, as Qwen reads it)", () => {
    writeSettings('{\n  // mine\n  "mcpServers": { "plannotator-inbox": { "command": "/opt/plannotator/bin/plannotator", "args": ["inbox", "mcp"] } }\n}\n');
    expect(agentSpec("qwen").file(environment())).toBe(settingsPath());
    expect(readAgentEntry("qwen", environment(), [OURS])).toEqual({ kind: "ours", argv: OURS });
  });
});
