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
import { CLASSIC_FAVICON_SVG, FAVICON_PNG_BYTES } from "@plannotator/shared/favicon";

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

/** Run `fn` with stdout and stderr captured, so a test can assert what landed where. */
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

/**
 * The session URL appears exactly once, on the stable line. Written out
 * literally rather than built from `SESSION_READY_LINE_PREFIX`: building it
 * from the constant would check the constant against itself and stay green
 * while consumers matching the text (the OpenCode CLI bridge's stderr filter)
 * stopped finding the URL. The two-space indent and the newlines are part of
 * the format.
 */
function expectSingleReadyLine(output: string, url: string): void {
  expect(output.split(url).length - 1).toBe(1);
  expect(output).toContain(`\n  Plannotator session ready: ${url}\n`);
}

describe("SESSION_READY_LINE_PREFIX", () => {
  // A cross-component contract: the OpenCode CLI bridge matches it with its
  // own regex and the docs quote it as the line to grep.
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

  // Regression (#1134): a local session whose browser opened fine printed no
  // URL, so a closed tab left neither the person nor the agent a way back.
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

  // A launcher that never exits (a blocking BROWSER, #746) must not hide the
  // URL: the line is out before the launch starts.
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

  // Regression: a remote session must surface a reachable URL regardless of
  // URL sharing; the forwarding advice is its own line under it.
  test("prints the URL once for a remote session, with the forwarding line under it", async () => {
    const { stderr } = await captureStreams(async () => {
      await handleServerReady("http://localhost:19432", true, 19432, { skipBrowserOpen: true });
    });
    expect(stderr).toBe(
      "\n  Plannotator session ready: http://localhost:19432\n" +
        "  Open it on your local machine (forward port 19432 if needed).\n\n",
    );
  });

  // Regression: a headless box must say why no tab appeared, without
  // printing the URL a second time.
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

  // A reverse-proxy origin has no port to forward; the advice would be wrong.
  test("a public proxy URL gets the device line, not the forwarding advice", async () => {
    const url = "https://plannotator.example.com";
    const { stderr } = await captureStreams(async () => {
      await handleServerReady(url, true, 19432, { skipBrowserOpen: true });
    });
    expectSingleReadyLine(stderr, url);
    expect(stderr).toContain("  Open it on your device (the URL above).\n");
    expect(stderr).not.toContain("forward port");
  });

  // PLANNOTATOR_BROWSER=none (or --browser none) opens nothing: the reason
  // goes under the URL, and no launch (so no failure line) follows.
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

  // A host that opens the browser itself (skipBrowserOpen) has nothing to explain.
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

  // OpenCode's embedded runtime shares stderr with its TUI and shows the URL
  // itself: announce: false prints nothing but still writes the ready file
  // and opens the browser.
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

  // `--json`, `--hook` and `--gate` reserve stdout for the record an agent
  // parses: the announcement never writes there, in any branch.
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

/**
 * Deliberately a unit test on the handler rather than an HTTP round trip: this
 * file never calls global fetch, so it stays correct in either CI lane. The DOM
 * lanes in .github/workflows/test.yml list individual files and include no
 * server tests, but a server test that booted a server and fetched it would
 * break the moment someone added one (happy-dom replaces global fetch).
 */
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

  test("serves the production PNG when no style is persisted", async () => {
    const response = handleFavicon();
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(FAVICON_PNG_BYTES);
  });

  test("serves the classic SVG, correctly typed, when the style is classic", async () => {
    saveConfig({ favicon: "classic" });
    const response = handleFavicon();
    // The whole point of reading config here: without the right content type the
    // browser has nothing to go on, since the entry HTML's <link> declares none.
    // An image/png header over SVG bytes would be the pre-fix flash again.
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(await response.text()).toBe(CLASSIC_FAVICON_SVG);
  });

  test("ignores an unknown persisted style and falls back to the PNG", async () => {
    saveConfig({ favicon: "totmn" as never });
    const response = handleFavicon();
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  // One URL, two possible bodies: a long-lived cache would re-paint the old icon
  // on the next session after a switch.
  test("does not let either payload be cached under the shared URL", () => {
    expect(handleFavicon().headers.get("cache-control")).toBe("no-cache");
    saveConfig({ favicon: "classic" });
    expect(handleFavicon().headers.get("cache-control")).toBe("no-cache");
  });
});
