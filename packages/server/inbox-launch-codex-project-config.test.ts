/**
 * Codex project-level `.codex/config.toml` preflight (#4000): when `plannotator-inbox` is
 * registered only in a trusted project's `.codex/config.toml` (not globally in
 * `CODEX_HOME/config.toml`), routines and compose targeting a folder in that project must
 * pass preflight, while untrusted projects, unconfigured folders, disabled overrides, and
 * escaped/broken project configs continue to refuse cleanly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import { createInboxLaunch } from "./inbox-launch";
import {
  CODEX_PROJECT_CONFIG_MAX_BYTES,
  codexFolderTrusted,
  codexInboxMcpConfigured,
  createCodexLaunchHost,
} from "./inbox-launch-codex";
import { createInboxScheduled } from "./inbox-scheduled";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

const PROJECT_MCP_ENTRY = [
  "[mcp_servers.plannotator-inbox]",
  'command = "plannotator"',
  'args = ["inbox", "mcp"]',
  "",
].join("\n");

function fakeCodexEnv(homeDir: string, codexHomeDir: string): AgentEnvironment {
  const base = createAgentEnvironmentFor({
    platform: process.platform,
    homeDir,
    env: { HOME: homeDir, CODEX_HOME: codexHomeDir },
  });
  return {
    ...base,
    which: (command) => (command === "codex" ? "/fake/bin/codex" : null),
    run: async (argv) => {
      if (argv[1] === "--version") return { exitCode: 0, stdout: "codex-cli 0.171.0\n", stderr: "", timedOut: false };
      if (argv[1] === "login" && argv[2] === "status") return { exitCode: 0, stdout: "", stderr: "Logged in using ChatGPT\n", timedOut: false };
      return { exitCode: 1, stdout: "", stderr: "unexpected command", timedOut: false };
    },
  };
}

function setup(globalConfig: string | ((projectDir: string) => string | null) | null = "") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-codex-proj-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const codexHome = join(home, ".codex");
  const projectDir = join(home, "work", "trusted-repo");
  const otherDir = join(home, "work", "other-repo");
  for (const dir of [home, dataDir, codexHome, projectDir, otherDir]) mkdirSync(dir, { recursive: true });
  const initialConfig = typeof globalConfig === "function" ? globalConfig(projectDir) : globalConfig;
  if (initialConfig !== null) writeFileSync(join(codexHome, "config.toml"), initialConfig);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));

  const beforeDataDir = process.env.PLANNOTATOR_DATA_DIR;
  const beforeSandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
  cleanup.push(() => {
    if (beforeDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = beforeDataDir;
    if (beforeSandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
    else process.env.PLANNOTATOR_TEST_SANDBOX = beforeSandbox;
  });

  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "trusted-repo", root: projectDir });
  const otherProject = store.ensureProject({ name: "other-repo", root: otherDir });
  const env = fakeCodexEnv(home, codexHome);
  let codexHost!: ReturnType<typeof createCodexLaunchHost>;

  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: process.platform,
    loginEnv: async () => ({ HOME: home, PATH: "", CODEX_HOME: codexHome }),
    ownEnv: () => ({ HOME: home, PATH: "", CODEX_HOME: codexHome }),
    installDirs: [],
    displayFolder: (p) => p,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    log: () => {},
    selfCommand: ["plannotator"],
    hosts: (ctx) => {
      codexHost = createCodexLaunchHost({
        ...ctx,
        environment: async () => env,
      });
      return [codexHost];
    },
  });
  cleanup.push(() => launch.stop());

  const scheduled = createInboxScheduled({
    store,
    launch,
    on: () => true,
    launchOn: () => true,
    resolveProject: async (p) => (p === projectDir ? project : store.ensureProject({ name: "folder", root: p })),
    recordAttachments: async () => [],
    log: () => {},
  });
  cleanup.push(() => scheduled.stop());

  return { root, home, dataDir, codexHome, projectDir, otherDir, project, otherProject, store, launch, codexHost, scheduled };
}

function writeProjectCodexConfig(dir: string, content: string) {
  mkdirSync(join(dir, ".codex"), { recursive: true });
  writeFileSync(join(dir, ".codex", "config.toml"), content);
}

describe("Codex project-level .codex/config.toml preflight (#4000)", () => {
  test("trusted project with .codex/config.toml plannotator-inbox passes preflight, composeBlock, prepare, and scheduled run", async () => {
    const t = setup();
    writeFileSync(join(t.codexHome, "config.toml"), `[projects.${JSON.stringify(t.projectDir)}]\ntrust_level = "trusted"\n`);
    writeProjectCodexConfig(t.projectDir, PROJECT_MCP_ENTRY);

    expect(await t.codexHost.available()).toMatchObject({ ok: false, code: "tool_off" });
    expect(await t.codexHost.available([t.projectDir])).toEqual({ ok: true, version: "0.171.0" });
    expect(await t.codexHost.available([t.otherDir])).toMatchObject({ ok: false, code: "tool_off" });
    expect(await t.codexHost.available([t.otherDir, t.projectDir])).toEqual({ ok: true, version: "0.171.0" });

    // Compose offers Codex when at least one local project trusts and registers it,
    // while preparing in an unrelated project or scratch still refuses.
    const block = (await t.launch.composeBlock())!;
    expect(block.agents.map((a) => a.agent)).toContain("codex");

    const prepared = await t.launch.prepare(
      t.launch.target({ launch: { agent: "codex", project_id: t.project.id } })!,
      { name: "Routine check", body: "Check tests.", resolveProject: async () => t.project },
    );
    expect(prepared.launch.folder).toBe(t.projectDir);

    await expect(
      t.launch.prepare(t.launch.target({ launch: { agent: "codex", project_id: t.otherProject.id } })!, { name: "Other", body: "Hi", resolveProject: async () => t.otherProject }),
    ).rejects.toThrow("Plannotator's Inbox is not connected to Codex");

    // Scheduled routine targeting the trusted project passes preflight instead of filing a tool_off failure line.
    const created = await t.scheduled.create(
      { name: "Nightly", prompt: "Run checks.", folder: { project_id: t.project.id }, agent: "codex", schedule: null },
      { kind: "person" },
    );
    const { message: runMessage } = await t.scheduled.runNow(created.record.id, { kind: "person" });
    expect(runMessage.scheduled_run?.failed).toBeUndefined();
    expect(runMessage.launch?.folder).toBe(t.projectDir);
  });

  test("untrusted project or explicitly untrusted entry refuses project-level .codex/config.toml", async () => {
    const t = setup();
    writeProjectCodexConfig(t.projectDir, PROJECT_MCP_ENTRY);
    expect(await t.codexHost.available([t.projectDir])).toMatchObject({ ok: false, code: "tool_off" });

    writeFileSync(join(t.codexHome, "config.toml"), `[projects.${JSON.stringify(t.projectDir)}]\ntrust_level = "untrusted"\n`);
    expect(await t.codexHost.available([t.projectDir])).toMatchObject({ ok: false, code: "tool_off" });
  });

  test("subfolder inside a trusted git repo inherits repo .codex/config.toml and respects nested repo boundary", async () => {
    const t = setup();
    mkdirSync(join(t.projectDir, ".git"), { recursive: true });
    writeFileSync(join(t.projectDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    const sub = join(t.projectDir, "packages", "api");
    const nested = join(t.projectDir, "vendor", "subrepo");
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(nested, ".git"), { recursive: true });
    writeFileSync(join(nested, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(t.codexHome, "config.toml"), `[projects.${JSON.stringify(t.projectDir)}]\ntrust_level = "trusted"\n`);
    writeProjectCodexConfig(t.projectDir, PROJECT_MCP_ENTRY);

    expect(await t.codexHost.available([sub])).toEqual({ ok: true, version: "0.171.0" });
    expect(await t.codexHost.available([nested])).toMatchObject({ ok: false, code: "tool_off" });

    // Scheduled routine targeting the subfolder path directly passes preflight, whereas scratch still refuses.
    const pathRoutine = await t.scheduled.create(
      { name: "Subdir run", prompt: "Check package.", folder: { path: sub }, agent: "codex", schedule: null },
      { kind: "person" },
    );
    const { message: pathRun } = await t.scheduled.runNow(pathRoutine.record.id, { kind: "person" });
    expect(pathRun.scheduled_run?.failed).toBeUndefined();
    expect(pathRun.launch?.folder).toBe(sub);

    const scratchRoutine = await t.scheduled.create(
      { name: "Scratch run", prompt: "Scratch.", folder: { scratch: true }, agent: "codex", schedule: null },
      { kind: "person" },
    );
    const { message: scratchRun } = await t.scheduled.runNow(scratchRoutine.record.id, { kind: "person" });
    expect(scratchRun.scheduled_run?.failed).toContain("not connected to Codex");
  });

  test("windows project trust paths match case-insensitively and across / and \\ separators", () => {
    const winForward = '[projects."c:/users/dev/Repo"]\ntrust_level = "trusted"\n';
    expect(codexFolderTrusted(winForward, "C:\\Users\\Dev\\Repo", "win32")).toBe(true);
    expect(codexFolderTrusted(winForward, "C:\\Users\\Dev\\Other", "win32")).toBe(false);
    expect(codexInboxMcpConfigured(null, [], "win32")).toBe(false);

    const t = setup();
    mkdirSync(join(t.projectDir, ".git"), { recursive: true });
    writeFileSync(join(t.projectDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    const sub = join(t.projectDir, "sub");
    mkdirSync(sub, { recursive: true });
    const parentWin = t.projectDir.replace(/\//g, "\\");
    const childSlash = sub.replace(/\\/g, "/").toLowerCase();
    const mixed = `[projects.${JSON.stringify(parentWin)}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(childSlash)}]\ntrust_level = "untrusted"\n`;
    expect(codexFolderTrusted(mixed, sub, "win32")).toBe(false);
  });

  test("project-level enabled = false disables global entry for that project, and enabled = true re-enables disabled global entry", async () => {
    const t = setup((dir) =>
      [
        `[projects.${JSON.stringify(dir)}]`,
        'trust_level = "trusted"',
        "",
        "[mcp_servers.plannotator-inbox]",
        'command = "plannotator"',
        'args = ["inbox", "mcp"]',
        "",
      ].join("\n"),
    );
    writeProjectCodexConfig(t.projectDir, "[mcp_servers.plannotator-inbox]\nenabled = false\n");

    expect(await t.codexHost.available()).toEqual({ ok: true, version: "0.171.0" });
    expect(await t.codexHost.available([t.projectDir])).toMatchObject({ ok: false, code: "tool_off" });
    expect(await t.codexHost.available([t.otherDir])).toEqual({ ok: true, version: "0.171.0" });

    // Globally disabled, re-enabled in trusted project layer
    writeFileSync(
      join(t.codexHome, "config.toml"),
      [
        `[projects.${JSON.stringify(t.projectDir)}]`,
        'trust_level = "trusted"',
        "",
        "[mcp_servers.plannotator-inbox]",
        'command = "plannotator"',
        'args = ["inbox", "mcp"]',
        "enabled = false",
        "",
      ].join("\n"),
    );
    writeProjectCodexConfig(t.projectDir, "[mcp_servers.plannotator-inbox]\nenabled = true\n");
    expect(await t.codexHost.available()).toMatchObject({ ok: false, code: "tool_off" });
    expect(await t.codexHost.available([t.projectDir])).toEqual({ ok: true, version: "0.171.0" });
  });

  test("http url mcp entry in trusted project config is accepted; invalid TOML and oversized config are ignored", async () => {
    const t = setup((dir) => `[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`);
    writeProjectCodexConfig(t.projectDir, '[mcp_servers.plannotator-inbox]\nurl = "http://127.0.0.1:4321/mcp"\n');
    expect(await t.codexHost.available([t.projectDir])).toEqual({ ok: true, version: "0.171.0" });

    writeProjectCodexConfig(t.projectDir, "not = valid [toml");
    expect(await t.codexHost.available([t.projectDir])).toMatchObject({ ok: false, code: "tool_off" });

    // Invalid TOML in one folder must not prevent checking remaining valid folders.
    writeFileSync(
      join(t.codexHome, "config.toml"),
      `[projects.${JSON.stringify(t.otherDir)}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(t.projectDir)}]\ntrust_level = "trusted"\n`,
    );
    writeProjectCodexConfig(t.otherDir, "not = valid [toml");
    writeProjectCodexConfig(t.projectDir, PROJECT_MCP_ENTRY);
    expect(await t.codexHost.available([t.otherDir, t.projectDir])).toEqual({ ok: true, version: "0.171.0" });

    writeProjectCodexConfig(t.projectDir, `${PROJECT_MCP_ENTRY}\n# ${"x".repeat(CODEX_PROJECT_CONFIG_MAX_BYTES)}\n`);
    expect(await t.codexHost.available([t.projectDir])).toMatchObject({ ok: false, code: "tool_off" });
  });

  test.skipIf(process.platform === "win32")("symlinked .codex/config.toml pointing outside the project directory is ignored", async () => {
    const t = setup((dir) => `[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`);
    const outside = join(t.root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "config.toml"), PROJECT_MCP_ENTRY);
    mkdirSync(join(t.projectDir, ".codex"), { recursive: true });
    symlinkSync(join(outside, "config.toml"), join(t.projectDir, ".codex", "config.toml"));

    expect(await t.codexHost.available([t.projectDir])).toMatchObject({ ok: false, code: "tool_off" });
  });
});
