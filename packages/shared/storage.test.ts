import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

// Imported statically and BEFORE any PLANNOTATOR_DATA_DIR is set: this module's
// import-time side effects used to freeze the data directory, so a later env
// change was silently ignored while every other consumer resolved it live.
import { getHistoryDir, getVersionCount, listVersions, saveToHistory } from "./storage";

import { createTestEnvironment } from "../../tests/helpers/environment";

const env = createTestEnvironment(["PLANNOTATOR_DATA_DIR"], "plannotator-storage-");

afterEach(() => env.restore());

describe("storage data directory", () => {
  test("resolves PLANNOTATOR_DATA_DIR set after import", () => {
    env.reset();
    const dataDir = env.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = dataDir;

    expect(getHistoryDir("proj", "slug")).toBe(`${dataDir}/history/proj/slug`);

    const saved = saveToHistory("proj", "slug", "# Plan\n");
    expect(saved.path).toBe(`${dataDir}/history/proj/slug/001.md`);
    expect(readFileSync(saved.path, "utf-8")).toBe("# Plan\n");
  });

  test("follows a later change to PLANNOTATOR_DATA_DIR", () => {
    env.reset();
    const first = env.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = first;
    expect(getHistoryDir("proj", "slug")).toBe(`${first}/history/proj/slug`);

    const second = env.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = second;
    expect(getHistoryDir("proj", "slug")).toBe(`${second}/history/proj/slug`);
  });
});

describe("the agent that submitted a version", () => {
  test("written beside it, before it; none known, none written (and none left from a version number used before)", () => {
    env.reset();
    const dataDir = env.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    const agent = { host: "codex", session: "019a0000-0000-7000-8000-000000000001", name: "Codex" };
    saveToHistory("proj", "slug", "# Plan\n", { agent });
    const dir = `${dataDir}/history/proj/slug`;
    expect(JSON.parse(readFileSync(`${dir}/001.agent.json`, "utf8"))).toEqual(agent);
    // A stale one at the next number (its version gone): taken away when the next version records none.
    writeFileSync(`${dir}/002.agent.json`, JSON.stringify(agent));
    saveToHistory("proj", "slug", "# Plan\n\nv2\n");
    expect(existsSync(`${dir}/002.agent.json`)).toBe(false);
    // The same text again is no version, and writes nothing.
    saveToHistory("proj", "slug", "# Plan\n\nv2\n", { agent });
    expect(existsSync(`${dir}/002.agent.json`)).toBe(false);
    // Plan review's own reads count versions only.
    expect(getVersionCount("proj", "slug")).toBe(2);
    expect(listVersions("proj", "slug").map((v) => v.version)).toEqual([1, 2]);
    expect(readdirSync(dir).sort()).toEqual(["001.agent.json", "001.md", "002.md"]);
  });
});
