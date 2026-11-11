import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleFavicon,
  handleSaveNotes,
  handleServerReady,
  SESSION_READY_LINE_PREFIX,
  writeServerReadyMetadata,
} from "./shared-handlers";
import { saveConfig } from "./config";
import { FACE_FAVICON_PNG_BYTES, FAVICON_ICO_BYTES, FAVICON_PNG_BYTES, YELLOW_FAVICON_ICO_BYTES, YELLOW_FAVICON_PNG_BYTES } from "@plannotator/shared/favicon";

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

  describe("Notion", () => {
    const originalToken = process.env.NOTION_TOKEN;
    const originalFetch = globalThis.fetch;
    let notionCalls = 0;

    beforeEach(() => {
      notionCalls = 0;
      process.env.NOTION_TOKEN = "secret-token";
      globalThis.fetch = (async () => {
        notionCalls++;
        return Response.json({ url: "https://www.notion.so/saved-plan" });
      }) as unknown as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.NOTION_TOKEN;
      else process.env.NOTION_TOKEN = originalToken;
    });

    const notionBody = { notion: { plan: "# Test Plan", parentPageId: "parent-page-id" } };

    test("saves when the server offers Notion, without returning the token", async () => {
      const response = await handleSaveNotes(saveNotesRequest(notionBody), { notion: true });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.results.notion).toEqual({ success: true, url: "https://www.notion.so/saved-plan" });
      expect(JSON.stringify(json)).not.toContain("secret-token");
      expect(notionCalls).toBe(1);
    });

    test("never calls Notion when the session does not offer it (remote, --tailscale)", async () => {
      const response = await handleSaveNotes(saveNotesRequest(notionBody));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.results.notion).toBeUndefined();
      expect(notionCalls).toBe(0);
    });
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

async function captureStreams(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    out.push(String(chunk));
    return true;
  };
  (process.stderr as { write: unknown }).write = (chunk: unknown) => {
    err.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as { write: unknown }).write = originalOut;
    (process.stderr as { write: unknown }).write = originalErr;
  }
  return { stdout: out.join(""), stderr: err.join("") };
}

/** Written out literally, not built from `SESSION_READY_LINE_PREFIX`: that would check the constant against itself while consumers matching the text stop finding the URL. */
function expectSingleReadyLine(output: string, url: string): void {
  expect(output.split(url).length - 1).toBe(1);
  expect(output).toContain(`\n  Plannotator session ready: ${url}\n`);
}

describe("SESSION_READY_LINE_PREFIX", () => {
  test("is the exact text consumers match on", () => {
    expect(SESSION_READY_LINE_PREFIX).toBe("Plannotator session ready: ");
  });
});

