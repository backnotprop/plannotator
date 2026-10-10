/**
 * The review windows' update notice through the Bun servers: the payload's
 * `updateAvailable` comes from the machine's cached check (never a network
 * call on a page load), only for the compiled CLI, only while update checks
 * are on; the action follows the host; POST /api/update is same-origin only
 * and runs the installer at most once (update.lock). The installer never
 * runs here: the managed-binary case holds the lock first.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "@plannotator/shared/config";
import { writeUpdateState } from "@plannotator/shared/update-check";
import { cliNoticeVersion, setCliNoticeVersionForTests, updateActionFor } from "./auto-update";
import { startAnnotateServer } from "./annotate";
import { startPlannotatorServer } from "./index";
import { startReviewServer } from "./review";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_UPDATE_CHECK", "PLANNOTATOR_AI", "HOME"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;
let savedNotice: string | undefined;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  savedNotice = cliNoticeVersion();
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-update-advert-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_AI = "disabled";
  delete process.env.PLANNOTATOR_PORT;
  delete process.env.PLANNOTATOR_UPDATE_CHECK;
  writeUpdateState({ latestRelease: { tag: "0.28.12", fetchedAt: Date.now() } }, dataDir);
});

afterEach(() => {
  setCliNoticeVersionForTests(savedNotice);
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const planPayload = async (url: string) => (await (await fetch(`${url}/api/plan`)).json()) as Record<string, unknown>;

describe("updateAvailable on the payloads", () => {
  test("plan, annotate and review carry it from the cache when the compiled CLI runs", async () => {
    setCliNoticeVersionForTests("0.28.10");
    const plan = await startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: MINIMAL_HTML });
    const annotate = await startAnnotateServer({ markdown: "# T", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML, origin: "claude-code" });
    const review = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML, origin: "claude-code" });
    try {
      for (const url of [plan.url, annotate.url]) {
        expect((await planPayload(url)).updateAvailable).toMatchObject({ version: "0.28.12", current: "0.28.10", releaseUrl: expect.stringContaining("v0.28.12") });
      }
      const diff = (await (await fetch(`${review.url}/api/diff`)).json()) as Record<string, unknown>;
      expect(diff.updateAvailable).toMatchObject({ version: "0.28.12" });
    } finally {
      plan.stop();
      annotate.stop();
      review.stop();
    }
  });

  test("nothing when checks are off, when up to date, or outside the compiled CLI", async () => {
    const server = await startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: MINIMAL_HTML });
    try {
      setCliNoticeVersionForTests(undefined);
      expect((await planPayload(server.url)).updateAvailable).toBeUndefined();
      setCliNoticeVersionForTests("0.28.12");
      expect((await planPayload(server.url)).updateAvailable).toBeUndefined();
      setCliNoticeVersionForTests("0.28.10");
      saveConfig({ updateCheck: false });
      expect((await planPayload(server.url)).updateAvailable).toBeUndefined();
      saveConfig({ updateCheck: true });
      process.env.PLANNOTATOR_UPDATE_CHECK = "0";
      expect((await planPayload(server.url)).updateAvailable).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("the action follows the host: OpenCode copies the install command; an unmanaged binary copies it too", async () => {
    setCliNoticeVersionForTests("0.28.10");
    const server = await startPlannotatorServer({ plan: "# Plan", origin: "opencode", htmlContent: MINIMAL_HTML });
    try {
      const advert = (await planPayload(server.url)).updateAvailable as Record<string, string>;
      expect(advert.action).toBe("opencode");
      expect(advert.command).toContain("plannotator.ai/install");
    } finally {
      server.stop();
    }
    expect(updateActionFor("claude-code", true)).toBe("script");
    expect(updateActionFor("claude-code", false)).toBe("copy");
    expect(updateActionFor("pi", true)).toBe("pi");
  });
});

describe("POST /api/update", () => {
  test("cross-origin is refused; a dev build and an unmanaged binary cannot update", async () => {
    const server = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML });
    try {
      setCliNoticeVersionForTests("0.28.10");
      const forged = await fetch(`${server.url}/api/update`, { method: "POST", headers: { "Content-Type": "text/plain", Origin: "https://evil.example" }, body: "{}" });
      expect(forged.status).toBe(403);
      const unmanaged = await fetch(`${server.url}/api/update`, { method: "POST", body: "{}" });
      expect(unmanaged.status).toBe(409);
      expect((await unmanaged.json()).code).toBe("update_unmanaged");
      setCliNoticeVersionForTests(undefined);
      expect((await (await fetch(`${server.url}/api/update`, { method: "POST", body: "{}" })).json()).code).toBe("update_dev_build");
    } finally {
      server.stop();
    }
  });

  test("a managed binary while an update runs: refused, nothing started (once, under update.lock)", async () => {
    // HOME whose ~/.local/bin/plannotator is this bun: the running binary counts as the install script's.
    const home = mkdtempSync(join(tmpdir(), "plannotator-update-advert-home-"));
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(realpathSync(process.execPath), join(home, ".local", "bin", "plannotator"));
    process.env.HOME = home;
    writeFileSync(join(dataDir, "update.lock"), "1");
    setCliNoticeVersionForTests("0.28.10");
    const server = await startAnnotateServer({ markdown: "# T", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML });
    try {
      expect((await planPayload(server.url)).updateAvailable).toMatchObject({ action: "script" });
      const res = await fetch(`${server.url}/api/update`, { method: "POST", body: "{}" });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("update_locked");
    } finally {
      server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
