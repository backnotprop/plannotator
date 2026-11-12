import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { connectInboxAgents, createAgentEnvironmentFor, planInboxAgentRemoval } from "./inbox-agents";

const SELF = ["/opt/plannotator/bin/plannotator"];
const OURS = [...SELF, "inbox", "mcp"];

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
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  fake.remove();
});

const environment = () => createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: fake.env });
const connect = () => connectInboxAgents({ dataDir, selfCommand: SELF, environment: environment() });
const settingsPath = () => join(fake.home, ".config", "muse", "settings.json");

async function uninstall(): Promise<void> {
  for (const item of planInboxAgentRemoval(dataDir, environment(), OURS).items) expect(await item.apply()).toBeNull();
}

describe("Muse Code", () => {
  test("found on PATH: a new settings.json gets the schema version and an optional stdio entry, muse is never run, and uninstall deletes the file", async () => {
    fake.install("muse");
    const report = await connect();
    expect(report.added).toEqual(["muse"]);
    expect(fake.calls()).toEqual([]);
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      schema_version: 1,
      mcp_servers: { "plannotator-inbox": { transport: "stdio", command: SELF[0], args: ["inbox", "mcp"], mode: "optional" } },
    });
    expect((await connect()).added).toEqual([]);
    await uninstall();
    expect(existsSync(settingsPath())).toBe(false);
  });

  test("found by its folder: the person's settings are kept byte for byte through add and removal", async () => {
    mkdirSync(join(fake.home, ".config", "muse"), { recursive: true });
    const before = '{\n    "schema_version": 1,\n    "mcp_servers": {\n        "docs": { "transport": "streamable_http", "url": "https://example.test/mcp" }\n    },\n    "session_retention_days": 30\n}\n';
    writeFileSync(settingsPath(), before);
    expect((await connect()).added).toEqual(["muse"]);
    const added = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(Object.keys(added.mcp_servers)).toEqual(["docs", "plannotator-inbox"]);
    expect(added.session_retention_days).toBe(30);
    await uninstall();
    expect(readFileSync(settingsPath(), "utf8")).toBe(before);
  });
});
