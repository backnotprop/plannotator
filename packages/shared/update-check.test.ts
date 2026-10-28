import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  RELEASE_CHECK_RATE_LIMITED_RETRY_MS,
  RELEASE_CHECK_RETRY_MS,
  RELEASE_CHECK_ON_START_MS,
  RELEASE_API_FALLBACK_INTERVAL_MS,
  DEFAULT_RELEASE_PAGE_URL,
  fetchLatestFromPage,
  fetchLatestRelease,
  isApiFallbackDue,
  releasePageUrl,
  versionFromLatestRedirect,
  fetchReleaseNotesFor,
  updateLog,
  UPDATE_LOG_MAX_BYTES,
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
  return { ok: false, error: "HTTP 503" };
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

describe("the release check", () => {
  // The primary source is the "latest release" redirect; `fetchRelease` (the API) is the fallback.
  const NO_API = async (): Promise<FetchReleaseResult> => {
    throw new Error("the API is never asked while the page answers");
  };

  test("asks once, then answers from the cache for 10 minutes", async () => {
    const deps = { dataDir, enabled: () => true, fetchReleasePage: release(), fetchRelease: NO_API };
    expect(await runReleaseCheck({ ...deps, now: () => NOW })).toEqual({ outcome: "checked", version: "0.28.11" });
    expect(await runReleaseCheck({ ...deps, now: () => NOW + RELEASE_CHECK_INTERVAL_MS - 1 })).toEqual({
      outcome: "fresh",
      version: "0.28.11",
    });
    expect(fetches).toBe(1);
    expect(await runReleaseCheck({ ...deps, now: () => NOW + RELEASE_CHECK_INTERVAL_MS })).toMatchObject({ outcome: "checked" });
    expect(fetches).toBe(2);
    expect(readUpdateState(dataDir).releaseCheck?.source).toBe("page");
  });

  test("a start or a page load asks when the answer is over a minute old", async () => {
    const deps = { dataDir, enabled: () => true, fetchReleasePage: release(), fetchRelease: NO_API };
    await runReleaseCheck({ ...deps, now: () => NOW });
    const startup = { ...deps, freshForMs: RELEASE_CHECK_ON_START_MS };
    expect(await runReleaseCheck({ ...startup, now: () => NOW + RELEASE_CHECK_ON_START_MS - 1 })).toMatchObject({ outcome: "fresh" });
    expect(await runReleaseCheck({ ...startup, now: () => NOW + RELEASE_CHECK_ON_START_MS })).toMatchObject({ outcome: "checked" });
    expect(fetches).toBe(2);
  });

  test("the cadence: 10 minutes, a failure never waits longer than a success, a start once a minute", () => {
    // The owner (2026-10-24): a new release shows within minutes; the source is not rate-limited.
    expect(RELEASE_CHECK_INTERVAL_MS).toBe(10 * 60 * 1000);
    expect(RELEASE_CHECK_RETRY_MS).toBeLessThanOrEqual(RELEASE_CHECK_INTERVAL_MS);
    expect(RELEASE_CHECK_ON_START_MS).toBe(60 * 1000);
  });

  test("off makes no request and writes nothing", async () => {
    expect(await runReleaseCheck({ dataDir, enabled: () => false, now: () => NOW, fetchReleasePage: release(), fetchRelease: release() })).toEqual({
      outcome: "disabled",
    });
    expect(fetches).toBe(0);
    expect(existsSync(updateCheckPaths(dataDir).state)).toBe(false);
  });

  test("an explicit check asks whatever the throttle and the knob say", async () => {
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchReleasePage: release() });
    expect(
      await runReleaseCheck({ dataDir, enabled: () => false, force: true, now: () => NOW + 1, fetchReleasePage: release("v0.29.0") }),
    ).toEqual({ outcome: "checked", version: "0.29.0" });
    expect(fetches).toBe(2);
  });

  test("a failure is logged, keeps the last known answer, and retries after 10 minutes whatever triggers it, never sooner", async () => {
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchReleasePage: release() });
    const later = NOW + RELEASE_CHECK_INTERVAL_MS;
    // The page fails; the API was not asked within the hour, so it is (and fails too).
    expect(await runReleaseCheck({ dataDir, enabled: () => true, now: () => later, fetchReleasePage: failing(), fetchRelease: failing() })).toEqual({
      outcome: "failed",
      error: "HTTP 503",
    });
    expect(fetches).toBe(3);
    expect(readUpdateState(dataDir).latestRelease?.tag).toBe("0.28.11");
    expect(readFileSync(updateCheckPaths(dataDir).log, "utf-8")).toContain("page: HTTP 503; api: HTTP 503");
    expect(await runReleaseCheck({ dataDir, enabled: () => true, now: () => later + RELEASE_CHECK_RETRY_MS - 1, fetchReleasePage: failing() }))
      .toMatchObject({ outcome: "fresh" });
    // A start or a page load (the 1-minute trigger) waits out a failure too.
    expect(
      await runReleaseCheck({ dataDir, enabled: () => true, now: () => later + 2 * RELEASE_CHECK_ON_START_MS, freshForMs: RELEASE_CHECK_ON_START_MS, fetchReleasePage: failing() }),
    ).toMatchObject({ outcome: "fresh" });
    expect(fetches).toBe(3);
    expect(await runReleaseCheck({ dataDir, enabled: () => true, now: () => later + RELEASE_CHECK_RETRY_MS, fetchReleasePage: release(), fetchRelease: NO_API }))
      .toMatchObject({ outcome: "checked" });
    expect(fetches).toBe(4);
  });

  test("the page failing falls back to the API, which carries the notes", async () => {
    expect(await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchReleasePage: failing(), fetchRelease: release() })).toEqual({
      outcome: "checked",
      version: "0.28.11",
    });
    const state = readUpdateState(dataDir);
    expect(state.releaseCheck).toMatchObject({ source: "api", apiAttemptedAt: NOW });
    expect(readReleaseNotes("0.28.11", dataDir)?.notes).toContain("A one-change Inbox release.");
    // Within the hour the API is not asked again, whatever the page does.
    const t = NOW + RELEASE_CHECK_INTERVAL_MS;
    expect(await runReleaseCheck({ dataDir, enabled: () => true, now: () => t, fetchReleasePage: failing(), fetchRelease: NO_API })).toMatchObject({
      outcome: "failed",
    });
    expect(isApiFallbackDue(readUpdateState(dataDir), NOW + RELEASE_API_FALLBACK_INTERVAL_MS)).toBe(true);
  });

  test("the page names no publish date: the one already known for that version is kept", async () => {
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchReleasePage: failing(), fetchRelease: release() });
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW + RELEASE_CHECK_INTERVAL_MS, fetchReleasePage: async () => ({ ok: true, release: { tag: "0.28.11" } }) });
    expect(readUpdateState(dataDir).latestRelease).toEqual({ tag: "0.28.11", fetchedAt: NOW + RELEASE_CHECK_INTERVAL_MS, publishedAt: "2026-10-10T15:49:28Z" });
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW + 2 * RELEASE_CHECK_INTERVAL_MS, fetchReleasePage: async () => ({ ok: true, release: { tag: "0.28.12" } }) });
    expect(readUpdateState(dataDir).latestRelease).toEqual({ tag: "0.28.12", fetchedAt: NOW + 2 * RELEASE_CHECK_INTERVAL_MS });
  });

  test("concurrent starts ask once: the attempt is claimed before the request", async () => {
    let release1: (r: FetchReleaseResult) => void = () => {};
    const slow = () => {
      fetches++;
      return new Promise<FetchReleaseResult>((r) => (release1 = r));
    };
    const first = runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchReleasePage: slow });
    expect(await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW + 5, fetchReleasePage: release() })).toMatchObject({
      outcome: "fresh",
    });
    release1({ ok: true, release: { tag: "v0.28.11" } });
    expect(await first).toMatchObject({ outcome: "checked" });
    expect(fetches).toBe(1);
  });

  test("a tag that is not a plain stable version is a failure, never cached", async () => {
    for (const tag of ["v1.0.0-rc.1", "$(id)", "v1.2.3\nv9.9.9"]) {
      rmSync(updateCheckPaths(dataDir).state, { force: true });
      expect((await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchReleasePage: failing(), fetchRelease: release(tag) })).outcome).toBe("failed");
      expect(readUpdateState(dataDir).latestRelease).toBeUndefined();
    }
  });

  test("a clock that moved backwards does not freeze checks", () => {
    expect(isReleaseCheckDue({ releaseCheck: { attemptedAt: NOW + 1000 } }, NOW)).toBe(true);
    expect(isReleaseCheckDue({ latestRelease: { tag: "0.28.11", fetchedAt: NOW + 1000 } }, NOW)).toBe(true);
    expect(isApiFallbackDue({ releaseCheck: { attemptedAt: NOW, apiAttemptedAt: NOW + 1000 } }, NOW)).toBe(true);
  });

  test("a newer release clears an older snooze", async () => {
    writeUpdateState({ snooze: { version: "0.28.10", until: NOW + 1000 } }, dataDir);
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchReleasePage: release() });
    expect(readUpdateState(dataDir).snooze).toBeUndefined();
  });

  test("only the API may be asked (a mirror) and it is not due: nothing is asked, nothing fails", async () => {
    writeUpdateState({ releaseCheck: { attemptedAt: NOW - RELEASE_CHECK_INTERVAL_MS, apiAttemptedAt: NOW - 1000 } }, dataDir);
    const skipped = async (): Promise<FetchReleaseResult> => ({ ok: false, error: "no release page source", skipped: true });
    expect(await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchReleasePage: skipped, fetchRelease: NO_API })).toEqual({
      outcome: "fresh",
      version: null,
    });
    expect(readUpdateState(dataDir).releaseCheck?.failedAt).toBeUndefined();
  });
});

