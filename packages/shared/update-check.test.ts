import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUpdateAdvert,
  extractReleaseNotes,
  installCommandFor,
  isAllowedOverrideUrl,
  isReleaseCheckDue,
  readReleaseNotes,
  readUpdateState,
  RELEASE_CHECK_INTERVAL_MS,
  RELEASE_CHECK_RETRY_MS,
  RELEASE_NOTES_MAX_BYTES,
  releaseSummary,
  runReleaseCheck,
  takeUpdateHint,
  UPDATE_HINT_INTERVAL_MS,
  updateCheckPaths,
  writeUpdateState,
  type FetchReleaseResult,
} from "./update-check";
import { resolveUpdateCheck, type PlannotatorConfig } from "./config";

const NOW = 1_800_000_000_000;

const BODY = [
  "Follow us",
  "",
  "<details><summary>Missed recent releases?</summary>",
  "",
  "| Release | Highlights |",
  "|---|---|",
  "| [v0.28.10](https://github.com/x/releases/tag/v0.28.10) | Inbox over your tailnet |",
  "| [v0.28.9](https://github.com/x/releases/tag/v0.28.9) | Large Inbox messages fixed |",
  "",
  "</details>",
  "",
  "## What's New in v0.28.11",
  "",
  "A one-change Inbox release.",
  "",
  "### Detail",
  "",
  "More words.",
  "",
  "## Install / Update",
  "",
  "curl ...",
].join("\n");