describe("handleServerReady", () => {
  test("does not open a browser when host-plugin mode handles it", async () => {
    let opened = false;
    await captureStreams(async () => {
      await handleServerReady("http://localhost:12345", false, 12345, {
        skipBrowserOpen: true,
        openBrowser: async () => {
          opened = true;
          return true;
        },
      });
    });
    expect(opened).toBe(false);
  });

  test("prints the ready line for a local session whose browser opens", async () => {
    let opened = "";
    const { stderr } = await captureStreams(async () => {
      await handleServerReady("http://localhost:3000", false, 3000, {
        openBrowser: async (u: string) => {
          opened = u;
          return true;
        },
      });
    });
    expect(stderr).toBe("\n  Plannotator session ready: http://localhost:3000\n\n");
    expect(opened).toBe("http://localhost:3000");
  });

  test("prints the ready line before it launches the browser", async () => {
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    let seenAtLaunch = "";
    try {
      await handleServerReady("http://localhost:3100", false, 3100, {
        openBrowser: async () => {
          seenAtLaunch = written.join("");
          return true;
        },
      });
    } finally {
      (process.stderr as { write: unknown }).write = original;
    }
    expectSingleReadyLine(seenAtLaunch, "http://localhost:3100");
  });

  test("prints the URL once for a remote session, with the forwarding line under it", async () => {
    const { stderr } = await captureStreams(async () => {
      await handleServerReady("http://localhost:19432", true, 19432, { skipBrowserOpen: true });
    });
    expect(stderr).toBe(
      "\n  Plannotator session ready: http://localhost:19432\n" +
        "  Open it on your local machine (forward port 19432 if needed).\n\n",
    );
  });

  test("prints the URL once and a failure line when the browser won't open", async () => {
    const { stderr } = await captureStreams(async () => {
      await handleServerReady("http://localhost:4000", false, 4000, {
        openBrowser: async () => false,
      });
    });
    expectSingleReadyLine(stderr, "http://localhost:4000");
    expect(stderr).toContain("  Could not open a browser automatically — open the URL above.\n");
  });

  test("an overridden host gets the device line, not the forwarding advice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-ready-host-"));
    const savedHost = process.env.PLANNOTATOR_URL_HOST;
    const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_URL_HOST = "vps-1.tail1234.ts.net";
    process.env.PLANNOTATOR_DATA_DIR = dir;
    try {
      const url = "http://vps-1.tail1234.ts.net:19432";
      const { stderr } = await captureStreams(async () => {
        await handleServerReady(url, true, 19432, { skipBrowserOpen: true });
      });
      expectSingleReadyLine(stderr, url);
      expect(stderr).toContain("  Open it on your device (the URL above).\n");
      expect(stderr).not.toContain("forward port");
    } finally {
      if (savedHost === undefined) delete process.env.PLANNOTATOR_URL_HOST;
      else process.env.PLANNOTATOR_URL_HOST = savedHost;
      if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a public proxy URL gets the device line, not the forwarding advice", async () => {
    const url = "https://plannotator.example.com";
    const { stderr } = await captureStreams(async () => {
      await handleServerReady(url, true, 19432, { skipBrowserOpen: true });
    });
    expectSingleReadyLine(stderr, url);
    expect(stderr).toContain("  Open it on your device (the URL above).\n");
    expect(stderr).not.toContain("forward port");
  });

  test.each([
    ["local", false, ""],
    ["remote", true, "  Open it on your local machine (forward port 6000 if needed).\n"],
  ])("PLANNOTATOR_BROWSER=none: a %s session says why and never calls the opener", async (_label, isRemote, middle) => { // no-browser-guard: sentinel under test (expected text, nothing is set)
    const saved = process.env.PLANNOTATOR_BROWSER;
    // no-browser-guard: sentinel under test (in process; the opener is a stub that records)
    process.env.PLANNOTATOR_BROWSER = "none";
    let called = false;
    try {
      const { stdout, stderr } = await captureStreams(async () => {
        await handleServerReady("http://localhost:6000", isRemote as boolean, 6000, {
          openBrowser: async () => {
            called = true;
            return true;
          },
        });
      });
      expect(called).toBe(false);
      expect(stdout).toBe("");
      expect(stderr).toBe(
        "\n  Plannotator session ready: http://localhost:6000\n" +
          middle +
          "  Not opening a browser (PLANNOTATOR_BROWSER=none).\n\n", // no-browser-guard: sentinel under test (expected text, nothing is set)
      );
    } finally {
      if (saved === undefined) delete process.env.PLANNOTATOR_BROWSER;
      else process.env.PLANNOTATOR_BROWSER = saved;
    }
  });

  test("PLANNOTATOR_BROWSER=none with skipBrowserOpen prints no reason line", async () => { // no-browser-guard: sentinel under test (expected text, nothing is set)
    const saved = process.env.PLANNOTATOR_BROWSER;
    // no-browser-guard: sentinel under test (in process; nothing is launched)
    process.env.PLANNOTATOR_BROWSER = "none";
    try {
      const { stderr } = await captureStreams(async () => {
        await handleServerReady("http://localhost:6100", false, 6100, { skipBrowserOpen: true });
      });
      expect(stderr).toBe("\n  Plannotator session ready: http://localhost:6100\n\n");
    } finally {
      if (saved === undefined) delete process.env.PLANNOTATOR_BROWSER;
      else process.env.PLANNOTATOR_BROWSER = saved;
    }
  });

  test("announce: false prints nothing but still writes the ready file and opens the browser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-announce-"));
    const readyFile = join(dir, "ready.jsonl");
    let opened = "";
    try {
      const { stdout, stderr } = await captureStreams(async () => {
        await handleServerReady("http://localhost:5000", true, 5000, {
          announce: false,
          readyFile,
          openBrowser: async (u: string) => {
            opened = u;
            return true;
          },
        });
      });
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(opened).toBe("http://localhost:5000");
      const [line] = readFileSync(readyFile, "utf8").trim().split(/\r?\n/);
      expect(JSON.parse(line)).toEqual({ url: "http://localhost:5000", isRemote: true, port: 5000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["local session, browser opens", false, true, {}],
    ["local session, browser fails", false, false, {}],
    ["remote session", true, true, { skipBrowserOpen: true }],
  ])("writes nothing to stdout (%s)", async (_label, isRemote, browserOpens, options) => {
    const { stdout, stderr } = await captureStreams(async () => {
      await handleServerReady("http://localhost:7000", isRemote as boolean, 7000, {
        openBrowser: async () => browserOpens as boolean,
        ...(options as object),
      });
    });
    expect(stdout).toBe("");
    expectSingleReadyLine(stderr, "http://localhost:7000");
  });
});

