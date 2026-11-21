/**
 * OpenCode's model list for New message (Add agent): a person's own models must reach the picker. Feedback from
 * OpenCode on Linux with self-hosted models: they could not start an agent on their models, and sessions went to
 * OpenCode's default instead. Against a small fake `opencode2` (no real OpenCode, no network, no Inbox started).
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { LOGIN_ENV_FALLBACKS, launchSpawnEnv } from "./inbox-launch-env";
import type { LaunchHostContext } from "./inbox-launch-host";
import { createOpenCodeLaunchHost, openCodeErrorText, openCodeFailedTurnText, openCodeTurnErrorNote } from "./inbox-launch-opencode";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

/**
 * `opencode2 --version`, `opencode2 --standalone api GET /api/model/default` (the state file's `default`, else an
 * error; `slowdefault`: 8 s), and `opencode2 --standalone api GET /api/model` (as the `mode` file says: good, slow,
 * exit, garbage, nodata, empty). Every call writes the folder it runs in to `calls.log`, so a test sees that none
 * ran in a project. Its models: the state file's, then each model of each
 * provider in the config named by OPENCODE_CONFIG (as OpenCode adds a file the person points it at). Entries carry the
 * fields a real model has (name, cost, limit, capabilities), so a big catalog is as big as it is in OpenCode.
 */
const FAKE = String.raw`
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify({ cwd: process.cwd(), args }) + "\n");
if (args[0] === "--version") { process.stdout.write("opencode v2.2.7\n"); process.exit(0); }
const mode = fs.existsSync(path.join(__dirname, "mode")) ? fs.readFileSync(path.join(__dirname, "mode"), "utf8").trim() : "good";
if (args[0] === "--standalone" && args[1] === "api" && args[2] === "GET" && args[3] === "/api/model/default") {
  fs.appendFileSync(path.join(__dirname, "defaults.log"), process.cwd() + "\n");
  if (mode === "slowdefault") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000); process.exit(0); }
  const fallback = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8")).default;
  if (!fallback) { process.stderr.write("no default model\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({ data: fallback }));
  process.exit(0);
}
if (args[0] === "--standalone" && args[1] === "api" && args[2] === "GET" && args[3] === "/api/model") {
  fs.appendFileSync(path.join(__dirname, "reads.log"), "model\n");
  // How a list read can go wrong: too slow, an error, an answer that is not the list, a list with no model.
  if (mode === "slow") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000); process.exit(0); }
  if (mode === "exit") { process.stderr.write("Error: provider config at /home/someone/.config/opencode/secret.json is broken\n"); process.exit(1); }
  if (mode === "garbage") { process.stdout.write("Loading plugins...\n{not json"); process.exit(0); }
  if (mode === "nodata") { process.stdout.write(JSON.stringify({ error: "unauthorized" })); process.exit(0); }
  if (mode === "empty") { process.stdout.write(JSON.stringify({ location: {}, data: [] })); process.exit(0); }
  fs.writeFileSync(path.join(__dirname, "env-names.json"), JSON.stringify(Object.keys(process.env)));
  const listed = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8")).models.slice();
  // A provider whose key only the person's shell rc exports (as OpenCode lists a provider once its key is in the env).
  if (process.env.GATEWAY_KEY) listed.push({ providerID: "vercel", id: "gw-model" });
  const extra = process.env.OPENCODE_CONFIG;
  if (extra && fs.existsSync(extra)) {
    const providers = JSON.parse(fs.readFileSync(extra, "utf8")).provider || {};
    for (const [providerID, p] of Object.entries(providers)) for (const id of Object.keys(p.models || {})) listed.push({ providerID, id });
  }
  const entry = (m) => ({
    id: m.id, modelID: m.id, providerID: m.providerID, name: m.id, family: "", enabled: true, status: "active",
    capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true, input: { text: true, audio: false, image: true, video: false, pdf: true }, output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    limit: { context: 200000, output: 64000 },
    release_date: "2026-01-01", variants: [],
  });
  process.stdout.write(JSON.stringify({ location: { directory: process.cwd() }, data: listed.map(entry) }));
  process.exit(0);
}
process.exit(1);
`;