describe("failing quietly and politely", () => {
  const pageLimited = (headers: Record<string, string> = {}, status = 429): (() => Promise<FetchReleaseResult>) => async () => {
    fetches++;
    const res = new Response("slow down", { status, headers });
    return fetchLatestFromPage("https://github.com/x/y/releases/latest", (async () => res) as unknown as typeof fetch);
  };
  const noApi = async (): Promise<FetchReleaseResult> => ({ ok: false, error: "api down" });

  test("the page's 429 Retry-After is honoured, kept between 10 minutes and an hour, by every trigger", async () => {
    const run = (now: number, fetchReleasePage: () => Promise<FetchReleaseResult>, freshForMs?: number) =>
      runReleaseCheck({ dataDir, enabled: () => true, now: () => now, fetchReleasePage, fetchRelease: noApi, ...(freshForMs && { freshForMs }) });
    expect(await run(NOW, pageLimited({ "retry-after": "1800" }))).toMatchObject({ outcome: "failed" });
    expect(readUpdateState(dataDir).releaseCheck?.pageRetryAt).toBe(NOW + 30 * 60 * 1000);
    expect(readFileSync(updateCheckPaths(dataDir).log, "utf-8")).toContain("next try in 30m");
    expect(await run(NOW + 29 * 60 * 1000, release(), RELEASE_CHECK_ON_START_MS)).toMatchObject({ outcome: "fresh" });
    expect(fetches).toBe(1);
    expect(await run(NOW + 30 * 60 * 1000, release(), RELEASE_CHECK_ON_START_MS)).toMatchObject({ outcome: "checked" });
    expect(readUpdateState(dataDir).releaseCheck?.pageRetryAt).toBeUndefined();

    // Ten hours asked: an hour. Nothing named: an hour. Seconds asked: 10 minutes.
    for (const [headers, wait] of [
      [{ "retry-after": String(10 * 3600) }, 60 * 60 * 1000],
      [{}, 60 * 60 * 1000],
      [{ "retry-after": "5" }, RELEASE_CHECK_RETRY_MS],
    ] as const) {
      rmSync(updateCheckPaths(dataDir).state, { force: true });
      await run(NOW, pageLimited(headers));
      expect(readUpdateState(dataDir).releaseCheck?.pageRetryAt).toBe(NOW + wait);
      expect(isReleaseCheckDue(readUpdateState(dataDir), NOW + wait - 1, RELEASE_CHECK_ON_START_MS)).toBe(false);
      expect(isReleaseCheckDue(readUpdateState(dataDir), NOW + wait, RELEASE_CHECK_ON_START_MS)).toBe(true);
    }
    // A pageRetryAt on disk far beyond an hour (a wrong clock) does not hold checks back.
    expect(isReleaseCheckDue({ releaseCheck: { attemptedAt: NOW, failedAt: NOW, pageRetryAt: NOW + 100 * 3600_000 } }, NOW + RELEASE_CHECK_RETRY_MS)).toBe(true);
  });

  test("a plain 403 from the page (no rate-limit sign) is an ordinary failure: 10 minutes", async () => {
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW, fetchReleasePage: pageLimited({}, 403), fetchRelease: noApi });
    expect(readUpdateState(dataDir).releaseCheck?.pageRetryAt).toBeUndefined();
    expect(isReleaseCheckDue(readUpdateState(dataDir), NOW + RELEASE_CHECK_RETRY_MS)).toBe(true);
    await runReleaseCheck({
      dataDir,
      enabled: () => true,
      now: () => NOW + RELEASE_CHECK_RETRY_MS,
      fetchReleasePage: pageLimited({ "x-ratelimit-remaining": "0" }, 403),
      fetchRelease: noApi,
    });
    expect(readUpdateState(dataDir).releaseCheck?.pageRetryAt).toBe(NOW + RELEASE_CHECK_RETRY_MS + 60 * 60 * 1000);
  });

  test("an offline machine writes one log line per kind of error, and one when it answers again", async () => {
    const offline = async (): Promise<FetchReleaseResult> => ({ ok: false, error: "Unable to connect" });
    for (let i = 0; i < 6; i++) {
      await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW + i * RELEASE_CHECK_RETRY_MS, fetchReleasePage: offline, fetchRelease: offline });
    }
    const lines = () => readFileSync(updateCheckPaths(dataDir).log, "utf-8").trim().split("\n");
    expect(lines()).toHaveLength(1);
    expect(readUpdateState(dataDir).releaseCheck?.failures).toBe(6);
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW + 6 * RELEASE_CHECK_RETRY_MS, fetchReleasePage: failing(), fetchRelease: offline });
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain("6 failed checks before this one");
    await runReleaseCheck({ dataDir, enabled: () => true, now: () => NOW + 7 * RELEASE_CHECK_RETRY_MS, fetchReleasePage: release() });
    expect(lines()).toHaveLength(3);
    expect(lines()[2]).toContain("answered again (0.28.11) after 7 failed checks");
    expect(readUpdateState(dataDir).releaseCheck?.failures).toBeUndefined();
  });

  test("update.log is bounded: past the cap it moves to update.log.1", () => {
    const { log } = updateCheckPaths(dataDir);
    writeFileSync(log, "x".repeat(UPDATE_LOG_MAX_BYTES + 1));
    updateLog("after the cap", dataDir);
    expect(readFileSync(log, "utf-8")).toContain("after the cap");
    expect(readFileSync(log, "utf-8").length).toBeLessThan(200);
    expect(readFileSync(`${log}.1`, "utf-8").length).toBe(UPDATE_LOG_MAX_BYTES + 1);
  });

  test("the notes fetched by tag fill in the publish date the page does not name", async () => {
    writeUpdateState({ latestRelease: { tag: "0.28.11", fetchedAt: NOW } }, dataDir);
    await fetchReleaseNotesFor({
      version: "0.28.11",
      dataDir,
      enabled: () => true,
      now: () => NOW,
      fetchRelease: async () => ({ ok: true, release: { tag: "v0.28.11", publishedAt: "2026-10-10T15:49:28Z", body: BODY } }),
    });
    expect(readUpdateState(dataDir).latestRelease).toEqual({ tag: "0.28.11", fetchedAt: NOW, publishedAt: "2026-10-10T15:49:28Z" });
  });
});