/** A unit test on the handler, not an HTTP round trip: this file never calls global fetch, so it stays correct in the DOM CI lanes (happy-dom replaces global fetch). */
describe("handleFavicon", () => {
  const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "plannotator-favicon-handler-"));
    process.env.PLANNOTATOR_DATA_DIR = tempDir;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("serves the Glass PNG when no style is persisted", async () => {
    const response = handleFavicon();
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(FAVICON_PNG_BYTES);
  });

  test("serves each persisted style's own PNG: glass, yellow, totman (Face); classic (the removed P) the default", async () => {
    for (const [style, expected] of [
      ["glass", FAVICON_PNG_BYTES],
      ["yellow", YELLOW_FAVICON_PNG_BYTES],
      ["totman", FACE_FAVICON_PNG_BYTES],
      ["classic", FAVICON_PNG_BYTES],
    ] as const) {
      saveConfig({ favicon: style as never });
      const response = handleFavicon();
      expect(response.headers.get("content-type"), style).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer()), style).toEqual(expected);
    }
  });

  test("/favicon.ico, what every page links: Glass's and Yellow's multi-size .ico, Face its PNG", async () => {
    const glass = handleFavicon("/favicon.ico");
    expect(glass.headers.get("content-type")).toBe("image/x-icon");
    expect(glass.headers.get("cache-control")).toBe("no-cache");
    expect(new Uint8Array(await glass.arrayBuffer())).toEqual(FAVICON_ICO_BYTES);
    for (const [style, expected] of [
      ["glass", FAVICON_ICO_BYTES],
      ["yellow", YELLOW_FAVICON_ICO_BYTES],
      ["totman", FACE_FAVICON_PNG_BYTES],
      ["classic", FAVICON_ICO_BYTES],
    ] as const) {
      saveConfig({ favicon: style as never });
      const response = handleFavicon("/favicon.ico");
      expect(response.headers.get("content-type"), style).toBe(style === "totman" ? "image/png" : "image/x-icon");
      expect(new Uint8Array(await response.arrayBuffer()), style).toEqual(expected);
    }
  });

  test("ignores an unknown persisted style and falls back to the PNG", async () => {
    saveConfig({ favicon: "totmn" as never });
    const response = handleFavicon();
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  test("does not let either payload be cached under the shared URL", () => {
    expect(handleFavicon().headers.get("cache-control")).toBe("no-cache");
    saveConfig({ favicon: "totman" });
    expect(handleFavicon().headers.get("cache-control")).toBe("no-cache");
  });
});
