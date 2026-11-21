/**
 * OpenCode's model list for New message (Add agent): a person's own models must reach the picker. Feedback from
 * OpenCode on Linux with self-hosted models: they could not start an agent on their models, and sessions went to
 * OpenCode's default instead. Against a small fake `opencode2` (no real OpenCode, no network, no Inbox started).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentEnvironmentFor } from "./inbox-agents";
import type { LaunchHostContext } from "./inbox-launch-host";
import { createOpenCodeLaunchHost, openCodeErrorText, openCodeTurnErrorNote } from "./inbox-launch-opencode";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

/**
 * `opencode2 --version` and `opencode2 --standalone api GET /api/model`. Its models: the state file's, then each model of each
 * provider in the config named by OPENCODE_CONFIG (as OpenCode adds a file the person points it at). Entries carry the
 * fields a real model has (name, cost, limit, capabilities), so a big catalog is as big as it is in OpenCode.
 */
const FAKE = String.raw`
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("opencode v2.2.7\n"); process.exit(0); }
if (args[0] === "--standalone" && args[1] === "api" && args[2] === "GET" && args[3] === "/api/model") {
  const listed = JSON.parse(fs.readFileSync(path.join(__dirname, "state.json"), "utf8")).models.slice();
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

function setup(models: { providerID: string; id: string }[], options: { loginEnv?: Record<string, string> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-opencode-choices-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const bin = join(root, "bin");
  const configDir = join(home, ".config", "opencode");
  for (const dir of [home, dataDir, bin, configDir]) mkdirSync(dir, { recursive: true });
  const globalConfig = join(configDir, "opencode.json");
  writeFileSync(globalConfig, JSON.stringify({ plugins: ["@plannotator/opencode"] }));
  const state = (next: { providerID: string; id: string }[]) => writeFileSync(join(bin, "state.json"), JSON.stringify({ models: next }));
  state(models);
  writeFileSync(join(bin, "fake-opencode.cjs"), FAKE);
  writeFileSync(join(bin, "opencode2"), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-opencode.cjs")}" "$@"\n`);
  chmodSync(join(bin, "opencode2"), 0o755);
  // The Inbox's own env (a desktop or service start: no shell rc), and the person's login shell's.
  const own = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const login = { ...own, ...(options.loginEnv ?? {}) };
  const ctx = {
    dataDir,
    homeDir: home,
    platform: process.platform,
    selfCommand: ["plannotator"],
    ownEnv: () => own,
    environment: async () => createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: own }),
    shell: () => login,
    loginEnv: async () => login,
    launchDir: (id: string) => join(dataDir, "launch", id),
    startLog: () => {},
    displayFolder: (p: string) => p,
    bridge: { runStateOf: () => null },
    log: () => {},
  } as unknown as LaunchHostContext;
  const host = createOpenCodeLaunchHost(ctx);
  cleanup.push(() => host.close());
  return { host, root, globalConfig, state };
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
    expect((await t.host.choices())!.models).toContain("ollama/qwen2.5-coder:32b");
  });

  test("a config the person's login shell points OpenCode at (OPENCODE_CONFIG) counts, as it does for the session itself", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-opencode-config-")));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "local-models.json");
    writeFileSync(file, JSON.stringify({ provider: { lmstudio: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:1234/v1" }, models: { "qwen/qwen3-coder-30b": {} } } } }));
    const t = setup(zen, { loginEnv: { OPENCODE_CONFIG: file } });
    expect((await t.host.available()).ok).toBe(true);
    expect((await t.host.choices())!.models).toContain("lmstudio/qwen/qwen3-coder-30b");
  });
});

describe("a failed turn's note says what OpenCode said", () => {
  test("a nested error ({ name, data: { message } }) reads its message, then message, then name; never [object Object]", () => {
    expect(openCodeErrorText({ name: "ProviderAuthError", data: { message: "No API key for ollama" } })).toBe("No API key for ollama");
    expect(openCodeErrorText({ name: "APIError", message: "Rate limited" })).toBe("Rate limited");
    expect(openCodeErrorText({ name: "UnknownError", data: {} })).toBe("UnknownError");
    expect(openCodeErrorText("connection refused")).toBe("connection refused");
    for (const error of [{ data: { message: { deep: true } } }, {}, null, 42]) expect(openCodeErrorText(error)).toBe("");
    const note = openCodeTurnErrorNote(openCodeErrorText({ name: "ProviderModelNotFoundError", data: { providerID: "ollama", modelID: "qwen" } }));
    expect(note).toContain("ProviderModelNotFoundError");
    expect(note).not.toContain("[object Object]");
  });
});
