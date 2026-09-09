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

/**
 * Run `fn` with BOTH streams captured, so a test can assert what landed where.
 *
 * The session-ready line is a stderr contract: `--json` and `--hook` reserve
 * stdout for the decision record an agent parses, so a single stray byte on
 * stdout from a ready announcement corrupts it. Nothing in `handleServerReady`
 * may ever write there, in any mode.
 */
async function captureStreams(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
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

  // Regression: OpenCode's embedded runtime runs this in-process, sharing
  // stderr with its opentui renderer, so the unconditional line above would
  // print raw text into the TUI instead of through the host's own channel.
  // `announce: false` must silence every stderr write here while leaving the
  // ready-file write and the browser launch untouched, so the host's own
  // notifier stays the only visible surface for the URL.
  test("announce: false silences stderr but still writes the ready file and opens the browser", async () => {
    let opened = "";
    const readyFile = join(mkdtempSync(join(tmpdir(), "plannotator-announce-")), "ready.jsonl");

    const output = await captureStderr(async () => {
      await handleServerReady("http://localhost:5000", true, 5000, {
        announce: false,
        readyFile,
        openBrowser: async (u: string) => {
          opened = u;
          return true;
        },
      });
    });

    expect(output).toBe("");
    expect(opened).toBe("http://localhost:5000");
    const [line] = readFileSync(readyFile, "utf8").trim().split(/\r?\n/);
    expect(JSON.parse(line)).toEqual({ url: "http://localhost:5000", isRemote: true, port: 5000 });
  });

  // The QR is a convenience for the device hop, so it has to sit UNDER the
  // line whose URL it encodes: ready line, then the reachability context,
  // then the QR. (The QR itself is TTY-only, which is why this asserts the
  // order of the surrounding lines rather than the block's presence.)
  test("puts the ready line above the device-hop context that carries the QR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-qr-order-"));
    const savedHost = process.env.PLANNOTATOR_URL_HOST;
    const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_URL_HOST = "vps-1.tail1234.ts.net";
    process.env.PLANNOTATOR_DATA_DIR = dir;

    try {
      const url = "http://vps-1.tail1234.ts.net:19432";
      const output = await captureStderr(async () => {
        await handleServerReady(url, true, 19432, { skipBrowserOpen: true });
      });

      expectSingleSessionReadyLine(output, url);
      // An overridden host is directly reachable, so the port-forwarding
      // advice would be wrong and the QR replaces it.
      expect(output).toContain("Open it on your device");
      expect(output).not.toContain("forward port");
      expect(output.indexOf("Plannotator session ready: ")).toBeLessThan(
        output.indexOf("Open it on your device"),
      );
    } finally {
      if (savedHost === undefined) delete process.env.PLANNOTATOR_URL_HOST;
      else process.env.PLANNOTATOR_URL_HOST = savedHost;
      if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The stdout contract, pinned at the handler rather than only end-to-end:
  // `--json` / `--hook` put a machine-readable decision record on stdout, so
  // the ready announcement must stay entirely on stderr no matter which
  // branch it takes. Every mode, because each one adds its own writes.
  test.each([
    ["local session, browser opens", false, true, {}],
    ["local session, browser fails", false, false, {}],
    ["remote session", true, true, { skipBrowserOpen: true }],
    ["suppressed announce", false, true, { announce: false }],
  ])("writes nothing to stdout (%s)", async (_label, isRemote, browserOpens, options) => {
    const { stdout, stderr } = await captureStreams(async () => {
      await handleServerReady("http://localhost:7000", isRemote as boolean, 7000, {
        openBrowser: async () => browserOpens as boolean,
        ...(options as object),
      });
    });

    expect(stdout).toBe("");
    // Guard against the assertion passing because nothing ran at all.
    if ((options as { announce?: boolean }).announce === false) expect(stderr).toBe("");
    else expect(stderr).toContain("http://localhost:7000");
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
