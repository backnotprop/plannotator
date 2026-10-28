/**
 * The review windows' update notice through the Bun servers: the payload's
 * `updateAvailable` comes from the machine's cached check (never a network
 * call on a page load), only for the compiled CLI, only while update checks
 * are on; the action follows the host; POST /api/update is same-origin only
 * and runs the installer at most once (update.lock). The installer never
 * runs here: the managed-binary case holds the lock first.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_UPDATE_CHECK", "PLANNOTATOR_AI", "HOME", "PLANNOTATOR_INSTALL_SCRIPT_URL"] as const;
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

/** A managed binary: HOME whose ~/.local/bin/plannotator is this bun. */
function managedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "plannotator-update-advert-home-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  symlinkSync(realpathSync(process.execPath), join(home, ".local", "bin", "plannotator"));
  process.env.HOME = home;
  return home;
}

/** A raw request with any Host header (fetch would rewrite it). */
async function rawPost(port: number, host: string, body = "{}"): Promise<{ status: number; body: Record<string, unknown> }> {
  const { connect } = await import("node:net");
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`POST /api/update HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    });
    let data = "";
    socket.on("data", (c) => (data += c));
    socket.on("error", reject);
    socket.on("end", () => {
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1]);
      const text = data.slice(data.indexOf("\r\n\r\n") + 4);
      const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
      resolve({ status, body: json ? JSON.parse(json) : {} });
    });
  });
}

describe("POST /api/update answers only this computer, and only for a session nobody else can reach", () => {
  test("remote mode: a LAN Host is refused before anything else; the advert shows the command instead of Update", async () => {
    const home = managedHome();
    setCliNoticeVersionForTests("0.28.10");
    process.env.PLANNOTATOR_REMOTE = "1";
    // A port the OS says is free right now. A random pick in 30000-50000 sat in Linux's ephemeral range
    // (32768-60999), where the suite's own outgoing connections hold ports: CI hit "Port … in use after 5 retries".
    const probe = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new Response("") });
    process.env.PLANNOTATOR_PORT = String(probe.port);
    probe.stop(true);
    const server = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML, origin: "claude-code" });
    try {
      const port = server.port;
      const lan = await rawPost(port, `192.168.1.50:${port}`);
      expect([lan.status, lan.body.code]).toEqual([403, "forbidden_host"]);
      const local = await rawPost(port, `localhost:${port}`);
      expect([local.status, local.body.code]).toEqual([403, "update_exposed"]);
      const diff = (await (await fetch(`http://127.0.0.1:${port}/api/diff`)).json()) as Record<string, unknown>;
      expect(diff.updateAvailable).toMatchObject({ action: "copy" });
      expect(existsSync(join(dataDir, "update.lock"))).toBe(false);
    } finally {
      server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--tailscale: the advert shows the command, and Update is refused even on loopback", async () => {
    const home = managedHome();
    setCliNoticeVersionForTests("0.28.10");
    const server = await startAnnotateServer({ markdown: "# T", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML, origin: "claude-code", tailnetPublished: true });
    try {
      expect((await planPayload(server.url)).updateAvailable).toMatchObject({ action: "copy" });
      const res = await fetch(`${server.url}/api/update`, { method: "POST", body: "{}" });
      expect([res.status, (await res.json()).code]).toEqual([403, "update_exposed"]);
      expect(existsSync(join(dataDir, "update.lock"))).toBe(false);
    } finally {
      server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a tab left open on an older session (another serverSession) gets 409 and starts nothing", async () => {
    const home = managedHome();
    setCliNoticeVersionForTests("0.28.10");
    const server = await startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: MINIMAL_HTML });
    try {
      const res = await fetch(`${server.url}/api/update`, { method: "POST", body: JSON.stringify({ serverSession: "0".repeat(32) }) });
      expect([res.status, (await res.json()).code]).toEqual([409, "session_mismatch"]);
      expect(existsSync(join(dataDir, "update.lock"))).toBe(false);
    } finally {
      server.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});


describe("updateCheckFailing on the payloads (checking has failed for hours)", () => {
  test("plan, annotate and review say so, with the install command; never beside updateAvailable", async () => {
    setCliNoticeVersionForTests("0.28.12");
    const since = Date.now() - 4 * 60 * 60_000;
    writeUpdateState(
      { latestRelease: { tag: "0.28.12", fetchedAt: since - 60_000 }, releaseCheck: { attemptedAt: Date.now(), failedAt: Date.now(), failingSince: since, error: "page: HTTP 200" } },
      dataDir,
    );
    const plan = await startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: MINIMAL_HTML });
    const annotate = await startAnnotateServer({ markdown: "# T", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML, origin: "claude-code" });
    const review = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML, origin: "claude-code" });
    try {
      const expected = { since: new Date(since).toISOString(), error: "release page didn't answer as expected", command: expect.stringContaining("plannotator.ai/install.") };
      for (const url of [plan.url, annotate.url]) {
        const payload = await planPayload(url);
        expect(payload.updateCheckFailing).toMatchObject(expected);
        expect(payload.updateAvailable).toBeUndefined();
      }
      expect(((await (await fetch(`${review.url}/api/diff`)).json()) as Record<string, unknown>).updateCheckFailing).toMatchObject(expected);
      // A newer release known: the advert, not the failing line.
      setCliNoticeVersionForTests("0.28.10");
      const payload = await planPayload(plan.url);
      expect(payload.updateAvailable).toMatchObject({ version: "0.28.12" });
      expect(payload.updateCheckFailing).toBeUndefined();
      // Checks off (the person's choice): nothing.
      setCliNoticeVersionForTests("0.28.12");
      process.env.PLANNOTATOR_UPDATE_CHECK = "0";
      expect((await planPayload(plan.url)).updateCheckFailing).toBeUndefined();
    } finally {
      plan.stop();
      annotate.stop();
      review.stop();
    }
  });
});
