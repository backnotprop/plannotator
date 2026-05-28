import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleServerReady } from "./shared-handlers";

describe("handleServerReady", () => {
  test("writes host-plugin ready metadata without opening a browser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-ready-"));
    const readyFile = join(dir, "ready.jsonl");
    let opened = false;

    try {
      await handleServerReady("http://localhost:12345", false, 12345, {
        readyFile,
        skipBrowserOpen: true,
        openBrowser: async () => {
          opened = true;
        },
      });
      const [line] = readFileSync(readyFile, "utf8").trim().split(/\r?\n/);
      expect(JSON.parse(line)).toEqual({
        url: "http://localhost:12345",
        isRemote: false,
        port: 12345,
      });
      expect(opened).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
