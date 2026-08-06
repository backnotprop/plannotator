import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleSaveNotes,
  handleServerReady,
  SESSION_READY_LINE_PREFIX,
  writeServerReadyMetadata,
} from "./shared-handlers";

/** Run `fn` with stderr captured, so assertions see it and the test log doesn't. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
  return writes.join("");
}

/**
 * The session URL must appear exactly once, on the stable one-line format.
 *
 * The expected line is written out literally rather than interpolated from
 * `SESSION_READY_LINE_PREFIX`, because interpolating it would assert the
 * constant against itself: every one of these tests would stay green while
 * consumers matching the old text (see `formatUserFacingCliStderrLine` in
 * `apps/opencode-plugin/cli-bridge.ts`) silently stopped forwarding the URL.
 * The two-space indent and the newlines around the line are part of the format.
 */
function expectSingleSessionReadyLine(output: string, url: string): void {
  expect(output.split(url).length - 1).toBe(1);
  expect(output).toContain(`\n  Plannotator session ready: ${url}\n`);
}

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

describe("SESSION_READY_LINE_PREFIX", () => {
  // Pinned to the literal bytes, because the prefix is a cross-component
  // contract rather than an implementation detail: `cli-bridge.ts` matches it
  // with its own hardcoded regex, and the docs quote it as the line agents
  // grep. Changing it is a breaking change and has to fail here first.
  test("is the exact text consumers match on", () => {
    expect(SESSION_READY_LINE_PREFIX).toBe("Plannotator session ready: ");
  });
});

describe("handleServerReady", () => {
  test("does not open a browser when host-plugin mode handles it", async () => {
    let opened = false;

    await captureStderr(async () => {
      await handleServerReady("http://localhost:12345", false, 12345, {
        skipBrowserOpen: true,
        openBrowser: async () => {
          opened = true;
        },
      });
    });

    expect(opened).toBe(false);
  });

  // Regression (upstream #1134): the URL used to be printed only when the
  // session was remote, when the Codex desktop host was detected, or when the
  // browser failed to open. A local session whose browser opened fine printed
  // nothing, so a closed tab left neither the user nor the agent driving the
  // session with any way back to it.
  test("prints the stable URL line for a local session when the browser opens", async () => {
    let opened = "";

    const output = await captureStderr(async () => {
      await handleServerReady("http://localhost:3000", false, 3000, {
        openBrowser: async (u: string) => {
          opened = u;
          return true;
        },
      });
    });

    expectSingleSessionReadyLine(output, "http://localhost:3000");
    expect(opened).toBe("http://localhost:3000");
  });

  // The URL is greppable, so it has to be on one line and it has to be the same
  // line in every mode — including the modes that add their own context.
  test("prints the reachable URL once for a remote session, with forwarding context", async () => {
    const output = await captureStderr(async () => {
      await handleServerReady("http://localhost:19432", true, 19432, {
        skipBrowserOpen: true,
      });
    });

    expectSingleSessionReadyLine(output, "http://localhost:19432");
    expect(output).toContain("forward port 19432");
  });

  // Regression: a local session whose browser can't be opened (headless box,
  // devcontainer with no display) must say so, or the user waits on a tab that
  // never appears — but the URL still prints exactly once.
  test("prints the URL once and reports the failure when the browser won't open", async () => {
    const output = await captureStderr(async () => {
      await handleServerReady("http://localhost:4000", false, 4000, {
        openBrowser: async () => false,
      });
    });

    expectSingleSessionReadyLine(output, "http://localhost:4000");
    expect(output).toContain("Could not open a browser automatically");
  });

  test("publishes ready metadata to the PLANNOTATOR_READY_FILE side channel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-ready-env-"));
    const readyFile = join(dir, "ready.jsonl");
    const original = process.env.PLANNOTATOR_READY_FILE;
    process.env.PLANNOTATOR_READY_FILE = readyFile;

    try {
      await captureStderr(async () => {
        await handleServerReady("http://localhost:5000", false, 5000, {
          openBrowser: async () => true,
        });
      });

      const [line] = readFileSync(readyFile, "utf8").trim().split(/\r?\n/);
      expect(JSON.parse(line)).toEqual({
        url: "http://localhost:5000",
        isRemote: false,
        port: 5000,
      });
    } finally {
      if (original === undefined) {
        delete process.env.PLANNOTATOR_READY_FILE;
      } else {
        process.env.PLANNOTATOR_READY_FILE = original;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
