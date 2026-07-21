import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleSaveNotes,
  handleServerReady,
  isCodexDesktopHost,
  writeServerReadyMetadata,
} from "./shared-handlers";

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

  test("dispatches a Notion export without exposing its token", async () => {
    const originalToken = process.env.NOTION_TOKEN;
    const originalFetch = globalThis.fetch;
    process.env.NOTION_TOKEN = "secret-token";
    globalThis.fetch = async () => Response.json({ url: "https://www.notion.so/saved-plan" });

    try {
      const response = await handleSaveNotes(
        saveNotesRequest({
          notion: { plan: "# Test Plan", parentPageId: "parent-page-id" },
        }),
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.results.notion).toEqual({ success: true, url: "https://www.notion.so/saved-plan" });
      expect(JSON.stringify(json)).not.toContain("secret-token");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.NOTION_TOKEN;
      else process.env.NOTION_TOKEN = originalToken;
    }
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
  test("detects the Codex Desktop app host", () => {
    expect(isCodexDesktopHost({ __CFBundleIdentifier: "com.openai.codex" })).toBe(true);
    expect(isCodexDesktopHost({ __CFBundleIdentifier: "com.apple.Terminal" })).toBe(false);
  });

  test("does not open a browser when host-plugin mode handles it", async () => {
    let opened = false;
    const originalBundleIdentifier = process.env.__CFBundleIdentifier;
    process.env.__CFBundleIdentifier = "com.apple.Terminal";

    try {
      await handleServerReady("http://localhost:12345", false, 12345, {
        skipBrowserOpen: true,
        openBrowser: async () => {
          opened = true;
        },
      });
    } finally {
      if (originalBundleIdentifier === undefined) {
        delete process.env.__CFBundleIdentifier;
      } else {
        process.env.__CFBundleIdentifier = originalBundleIdentifier;
      }
    }

    expect(opened).toBe(false);
  });

  // Regression: a remote session must surface a reachable URL in the terminal
  // regardless of URL sharing — otherwise a sharing-disabled remote user is left
  // with no URL and the agent hangs waiting on the review.
  test("prints the reachable URL to stderr for a remote session", async () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      await handleServerReady("http://localhost:19432", true, 19432, {
        skipBrowserOpen: true,
      });
    } finally {
      (process.stderr as { write: unknown }).write = original;
    }
    expect(writes.join("")).toContain("http://localhost:19432");
  });

  test("does not print the URL for a local session when the browser opens", async () => {
    const writes: string[] = [];
    let opened = "";
    const original = process.stderr.write.bind(process.stderr);
    const originalBundleIdentifier = process.env.__CFBundleIdentifier;
    (process.stderr as { write: unknown }).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    process.env.__CFBundleIdentifier = "com.apple.Terminal";
    try {
      await handleServerReady("http://localhost:3000", false, 3000, {
        openBrowser: async (u: string) => {
          opened = u;
          return true;
        },
      });
    } finally {
      (process.stderr as { write: unknown }).write = original;
      if (originalBundleIdentifier === undefined) {
        delete process.env.__CFBundleIdentifier;
      } else {
        process.env.__CFBundleIdentifier = originalBundleIdentifier;
      }
    }
    expect(writes.join("")).not.toContain("http://localhost:3000");
    expect(opened).toBe("http://localhost:3000");
  });

  test("prints the URL for a local Codex Desktop session even when the browser opens", async () => {
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    const originalBundleIdentifier = process.env.__CFBundleIdentifier;
    (process.stderr as { write: unknown }).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    process.env.__CFBundleIdentifier = "com.openai.codex";
    try {
      await handleServerReady("http://localhost:3000", false, 3000, {
        openBrowser: async () => true,
      });
    } finally {
      (process.stderr as { write: unknown }).write = originalWrite;
      if (originalBundleIdentifier === undefined) {
        delete process.env.__CFBundleIdentifier;
      } else {
        process.env.__CFBundleIdentifier = originalBundleIdentifier;
      }
    }
    expect(writes.join("")).toContain("http://localhost:3000");
  });

  // Regression: a local session whose browser can't be opened (headless box,
  // devcontainer with no display) must still surface the URL, or the agent
  // hangs at waitForDecision with the user having no link to visit.
  test("prints the URL for a local session when the browser fails to open", async () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      await handleServerReady("http://localhost:4000", false, 4000, {
        openBrowser: async () => false,
      });
    } finally {
      (process.stderr as { write: unknown }).write = original;
    }
    expect(writes.join("")).toContain("http://localhost:4000");
  });
});