let dataDir: string;
let fetches: number;
const release = (tag = "v0.28.11", body = BODY): (() => Promise<FetchReleaseResult>) => async () => {
  fetches++;
  return { ok: true, release: { tag, publishedAt: "2026-10-10T15:49:28Z", body } };
};
const failing = (): (() => Promise<FetchReleaseResult>) => async () => {
  fetches++;
  return { ok: false, error: "HTTP 403" };
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-update-check-"));
  fetches = 0;
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe("resolveUpdateCheck", () => {
  test("on by default; config and env turn it off; env wins in both directions", () => {
    expect(resolveUpdateCheck({}, {})).toBe(true);
    expect(resolveUpdateCheck({ updateCheck: false }, {})).toBe(false);
    for (const v of ["0", "false", "off", "disabled", "OFF"]) {
      expect(resolveUpdateCheck({ updateCheck: true }, { PLANNOTATOR_UPDATE_CHECK: v })).toBe(false);
    }
    for (const v of ["1", "true", "on"]) {
      expect(resolveUpdateCheck({ updateCheck: false }, { PLANNOTATOR_UPDATE_CHECK: v })).toBe(true);
    }
    // Empty or unrecognized env counts as unset; garbage config keeps the default.
    expect(resolveUpdateCheck({ updateCheck: false }, { PLANNOTATOR_UPDATE_CHECK: "" })).toBe(false);
    expect(resolveUpdateCheck({ updateCheck: "maybe" } as unknown as PlannotatorConfig, {})).toBe(true);
  });
});

describe("the 24h check", () => {
  test("asks once, then answers from the cache for 24h", async () => {
    const deps = { dataDir, enabled: () => true, fetchRelease: release() };
    expect(await runReleaseCheck({ ...deps, now: () => NOW })).toEqual({ outcome: "checked", version: "0.28.11" });
    expect(await runReleaseCheck({ ...deps, now: () => NOW + RELEASE_CHECK_INTERVAL_MS - 1 })).toEqual({
      outcome: "fresh",
      version: "0.28.11",
    });
    expect(fetches).toBe(1);
    expect(await runReleaseCheck({ ...deps, now: () => NOW + RELEASE_CHECK_INTERVAL_MS })).toMatchObject({ outcome: "checked" });
    expect(fetches).toBe(2);
  });

  test("off makes no request and writes nothing", async () => {
    expect(await runReleaseCheck({ dataDir, enabled: () => false, now: () => NOW, fetchRelease: release() })).toEqual({
      outcome: "disabled",
    });
    expect(fetches).toBe(0);
    expect(existsSync(updateCheckPaths(dataDir).state)).toBe(false);
  });

  test("an explicit check asks whatever the throttle and the knob say", async () => {
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchRelease: release() });
    expect(
      await runReleaseCheck({ dataDir, enabled: () => false, force: true, now: () => NOW + 1, fetchRelease: release("v0.29.0") }),
    ).toEqual({ outcome: "checked", version: "0.29.0" });
    expect(fetches).toBe(2);
  });

  test("a failure is logged, keeps the last known answer, and retries after 6h, not 24h, never sooner", async () => {
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchRelease: release() });
    const later = NOW + RELEASE_CHECK_INTERVAL_MS;
    expect(await runReleaseCheck({ dataDir, enabled: () => true, now: () => later, fetchRelease: failing() })).toEqual({
      outcome: "failed",
      error: "HTTP 403",
    });
    expect(readUpdateState(dataDir).latestRelease?.tag).toBe("0.28.11");
    expect(readFileSync(updateCheckPaths(dataDir).log, "utf-8")).toContain("HTTP 403");
    expect(await runReleaseCheck({ dataDir, enabled: () => true, now: () => later + RELEASE_CHECK_RETRY_MS - 1, fetchRelease: failing() }))
      .toMatchObject({ outcome: "fresh" });
    expect(fetches).toBe(2);
    expect(await runReleaseCheck({ dataDir, enabled: () => true, now: () => later + RELEASE_CHECK_RETRY_MS, fetchRelease: release() }))
      .toMatchObject({ outcome: "checked" });
    expect(fetches).toBe(3);
  });

  test("concurrent starts ask GitHub once: the attempt is claimed before the request", async () => {
    let release1: (r: FetchReleaseResult) => void = () => {};
    const slow = () => {
      fetches++;
      return new Promise<FetchReleaseResult>((r) => (release1 = r));
    };
    const first = runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchRelease: slow });
    expect(await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW + 5, fetchRelease: release() })).toMatchObject({
      outcome: "fresh",
    });
    release1({ ok: true, release: { tag: "v0.28.11" } });
    expect(await first).toMatchObject({ outcome: "checked" });
    expect(fetches).toBe(1);
  });

  test("a tag that is not a plain stable version is a failure, never cached", async () => {
    for (const tag of ["v1.0.0-rc.1", "$(id)", "v1.2.3\nv9.9.9"]) {
      rmSync(updateCheckPaths(dataDir).state, { force: true });
      expect((await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchRelease: release(tag) })).outcome).toBe("failed");
      expect(readUpdateState(dataDir).latestRelease).toBeUndefined();
    }
  });

  test("a clock that moved backwards does not freeze checks", () => {
    expect(isReleaseCheckDue({ releaseCheck: { attemptedAt: NOW + 1000 } }, NOW)).toBe(true);
  });

  test("a newer release clears an older snooze", async () => {
    writeUpdateState({ snooze: { version: "0.28.10", until: NOW + 1000 } }, dataDir);
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchRelease: release() });
    expect(readUpdateState(dataDir).snooze).toBeUndefined();
  });
});

describe("release notes", () => {
  test("keeps What's New up to Install / Update, and the missed-releases table", async () => {
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchRelease: release() });
    const notes = readReleaseNotes("0.28.11", dataDir)!;
    expect(notes.notes.startsWith("A one-change Inbox release.")).toBe(true);
    expect(notes.notes).toContain("### Detail");
    expect(notes.notes).not.toContain("Install / Update");
    expect(notes.highlights.map((h) => h.version)).toEqual(["0.28.10", "0.28.9"]);
    expect(notes.publishedAt).toBe("2026-10-10T15:49:28Z");
    expect(releaseSummary(notes.notes)).toBe("A one-change Inbox release.");
  });

  test("capped at 64 KB", () => {
    const huge = `## What's New in v1.0.0\n\n${"é".repeat(RELEASE_NOTES_MAX_BYTES)}`;
    expect(new TextEncoder().encode(extractReleaseNotes(huge).notes).length).toBeLessThanOrEqual(RELEASE_NOTES_MAX_BYTES);
  });

  test("no notes for a version name that is not a version", () => {
    expect(readReleaseNotes("../../etc/passwd", dataDir)).toBeNull();
  });
});

