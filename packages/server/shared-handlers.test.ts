import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSaveNotes, handleServerReady, writeServerReadyMetadata } from "./shared-handlers";

function saveNotesRequest(body: unknown): Request {
  return new Request("http://localhost/api/save-notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleSaveNotes", () => {
  test("saves to an Obsidian vault and returns JSON success", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plannotator-save-notes-"));
    try {
      const response = await handleSaveNotes(
        saveNotesRequest({
          obsidian: {
            vaultPath: tmpDir,
            folder: "plannotator",
            plan: "# Test Plan\n\nContent here",
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const json = await response.json();
      expect(json).toHaveProperty("ok", true);
      expect(json.results.obsidian).toHaveProperty("success", true);
      expect(json.results.obsidian).toHaveProperty("path");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns 200 with empty results when no integrations are configured", async () => {
    const response = await handleSaveNotes(saveNotesRequest({}));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toHaveProperty("ok", true);
    expect(json.results).toEqual({});
  });

  test("a failed integration is reported, not thrown as a server error", async () => {
    const response = await handleSaveNotes(
      saveNotesRequest({
        obsidian: {
          vaultPath: "/nonexistent-vault-path",
          folder: "plannotator",
          plan: "# Test Plan\n\nContent here",
        },
      }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toHaveProperty("ok", true);
    expect(json.results.obsidian).toHaveProperty("success", false);
    expect(json.results.obsidian).toHaveProperty("error");
  });

  test("an unparseable body returns a 500 JSON error (not SPA HTML)", async () => {
    const badRequest = new Request("http://localhost/api/save-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json",
    });

    const response = await handleSaveNotes(badRequest);

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    const json = await response.json();
    expect(json).toHaveProperty("error");
  });
});

describe("writeServerReadyMetadata", () => {
  test("writes host-plugin ready metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-ready-"));
    const readyFile = join(dir, "nested", "ready.jsonl");

    try {
      writeServerReadyMetadata(readyFile, {
        url: "http://localhost:12345",
        isRemote: false,
        port: 12345,
      });
      const [line] = readFileSync(readyFile, "utf8").trim().split(/\r?\n/);
      expect(JSON.parse(line)).toEqual({
        url: "http://localhost:12345",
        isRemote: false,
        port: 12345,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("handleServerReady", () => {
  test("does not open a browser when host-plugin mode handles it", async () => {
    let opened = false;

    await handleServerReady("http://localhost:12345", false, 12345, {
      skipBrowserOpen: true,
      openBrowser: async () => {
        opened = true;
      },
    });

    expect(opened).toBe(false);
  });
});
