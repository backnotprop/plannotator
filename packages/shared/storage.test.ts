import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";

// Imported statically and BEFORE any PLANNOTATOR_DATA_DIR is set: this module's
// import-time side effects used to freeze the data directory, so a later env
// change was silently ignored while every other consumer resolved it live.
import { getHistoryDir, saveToHistory } from "./storage";

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