describe("the release page redirect", () => {
  const URL_ = "https://github.com/backnotprop/plannotator/releases/latest";

  test("reads only the same origin, at exactly …/releases/tag/vX.Y.Z", () => {
    expect(versionFromLatestRedirect(URL_, "https://github.com/backnotprop/plannotator/releases/tag/v0.28.30")).toBe("0.28.30");
    expect(versionFromLatestRedirect(URL_, "/backnotprop/plannotator/releases/tag/v0.28.30")).toBe("0.28.30");
    expect(versionFromLatestRedirect(URL_, "https://github.com/backnotprop/plannotator/releases/tag/0.28.30/")).toBe("0.28.30");
    for (const bad of [
      null,
      "",
      "https://github.com/backnotprop/plannotator/releases",
      "https://github.com/backnotprop/plannotator/releases/tag/v0.29.0-rc.1",
      "https://github.com/backnotprop/plannotator/releases/tag/v0.29",
      "https://github.com/someone/else/releases/tag/v9.9.9",
      "https://evil.example/backnotprop/plannotator/releases/tag/v9.9.9",
      "https://github.com/login?return_to=%2Fbacknotprop%2Fplannotator%2Freleases%2Flatest",
      "https://github.com/backnotprop/plannotator/releases/tag/v1.2.3%0Av9.9.9",
    ]) {
      expect(versionFromLatestRedirect(URL_, bad)).toBeNull();
    }
    // A request URL that is not a "latest" link reads nothing.
    expect(versionFromLatestRedirect("https://github.com/x/y/releases", "https://github.com/x/y/releases/tag/v1.0.0")).toBeNull();
  });

  test("a fake on loopback: 302 read without following it; a followed redirect read from its URL", async () => {
    let mode: "redirect" | "elsewhere" | "429" | "followed" = "redirect";
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        seen.push(`${req.method} ${path} ${req.headers.get("user-agent")}`);
        if (path.endsWith("/latest")) {
          if (mode === "429") return new Response("slow down", { status: 429 });
          const to = mode === "elsewhere" ? "/r/p/releases" : "/r/p/releases/tag/v0.28.31";
          return new Response(null, { status: 302, headers: { location: to } });
        }
        return new Response("the release page", { status: 200 });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/r/p/releases/latest`;
      expect(await fetchLatestFromPage(url)).toEqual({ ok: true, release: { tag: "0.28.31" } });
      expect(seen).toEqual(["HEAD /r/p/releases/latest plannotator-update-check"]);
      mode = "elsewhere";
      expect(await fetchLatestFromPage(url)).toMatchObject({ ok: false });
      mode = "429";
      expect(await fetchLatestFromPage(url)).toEqual({ ok: false, error: "HTTP 429", rateLimited: true });
      // A fetch that follows redirects whatever it is told.
      mode = "redirect";
      const following: typeof fetch = ((input: string, init?: RequestInit) => fetch(input, { ...init, redirect: "follow" })) as typeof fetch;
      expect(await fetchLatestFromPage(url, following)).toEqual({ ok: true, release: { tag: "0.28.31" } });
      expect(await fetchLatestFromPage(null)).toMatchObject({ ok: false, skipped: true });
    } finally {
      server.stop(true);
    }
  });

  test("PLANNOTATOR_UPDATE_API_URL alone means only that source; the page knob points elsewhere", () => {
    expect(releasePageUrl({})).toBe(DEFAULT_RELEASE_PAGE_URL);
    expect(releasePageUrl({ PLANNOTATOR_UPDATE_API_URL: "https://ghe.example/api/v3/repos/x/y/releases/latest" })).toBeNull();
    expect(releasePageUrl({ PLANNOTATOR_UPDATE_LATEST_URL: "http://127.0.0.1:9/x/y/releases/latest" })).toBe("http://127.0.0.1:9/x/y/releases/latest");
    // Neither knob takes anything but https or loopback http.
    expect(releasePageUrl({ PLANNOTATOR_UPDATE_LATEST_URL: "http://example.com/x/releases/latest" })).toBe(DEFAULT_RELEASE_PAGE_URL);
    expect(releasePageUrl({ PLANNOTATOR_UPDATE_API_URL: "http://example.com/latest" })).toBe(DEFAULT_RELEASE_PAGE_URL);
  });
});

describe("the API fallback and GitHub's rate limit", () => {
  // A fake release API on loopback (the PLANNOTATOR_UPDATE_API_URL shape),
  // answering what each test sets; never GitHub. The page always fails here.
  let server: ReturnType<typeof Bun.serve>;
  let answer: () => Response;
  let requests: number;
  const HOUR = 60 * 60 * 1000;
  beforeEach(() => {
    requests = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        requests++;
        return answer();
      },
    });
  });
  afterEach(() => server.stop(true));
  const pageDown = async (): Promise<FetchReleaseResult> => ({ ok: false, error: "offline" });
  const check = (now: number, fetchReleasePage = pageDown) =>
    runReleaseCheck({
      dataDir,
      enabled: () => true,
      now: () => now,
      fetchReleasePage,
      fetchRelease: () => fetchLatestRelease(`http://127.0.0.1:${server.port}/repos/x/releases/latest`),
    });
  const apiDue = (now: number) => isApiFallbackDue(readUpdateState(dataDir), now);

  test("offline or a 5xx: the check retries in 10 minutes, the API in an hour", async () => {
    const t = Date.now();
    answer = () => new Response("down", { status: 503 });
    expect(await check(t)).toEqual({ outcome: "failed", error: "HTTP 503" });
    expect(readUpdateState(dataDir).releaseCheck?.apiRetryAt).toBeUndefined();
    expect(isReleaseCheckDue(readUpdateState(dataDir), t + RELEASE_CHECK_RETRY_MS)).toBe(true);
    expect(apiDue(t + RELEASE_CHECK_RETRY_MS)).toBe(false);
    expect(apiDue(t + RELEASE_API_FALLBACK_INTERVAL_MS)).toBe(true);
  });

  test("403/429 with no time named: the API waits 6 h, the page is still asked every 10 minutes", async () => {
    const t = Date.now();
    answer = () => new Response("rate limited", { status: 429 });
    expect(await check(t)).toEqual({ outcome: "failed", error: "HTTP 429" });
    expect(readFileSync(updateCheckPaths(dataDir).log, "utf-8")).toContain("rate limited");
    expect(apiDue(t + RATE_LIMIT_HOURS(5))).toBe(false);
    expect(await check(t + 5 * HOUR)).toMatchObject({ outcome: "failed", error: "offline" });
    expect(requests).toBe(1);
    // The page answers again: the notice shows, whatever the API's back-off.
    const pageUp = async (): Promise<FetchReleaseResult> => ({ ok: true, release: { tag: "v0.28.12" } });
    expect(await check(t + 5 * HOUR + RELEASE_CHECK_RETRY_MS, pageUp)).toEqual({ outcome: "checked", version: "0.28.12" });
    // A success keeps the API's back-off.
    expect(readUpdateState(dataDir).releaseCheck?.apiRetryAt).toBe(t + RELEASE_CHECK_RATE_LIMITED_RETRY_MS);
    expect(apiDue(t + RELEASE_CHECK_RATE_LIMITED_RETRY_MS)).toBe(true);
  });

  test("x-ratelimit-reset names the time: the API waits until it", async () => {
    const t = Date.now();
    const reset = Math.ceil(t / 1000) + 2 * 60 * 60;
    answer = () => new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
    expect(await check(t)).toMatchObject({ outcome: "failed", error: "HTTP 403" });
    expect(apiDue(t + RELEASE_API_FALLBACK_INTERVAL_MS)).toBe(false);
    expect(apiDue(reset * 1000 - 5_000)).toBe(false);
    expect(apiDue(reset * 1000 + 5_000)).toBe(true);
  });

  test("Retry-After is kept between an hour and 6 h", async () => {
    const t = Date.now();
    answer = () => new Response("slow down", { status: 429, headers: { "retry-after": String(10 * 60 * 60) } });
    await check(t);
    expect(apiDue(t + RELEASE_CHECK_RATE_LIMITED_RETRY_MS - 1)).toBe(false);
    expect(apiDue(t + RELEASE_CHECK_RATE_LIMITED_RETRY_MS)).toBe(true);

    rmSync(updateCheckPaths(dataDir).state, { force: true });
    answer = () => new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
    await check(t);
    expect(apiDue(t + 30 * 60 * 1000)).toBe(false);
    expect(apiDue(t + RELEASE_API_FALLBACK_INTERVAL_MS)).toBe(true);
  });

  test("a retryAt written by 0.28.30 holds back only the API, and beyond 6 h is ignored", () => {
    const state = { releaseCheck: { attemptedAt: NOW, failedAt: NOW, retryAt: NOW + 3 * HOUR } };
    expect(isReleaseCheckDue(state, NOW + RELEASE_CHECK_RETRY_MS)).toBe(true);
    expect(isApiFallbackDue(state, NOW + 3 * HOUR - 1)).toBe(false);
    expect(isApiFallbackDue(state, NOW + 3 * HOUR)).toBe(true);
    expect(isApiFallbackDue({ releaseCheck: { attemptedAt: NOW, retryAt: NOW + 100 * HOUR } }, NOW + 1)).toBe(true);
  });
});

const RATE_LIMIT_HOURS = (h: number) => h * 60 * 60 * 1000;

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
