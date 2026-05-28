import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleServerReady } from "./shared-handlers";

describe("handleServerReady", () => {
  test("writes host-plugin ready metadata without opening a browser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-ready-"));
    const readyFile = join(dir, "ready.jsonl");
    const previousReadyFile = process.env.PLANNOTATOR_READY_FILE;
    const previousSkipOpen = process.env.PLANNOTATOR_SKIP_BROWSER_OPEN;

    process.env.PLANNOTATOR_READY_FILE = readyFile;
    process.env.PLANNOTATOR_SKIP_BROWSER_OPEN = "1";

    try {
      await handleServerReady("http://localhost:12345", false, 12345);
      const [line] = readFileSync(readyFile, "utf8").trim().split(/\r?\n/);
      expect(JSON.parse(line)).toEqual({
        url: "http://localhost:12345",
        isRemote: false,
        port: 12345,
      });
    } finally {
      if (previousReadyFile === undefined) {
        delete process.env.PLANNOTATOR_READY_FILE;
      } else {
        process.env.PLANNOTATOR_READY_FILE = previousReadyFile;
      }
      if (previousSkipOpen === undefined) {
        delete process.env.PLANNOTATOR_SKIP_BROWSER_OPEN;
      } else {
        process.env.PLANNOTATOR_SKIP_BROWSER_OPEN = previousSkipOpen;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