describe("the advert and the commands", () => {
  const state = { latestRelease: { tag: "0.28.11", fetchedAt: NOW, publishedAt: "2026-10-10T15:49:28Z" } };

  test("only a strictly newer stable release, with the host's command", () => {
    expect(buildUpdateAdvert({ state, current: "0.28.11", action: "script", platform: "darwin" })).toBeNull();
    expect(buildUpdateAdvert({ state, current: "0.29.0", action: "script", platform: "darwin" })).toBeNull();
    expect(buildUpdateAdvert({ state, current: undefined, action: "script", platform: "darwin" })).toBeNull();
    expect(buildUpdateAdvert({ state, current: "0.28.10", action: "script", platform: "darwin", flags: ["skip-gemini"] })).toEqual({
      version: "0.28.11",
      current: "0.28.10",
      releaseUrl: "https://github.com/backnotprop/plannotator/releases/tag/v0.28.11",
      action: "script",
      command: "curl -fsSL https://plannotator.ai/install.sh | bash -s -- --skip-gemini",
      publishedAt: "2026-10-10T15:49:28Z",
    });
    expect(buildUpdateAdvert({ state, current: "0.28.10", action: "pi", platform: "darwin" })?.command).toBe("pi update --extensions");
  });

  test("a stale cache is still the last known answer", () => {
    const old = { latestRelease: { tag: "0.28.11", fetchedAt: NOW - 30 * RELEASE_CHECK_INTERVAL_MS } };
    expect(buildUpdateAdvert({ state: old, current: "0.28.10", action: "copy", platform: "linux" })?.version).toBe("0.28.11");
  });

  test("install commands carry the remembered flags, spelled per installer", () => {
    expect(installCommandFor("linux")).toBe("curl -fsSL https://plannotator.ai/install.sh | bash");
    expect(installCommandFor("win32")).toBe("irm https://plannotator.ai/install.ps1 | iex");
    expect(installCommandFor("win32", ["skip-codex", "minimal"])).toBe(
      "& ([scriptblock]::Create((irm https://plannotator.ai/install.ps1))) -SkipCodex -Minimal",
    );
  });

  test("override URLs: https or loopback http only", () => {
    expect(isAllowedOverrideUrl("https://mirror.example/api")).toBe(true);
    expect(isAllowedOverrideUrl("http://127.0.0.1:9/x")).toBe(true);
    expect(isAllowedOverrideUrl("http://localhost:9/x")).toBe(true);
    expect(isAllowedOverrideUrl("http://evil.example/x")).toBe(false);
    expect(isAllowedOverrideUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedOverrideUrl("https://u:p@mirror.example/")).toBe(false);
  });
});

describe("the terminal hint", () => {
  test("from the cache, once a day, only when newer and checks are on", () => {
    writeUpdateState({ latestRelease: { tag: "0.28.11", fetchedAt: NOW } }, dataDir);
    expect(takeUpdateHint({ current: "0.28.10", enabled: false, now: NOW, dataDir })).toBeNull();
    expect(takeUpdateHint({ current: "0.28.11", enabled: true, now: NOW, dataDir })).toBeNull();
    expect(takeUpdateHint({ current: "0.28.10", enabled: true, now: NOW, dataDir })).toBe(
      "Plannotator 0.28.11 is available (you have 0.28.10). Update: plannotator update",
    );
    expect(takeUpdateHint({ current: "0.28.10", enabled: true, now: NOW + UPDATE_HINT_INTERVAL_MS - 1, dataDir })).toBeNull();
    expect(takeUpdateHint({ current: "0.28.10", enabled: true, now: NOW + UPDATE_HINT_INTERVAL_MS, dataDir })).not.toBeNull();
  });
});