function setup(
  models: { providerID: string; id: string }[],
  options: { loginEnv?: Record<string, string>; ownEnv?: Record<string, string>; noShellRead?: boolean; loginFallback?: boolean; defaultModel?: { providerID: string; id: string } } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-opencode-choices-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const bin = join(root, "bin");
  const configDir = join(home, ".config", "opencode");
  for (const dir of [home, dataDir, bin, configDir]) mkdirSync(dir, { recursive: true });
  const globalConfig = join(configDir, "opencode.json");
  writeFileSync(globalConfig, JSON.stringify({ plugins: ["@plannotator/opencode"] }));
  let defaultModel: { providerID: string; id: string } | null = options.defaultModel ?? null;
  let listed = models;
  const write = () => writeFileSync(join(bin, "state.json"), JSON.stringify({ models: listed, ...(defaultModel ? { default: defaultModel } : {}) }));
  const state = (next: { providerID: string; id: string }[]) => {
    listed = next;
    write();
  };
  const setDefault = (next: { providerID: string; id: string } | null) => {
    defaultModel = next;
    write();
  };
  const mode = (next: "good" | "slow" | "exit" | "garbage" | "nodata" | "empty" | "slowdefault") => writeFileSync(join(bin, "mode"), next);
  /** The folders the default was read in, in order. */
  const defaultReads = () => (existsSync(join(bin, "defaults.log")) ? readFileSync(join(bin, "defaults.log"), "utf8").trim().split("\n") : []);
  state(models);
  writeFileSync(join(bin, "fake-opencode.cjs"), FAKE);
  writeFileSync(join(bin, "opencode2"), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-opencode.cjs")}" "$@"\n`);
  chmodSync(join(bin, "opencode2"), 0o755);
  // The Inbox's own env (a desktop or service start: no shell rc), and the person's login shell's.
  // The sandbox's own names (never the real data dir or relay); the list filter keeps them from opencode2 anyway.
  const own = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9", ...(options.ownEnv ?? {}) };
  const login = { ...own, ...(options.loginEnv ?? {}) };
  // `noShellRead`: no login read finished yet (ctx.shell() is null), so the list read asks for one.
  let loginReads = 0;
  const ctx = {
    dataDir,
    homeDir: home,
    platform: process.platform,
    selfCommand: ["plannotator"],
    ownEnv: () => own,
    environment: async () => createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: launchSpawnEnv(own) }),
    shell: () => (options.noShellRead ? null : login),
    loginEnv: async () => {
      loginReads++;
      if (!options.loginFallback) return login;
      // The shell did not answer: the Inbox's env stands in, marked as `createLoginEnv` marks it.
      const fallback = { ...login };
      LOGIN_ENV_FALLBACKS.add(fallback);
      return fallback;
    },
    launchDir: (id: string) => join(dataDir, "launch", id),
    startLog: () => {},
    displayFolder: (p: string) => p,
    bridge: { runStateOf: () => null },
    log: () => {},
  } as unknown as LaunchHostContext;
  const host = createOpenCodeLaunchHost(ctx);
  cleanup.push(() => host.close());
  const reads = () => (existsSync(join(bin, "reads.log")) ? readFileSync(join(bin, "reads.log"), "utf8").trim().split("\n").length : 0);
  const envNames = () => JSON.parse(readFileSync(join(bin, "env-names.json"), "utf8")) as string[];
  /** Every opencode2 run: the folder it ran in and its arguments. */
  const calls = () =>
    existsSync(join(bin, "calls.log"))
      ? readFileSync(join(bin, "calls.log"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { cwd: string; args: string[] })
      : [];
  /** A project folder in home (a git repo: `.git` in it), with these files. */
  const project = (name: string, files: Record<string, string> = {}) => {
    const dir = join(home, "code", name);
    mkdirSync(join(dir, ".git"), { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    return dir;
  };
  return { host, root, home, bin, globalConfig, state, setDefault, mode, defaultReads, reads, envNames, calls, project, loginReads: () => loginReads };
}

/** Polls until `check` holds (a list read again runs in the background), or fails after `ms`. */
async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

const zen = [
  { providerID: "opencode", id: "big-pickle" },
  { providerID: "opencode", id: "flint-40b-free" },
];
const local = { providerID: "ollama", id: "qwen2.5-coder:32b" };
/** A gateway provider's catalog (Vercel's AI Gateway, OpenRouter): hundreds of models. */
const gateway = Array.from({ length: 400 }, (_, n) => ({ providerID: "vercel", id: `vendor-${n % 20}/model-${n}-instruct` }));

describe("OpenCode's model list reaches the picker", () => {
  test("a long list (a gateway provider adds hundreds of models) still lists every model, the person's local one included", async () => {
    const t = setup([...zen, ...gateway, local]);
    expect((await t.host.available()).ok).toBe(true);
    const choices = await t.host.choices();
    expect(choices).not.toBeNull();
    expect(choices!.models).toContain("ollama/qwen2.5-coder:32b");
    expect(choices!.models).toHaveLength(zen.length + gateway.length + 1);
  });

  test("a provider the person adds to OpenCode's config after the first read shows on the next read", async () => {
    const t = setup(zen);
    expect((await t.host.available()).ok).toBe(true);
    expect((await t.host.choices())!.models).toEqual(["opencode/big-pickle", "opencode/flint-40b-free"]);
    // The person adds their local provider to OpenCode's global config; OpenCode lists it from now on.
    writeFileSync(t.globalConfig, JSON.stringify({ plugins: ["@plannotator/opencode"], provider: { ollama: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:11434/v1" }, models: { "qwen2.5-coder:32b": {} } } } }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(t.globalConfig, later, later);
    t.state([...zen, local]);
    expect((await t.host.available()).ok).toBe(true);
    // The old list is answered at once while the new one is read, then the new one.
    expect((await t.host.choices())!.models).toEqual(["opencode/big-pickle", "opencode/flint-40b-free"]);
    await until(async () => (await t.host.choices())!.models.includes("ollama/qwen2.5-coder:32b"));
    expect(t.reads()).toBe(2);
    // Nothing changed since: no read again.
    await t.host.choices();
    expect(t.reads()).toBe(2);
  });

  test("signing in to a provider (OpenCode's auth.json changes) shows on the next read; the file is only stat'ed, never read", async () => {
    const t = setup(zen);
    expect((await t.host.available()).ok).toBe(true);
    expect((await t.host.choices())!.models).toHaveLength(2);
    const auth = join(t.home, ".local", "share", "opencode", "auth.json");
    mkdirSync(join(t.home, ".local", "share", "opencode"), { recursive: true });
    writeFileSync(auth, JSON.stringify({ ollama: { type: "api", key: "sk-not-real" } }));
    // Not readable: a read of it would fail; a stat still sees it.
    chmodSync(auth, 0o000);
    cleanup.push(() => chmodSync(auth, 0o600));
    t.state([...zen, local]);
    await until(async () => (await t.host.choices())!.models.includes("ollama/qwen2.5-coder:32b"));
    expect(t.reads()).toBe(2);
  });

  test("a config the person's login shell points OpenCode at (OPENCODE_CONFIG) counts, as it does for the session itself", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-opencode-config-")));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "local-models.json");
    writeFileSync(file, JSON.stringify({ provider: { lmstudio: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:1234/v1" }, models: { "qwen/qwen3-coder-30b": {} } } } }));
    const t = setup(zen, { loginEnv: { OPENCODE_CONFIG: file } });
    expect((await t.host.available()).ok).toBe(true);
    // A login read already finished: the first read uses its kept names, never waiting on a shell run.
    expect((await t.host.choices())!.models).toContain("lmstudio/qwen/qwen3-coder-30b");
  });

  test("a key exported only in the shell rc reaches the list when a login read finished before OpenCode's first list read", async () => {
    const t = setup(zen, { loginEnv: { GATEWAY_KEY: "gw-not-real" } });
    expect((await t.host.available()).ok).toBe(true);
    // The first read: the kept names (no key), with one login read started behind it.
    expect((await t.host.choices())!.models).not.toContain("vercel/gw-model");
    // With the whole login env held, the lists are read once again, with the key.
    await until(async () => (await t.host.choices())!.models.includes("vercel/gw-model"));
    expect(t.reads()).toBe(2);
    expect(t.loginReads()).toBe(1);
    for (let n = 0; n < 3; n++) await t.host.choices();
    expect(t.reads()).toBe(2);
    expect(t.loginReads()).toBe(1);
  });

  test("a stand-in env from a shell that did not answer is never held as the login env; a later good login read is", async () => {
    const t = setup(zen, { loginEnv: { GATEWAY_KEY: "gw-not-real" }, loginFallback: true });
    expect((await t.host.available()).ok).toBe(true);
    expect((await t.host.choices())!.models).not.toContain("vercel/gw-model");
    await until(async () => t.loginReads() === 1);
    await Bun.sleep(50);
    for (let n = 0; n < 3; n++) expect((await t.host.choices())!.models).not.toContain("vercel/gw-model");
    expect(t.reads()).toBe(1);
    // Within 5 minutes no other login read for the lists.
    expect(t.loginReads()).toBe(1);
    const standIn = { HOME: t.home, PATH: "/usr/bin:/bin", GATEWAY_KEY: "gw-not-real" };
    LOGIN_ENV_FALLBACKS.add(standIn);
    t.host.loginRead!(standIn);
    await t.host.choices();
    expect(t.reads()).toBe(1);
    // Any good login read the Inbox makes (Settings → Agents, another agent's start) reaches the host.
    t.host.loginRead!({ ...standIn });
    await until(async () => (await t.host.choices())!.models.includes("vercel/gw-model"));
    expect(t.reads()).toBe(2);
  });

  test("with no login read yet, the list read asks for one once, reads with it, and later reads reuse it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-opencode-config-")));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "local-models.json");
    writeFileSync(file, JSON.stringify({ provider: { lmstudio: { models: { "qwen/qwen3-coder-30b": {} } } } }));
    const t = setup(zen, { loginEnv: { OPENCODE_CONFIG: file }, noShellRead: true });
    expect((await t.host.available()).ok).toBe(true);
    expect((await t.host.choices())!.models).toContain("lmstudio/qwen/qwen3-coder-30b");
    writeFileSync(t.globalConfig, JSON.stringify({ plugins: ["@plannotator/opencode"], small_model: "opencode/big-pickle" }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(t.globalConfig, later, later);
    t.state([...zen, local]);
    await until(async () => (await t.host.choices())!.models.includes("ollama/qwen2.5-coder:32b"));
    expect(t.reads()).toBe(2);
    expect(t.loginReads()).toBe(1);
  });

  test("the list read's env has no Plannotator name and no OpenCode server sign-in, from the login env or the Inbox's", async () => {
    const t = setup(zen, {
      ownEnv: { PLANNOTATOR_PORT: "19432", PLANNOTATOR_INBOX_TOOL: "1" },
      loginEnv: { PLANNOTATOR_DATA_DIR: "/somewhere", PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9", PLANNOTATOR_INBOX_TOOL: "1", OPENCODE: "1", OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: "x", MY_GATEWAY_KEY: "k" },
      noShellRead: true,
    });
    expect((await t.host.available()).ok).toBe(true);
    expect(await t.host.choices()).not.toBeNull();
    const names = t.envNames();
    expect(names.filter((name) => name.startsWith("PLANNOTATOR_") || name.startsWith("OPENCODE_SERVER_") || name === "OPENCODE")).toEqual([]);
    // The login env's own names reach OpenCode, as they do the session.
    expect(names).toContain("MY_GATEWAY_KEY");
  });
});

describe("OpenCode's default model and why its list could not be read", () => {
  test("OpenCode's own default is read in the home folder, never waited on; none is read when no folder is named", async () => {
    const t = setup([...zen, local], { defaultModel: { providerID: "opencode", id: "big-pickle" } });
    expect((await t.host.available()).ok).toBe(true);
    expect((await t.host.choices())!.default_model).toBeUndefined();
    expect(t.defaultReads()).toEqual([]);
    // The home folder (a scratch folder not made yet): OpenCode's own default.
    await until(async () => (await t.host.choices({ defaultIn: null }))!.default_model === "opencode/big-pickle");
    expect(t.defaultReads()).toEqual([t.home]);
    const none = setup([...zen, local]);
    expect((await none.host.available()).ok).toBe(true);
    await none.host.choices({ defaultIn: null });
    await until(async () => none.defaultReads().length === 1);
    await Bun.sleep(100);
    // OpenCode can't say: no name, and the list as it is.
    const plain = await none.host.choices({ defaultIn: null });
    expect(plain!.models).toHaveLength(3);
    expect(plain!.default_model).toBeUndefined();
  });

  test("a project's own opencode.json model names it, read as data: opencode2 never runs in the project", async () => {
    // A login read finished before the first list read: the list key stays the same from one read to the next.
    const t = setup([...zen, local], { defaultModel: { providerID: "opencode", id: "big-pickle" }, noShellRead: true });
    const harbor = t.project("harbor-api", { "opencode.json": JSON.stringify({ model: "ollama/qwen2.5-coder:32b" }) });
    const billing = t.project("billing-svc", { "opencode.json": JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: {} }) });
    expect((await t.host.available()).ok).toBe(true);
    // At once: nothing to wait for.
    expect((await t.host.choices({ defaultIn: harbor }))!.default_model).toBe("ollama/qwen2.5-coder:32b");
    // A project that sets no model: OpenCode's own default, read in the home folder.
    await until(async () => (await t.host.choices({ defaultIn: billing }))!.default_model === "opencode/big-pickle");
    expect((await t.host.choices({ defaultIn: harbor }))!.default_model).toBe("ollama/qwen2.5-coder:32b");
    expect(t.defaultReads()).toEqual([t.home]);
    // Nothing ran in either project (nor below one).
    const ranIn = t.calls().map((call) => call.cwd);
    expect(ranIn.length).toBeGreaterThan(0);
    for (const cwd of ranIn) expect(cwd === harbor || cwd.startsWith(`${harbor}/`) || cwd === billing || cwd.startsWith(`${billing}/`)).toBe(false);
    // The list itself is read in the home folder, once.
    expect(t.reads()).toBe(1);
  });

  test("a folder inside a repo finds the nearest config up to the git root, never above it", async () => {
    const t = setup(zen, { defaultModel: { providerID: "opencode", id: "big-pickle" }, noShellRead: true });
    const repo = t.project("mono", { "opencode.json": JSON.stringify({ model: "anthropic/claude-sonnet-4-5" }), "packages/web/opencode.json": JSON.stringify({ model: "openai/gpt-5.5" }) });
    expect((await t.host.available()).ok).toBe(true);
    // Below the root, no config of its own: the root's.
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    expect((await t.host.choices({ defaultIn: join(repo, "packages", "api") }))!.default_model).toBe("anthropic/claude-sonnet-4-5");
    // Its own config: the nearest.
    expect((await t.host.choices({ defaultIn: join(repo, "packages", "web") }))!.default_model).toBe("openai/gpt-5.5");
    // A config above the git root is not the project's: OpenCode's own default.
    writeFileSync(join(t.home, "code", "opencode.json"), JSON.stringify({ model: "ollama/qwen2.5-coder:32b" }));
    const plain = t.project("plain-repo");
    await until(async () => (await t.host.choices({ defaultIn: plain }))!.default_model === "opencode/big-pickle");
  });

  test("opencode.jsonc with comments and trailing commas", async () => {
    const t = setup(zen, { noShellRead: true });
    const dir = t.project("harbor-api", { "opencode.jsonc": '// The team\'s model\n{\n  /* pinned */ "model": "ollama/qwen2.5-coder:32b", // local\n  "mcp": {},\n}\n' });
    expect((await t.host.available()).ok).toBe(true);
    expect((await t.host.choices({ defaultIn: dir }))!.default_model).toBe("ollama/qwen2.5-coder:32b");
  });

  test("a config that is invalid, too big, a link out of the project, or whose model isn't plain names nothing (not even OpenCode's own default)", async () => {
    const t = setup(zen, { defaultModel: { providerID: "opencode", id: "big-pickle" }, noShellRead: true });
    expect((await t.host.available()).ok).toBe(true);
    // OpenCode's own default is known, so a folder that falls back to it would name it.
    await until(async () => (await t.host.choices({ defaultIn: null }))!.default_model === "opencode/big-pickle");
    const secret = join(t.root, "outside.json");
    writeFileSync(secret, JSON.stringify({ model: "ollama/qwen2.5-coder:32b" }));
    const linked = t.project("linked");
    symlinkSync(secret, join(linked, "opencode.json"));
    const folders = {
      invalid: t.project("invalid", { "opencode.json": '{ "model": "ollama/qwen2.5-coder:32b" ' }),
      big: t.project("big", { "opencode.json": JSON.stringify({ model: "ollama/qwen2.5-coder:32b", pad: "x".repeat(300 * 1024) }) }),
      linked,
      notPlain: t.project("not-plain", { "opencode.json": JSON.stringify({ model: "{env:OPENCODE_MODEL}" }) }),
      noProvider: t.project("no-provider", { "opencode.json": JSON.stringify({ model: "big-pickle" }) }),
      agentModel: t.project("agent-model", { "opencode.json": JSON.stringify({ agent: { build: { model: "openai/gpt-5.5" } } }) }),
      bothDisagree: t.project("both", { "opencode.json": JSON.stringify({ model: "openai/gpt-5.5" }), "opencode.jsonc": JSON.stringify({ model: "ollama/qwen2.5-coder:32b" }) }),
      dotOpencode: t.project("dot", { ".opencode/opencode.json": JSON.stringify({ model: "openai/gpt-5.5" }) }),
    };
    for (const [why, dir] of Object.entries(folders)) {
      const choices = await t.host.choices({ defaultIn: dir });
      expect({ why, named: choices!.default_model }).toEqual({ why, named: undefined });
      expect(choices!.models).toHaveLength(2);
    }
  });

  test("a project outside home, or one not there, is not read", async () => {
    const t = setup(zen, { defaultModel: { providerID: "opencode", id: "big-pickle" }, noShellRead: true });
    expect((await t.host.available()).ok).toBe(true);
    await until(async () => (await t.host.choices({ defaultIn: null }))!.default_model === "opencode/big-pickle");
    const outside = join(t.root, "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "opencode.json"), JSON.stringify({ model: "ollama/qwen2.5-coder:32b" }));
    expect((await t.host.choices({ defaultIn: outside }))!.default_model).toBeUndefined();
    expect((await t.host.choices({ defaultIn: join(t.home, "code", "gone") }))!.default_model).toBeUndefined();
  });

  test("a project's config edited: the next read names the new model", async () => {
    const t = setup(zen, { defaultModel: { providerID: "opencode", id: "big-pickle" }, noShellRead: true });
    const dir = t.project("harbor-api", { "opencode.json": JSON.stringify({ model: "ollama/qwen2.5-coder:32b" }) });
    expect((await t.host.available()).ok).toBe(true);
    expect((await t.host.choices({ defaultIn: dir }))!.default_model).toBe("ollama/qwen2.5-coder:32b");
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ model: "openai/gpt-5.5" }));
    expect((await t.host.choices({ defaultIn: dir }))!.default_model).toBe("openai/gpt-5.5");
    // Its model taken out: OpenCode's own default.
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({}));
    await until(async () => (await t.host.choices({ defaultIn: dir }))!.default_model === "opencode/big-pickle");
  });

  test("a default read that fails names nothing, and is tried again after the list's wait", async () => {
    const t = setup(zen, { noShellRead: true });
    expect((await t.host.available()).ok).toBe(true);
    await t.host.choices({ defaultIn: null });
    await until(async () => t.defaultReads().length === 1);
    await Bun.sleep(100);
    t.setDefault({ providerID: "opencode", id: "big-pickle" });
    // Within the wait (15 s): not read again, nothing named.
    expect((await t.host.choices({ defaultIn: null }))!.default_model).toBeUndefined();
    expect(t.defaultReads()).toHaveLength(1);
    // Past it: read again, and named.
    setSystemTime(new Date(Date.now() + 16_000));
    cleanup.push(() => setSystemTime());
    await until(async () => (await t.host.choices({ defaultIn: null }))!.default_model === "opencode/big-pickle");
    expect(t.defaultReads()).toHaveLength(2);
  });

  test("a slow default read never holds the list: the list answers at once, the name comes on a later read", async () => {
    const t = setup(zen, { defaultModel: { providerID: "opencode", id: "big-pickle" } });
    expect((await t.host.available()).ok).toBe(true);
    t.mode("slowdefault");
    const started = Date.now();
    const choices = await t.host.choices({ defaultIn: null });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(choices!.models).toHaveLength(2);
    expect(choices!.default_model).toBeUndefined();
  });

  test("a config change (a new list key) reads the default again", async () => {
    const t = setup(zen, { defaultModel: { providerID: "opencode", id: "big-pickle" }, noShellRead: true });
    expect((await t.host.available()).ok).toBe(true);
    await until(async () => (await t.host.choices({ defaultIn: null }))!.default_model === "opencode/big-pickle");
    t.setDefault({ providerID: "opencode", id: "flint-40b-free" });
    // Unchanged config: the kept name.
    expect((await t.host.choices({ defaultIn: null }))!.default_model).toBe("opencode/big-pickle");
    writeFileSync(t.globalConfig, JSON.stringify({ plugins: ["@plannotator/opencode"], model: "opencode/flint-40b-free" }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(t.globalConfig, later, later);
    await until(async () => (await t.host.choices({ defaultIn: null }))!.default_model === "opencode/flint-40b-free");
  });

  test("each way a list read fails says why as a code, never what OpenCode printed", async () => {
    for (const [mode, why] of [
      ["exit", "exit"],
      ["garbage", "unreadable"],
      ["nodata", "unreadable"],
    ] as const) {
      const t = setup(zen, { defaultModel: { providerID: "opencode", id: "big-pickle" } });
      expect((await t.host.available()).ok).toBe(true);
      t.mode(mode);
      const choices = await t.host.choices();
      expect({ mode, unread: choices!.unread }).toEqual({ mode, unread: why });
      expect(choices!.models).toEqual([]);
      expect(choices!.default_model).toBeUndefined();
      expect(JSON.stringify(choices)).not.toContain("secret");
      expect(JSON.stringify(choices)).not.toContain(t.root);
    }
  });

  test("a list read and found empty is told apart from one that could not be read", async () => {
    const t = setup(zen);
    expect((await t.host.available()).ok).toBe(true);
    t.mode("empty");
    expect((await t.host.choices())!.unread).toBe("empty");
  });

  test("a list read longer than 5 seconds says so", async () => {
    const t = setup(zen);
    expect((await t.host.available()).ok).toBe(true);
    t.mode("slow");
    expect((await t.host.choices())!.unread).toBe("timeout");
  }, 20_000);

  test("an opencode2 gone since it was found, or one that can't start, says so", async () => {
    const t = setup(zen);
    expect((await t.host.available()).ok).toBe(true);
    // Its interpreter is gone: the run can't start.
    writeFileSync(join(t.bin, "opencode2"), "#!/nonexistent/interpreter\n");
    expect((await t.host.choices())!.unread).toBe("not_started");
    const u = setup(zen);
    expect((await u.host.available()).ok).toBe(true);
    renameSync(join(u.bin, "opencode2"), join(u.bin, "opencode2-moved"));
    expect((await u.host.choices())!.unread).toBe("missing");
  });

  test("a failed read is answered with its reason, not read again within its wait", async () => {
    // A login read finished before the first list read: the key stays the same from one read to the next.
    const t = setup(zen, { noShellRead: true });
    expect((await t.host.available()).ok).toBe(true);
    t.mode("exit");
    expect((await t.host.choices())!.unread).toBe("exit");
    t.mode("good");
    // Within the wait after a failure (15 s): the same reason, no read again.
    expect((await t.host.choices())!.unread).toBe("exit");
    expect(t.reads()).toBe(1);
  });

  test("while a good list is served for a changed config, a failed read of the new config shows no reason: the list shows as it was", async () => {
    const t = setup(zen, { defaultModel: { providerID: "opencode", id: "big-pickle" } });
    expect((await t.host.available()).ok).toBe(true);
    expect((await t.host.choices())!.models).toHaveLength(2);
    t.mode("exit");
    writeFileSync(t.globalConfig, JSON.stringify({ plugins: ["@plannotator/opencode"], provider: { broken: {} } }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(t.globalConfig, later, later);
    expect((await t.host.available()).ok).toBe(true);
    const served = await t.host.choices();
    expect(served!.unread).toBeUndefined();
    expect(served!.models).toHaveLength(2);
    await until(async () => t.reads() === 2);
    await Bun.sleep(100);
    const after = await t.host.choices();
    expect(after!.unread).toBeUndefined();
    expect(after!.models).toHaveLength(2);
  });

  test("the being-read lists are the host's own: empty, with Variant, and say they are being read", () => {
    const t = setup(zen);
    expect(t.host.choicesWhileReading).toEqual({ models: [], efforts: [], effort_word: "Variant", reading: true });
  });
});

describe("a failed turn's note says what OpenCode said", () => {
  test("a nested error ({ name, data: { message } }) reads its message, then message, then name; never [object Object]", () => {
    expect(openCodeErrorText({ name: "ProviderAuthError", data: { message: "No API key for ollama" } })).toBe("No API key for ollama");
    expect(openCodeErrorText({ name: "APIError", message: "Rate limited" })).toBe("Rate limited");
    expect(openCodeErrorText({ name: "UnknownError", data: {} })).toBe("UnknownError");
    expect(openCodeErrorText("connection refused")).toBe("connection refused");
    expect(openCodeErrorText(500)).toBe("500");
    expect(openCodeErrorText(false)).toBe("false");
    for (const error of [{ data: { message: { deep: true } } }, {}, null, undefined, Number.NaN]) expect(openCodeErrorText(error)).toBe("");
    const note = openCodeTurnErrorNote(openCodeErrorText({ name: "ProviderModelNotFoundError", data: { providerID: "ollama", modelID: "qwen" } }));
    expect(note).toContain("ProviderModelNotFoundError");
    expect(note).not.toContain("[object Object]");
  });

  test("the event's error comes first, then its message", () => {
    expect(openCodeFailedTurnText({ error: { name: "APIError", data: { message: "Bad gateway" } }, message: "turn failed" })).toBe("Bad gateway");
    expect(openCodeFailedTurnText({ error: {}, message: "turn failed" })).toBe("turn failed");
    expect(openCodeFailedTurnText({ message: "turn failed" })).toBe("turn failed");
    expect(openCodeFailedTurnText({})).toBe("");
  });
});

describe("a run's output", () => {
  test("a character split between two chunks of output is kept whole, never U+FFFD", async () => {
    const e = createAgentEnvironmentFor({ platform: process.platform, homeDir: tmpdir(), env: { PATH: "/usr/bin:/bin" } });
    // "€" is E2 82 AC: the first two bytes, a pause so they arrive as their own chunk, then the last.
    const script = "process.stdout.write(Buffer.from([0x61, 0xe2, 0x82])); setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x62])), 150);";
    const ran = await e.run([process.execPath, "-e", script], { timeoutMs: 5_000 });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toBe("a€b");
  });
});
