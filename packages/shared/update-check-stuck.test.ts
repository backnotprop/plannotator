/**
 * "No user ever stuck on a version" (QA item 30): the release check against a
 * fake GitHub on loopback (page redirect and API, the shapes
 * PLANNOTATOR_UPDATE_LATEST_URL / PLANNOTATOR_UPDATE_API_URL point at), with
 * an injected clock. Every failure ends either in the update shown, or in the
 * check saying plainly that it is failing, with the install command.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUpdateCheckFailing,
  fetchLatestFromPage,
  forgetUnwrittenUpdateStateForTests,
  fetchLatestRelease,
  isSnoozed,
  plainCheckError,
  readUpdateState,
  RELEASE_CHECK_FAILING_AFTER_MS,
  RELEASE_CHECK_RETRY_MS,
  releaseCheckFailing,
  runReleaseCheck,
  takeUpdateHint,
  UPDATE_SNOOZE_MS,
  versionFromLatestRedirect,
  writeUpdateState,
} from "./update-check";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

let dataDir: string;
let server: ReturnType<typeof Bun.serve>;
/** What the fake answers for the release page and for the API. */
let page: () => Response;
let api: () => Response;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-update-stuck-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => (new URL(req.url).pathname.startsWith("/api/") ? api() : page()),
  });
});
afterEach(() => {
  server.stop(true);
  forgetUnwrittenUpdateStateForTests(dataDir);
  rmSync(dataDir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${server.port}`;
const pageUrl = () => `${base()}/backnotprop/plannotator/releases/latest`;
const check = (now: number) =>
  runReleaseCheck({
    dataDir,
    enabled: () => true,
    now: () => now,
    fetchReleasePage: () => fetchLatestFromPage(pageUrl()),
    fetchRelease: () => fetchLatestRelease(`${base()}/api/repos/backnotprop/plannotator/releases/latest`),
  });

const redirectTo = (version: string, path = "/backnotprop/plannotator/releases/tag/") => () =>
  new Response(null, { status: 302, headers: { location: `${base()}${path}v${version}` } });
const captivePortal = () => new Response("<html>Sign in to the Wi-Fi</html>", { status: 200, headers: { "content-type": "text/html" } });
const rateLimited = () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });

describe("both sources failing: never silent, never unbounded", () => {
  test("a captive portal on the page and a rate-limited API: after 3 hours of failures the check says so, with since and why", async () => {
    page = captivePortal;
    api = rateLimited;
    // The machine checks every 10 minutes (each trigger the retry allows).
    let t = NOW;
    for (; t < NOW + RELEASE_CHECK_FAILING_AFTER_MS; t += RELEASE_CHECK_RETRY_MS) {
      expect((await check(t)).outcome).toBe("failed");
      // Quiet while it may still be a laptop waking up or a short outage.
      expect(releaseCheckFailing(readUpdateState(dataDir), t)).toBeNull();
    }
    expect((await check(t)).outcome).toBe("failed");
    const failing = releaseCheckFailing(readUpdateState(dataDir), t);
    expect(failing?.since).toBe(NOW);
    // In words a person reads, never a status code.
    expect(failing?.error).toBe("release page didn't answer as expected");
    // The surfaces carry it with the command that always works.
    expect(buildUpdateCheckFailing(readUpdateState(dataDir), t, "curl -fsSL https://plannotator.ai/install.sh | bash")).toEqual({
      since: new Date(NOW).toISOString(),
      error: failing!.error,
      command: "curl -fsSL https://plannotator.ai/install.sh | bash",
    });
  });

  test("the run of failures survives the claim of each next attempt (no flicker while a check is in flight)", async () => {
    page = captivePortal;
    api = rateLimited;
    for (let t = NOW; t <= NOW + 3 * HOUR; t += RELEASE_CHECK_RETRY_MS) await check(t);
    const now = NOW + 3 * HOUR + RELEASE_CHECK_RETRY_MS;
    // A check in flight: the page hangs while the claim is already written.
    let release!: () => void;
    page = () => {
      throw new Error("unreachable");
    };
    const hanging = runReleaseCheck({
      dataDir,
      enabled: () => true,
      now: () => now,
      fetchReleasePage: () => new Promise((resolve) => (release = () => resolve({ ok: false, error: "offline" }))),
      fetchRelease: async () => ({ ok: false, error: "offline" }),
    });
    await Bun.sleep(10);
    expect(releaseCheckFailing(readUpdateState(dataDir), now)?.since).toBe(NOW);
    // Its process gone mid-request (the claim never answered): still shown,
    // never a gap until the next check.
    expect(releaseCheckFailing(readUpdateState(dataDir), now + 5 * MIN)?.since).toBe(NOW);
    expect(releaseCheckFailing(readUpdateState(dataDir), now + 20 * MIN)?.since).toBe(NOW);
    release();
    await hanging;
    expect(releaseCheckFailing(readUpdateState(dataDir), now)?.since).toBe(NOW);
  });

  test("one success ends it, and the release it names is known", async () => {
    page = captivePortal;
    api = rateLimited;
    let t = NOW;
    for (; t <= NOW + 4 * HOUR; t += RELEASE_CHECK_RETRY_MS) await check(t);
    expect(releaseCheckFailing(readUpdateState(dataDir), t)).not.toBeNull();
    page = redirectTo("0.28.32");
    expect(await check(t)).toEqual({ outcome: "checked", version: "0.28.32" });
    expect(releaseCheckFailing(readUpdateState(dataDir), t)).toBeNull();
    expect(readUpdateState(dataDir).releaseCheck?.failingSince).toBeUndefined();
  });

  test("an old run is not a failing check: the machine slept (or checks were off) since its last failure", async () => {
    page = captivePortal;
    api = rateLimited;
    let t = NOW;
    for (; t <= NOW + 4 * HOUR; t += RELEASE_CHECK_RETRY_MS) await check(t);
    const last = t - RELEASE_CHECK_RETRY_MS;
    expect(releaseCheckFailing(readUpdateState(dataDir), last)).not.toBeNull();
    // Offline at 6 pm, asleep until 9 am: before the morning check runs, nothing is claimed.
    expect(releaseCheckFailing(readUpdateState(dataDir), last + 15 * HOUR)).toBeNull();
    // Checks turned back on after weeks: the same.
    expect(releaseCheckFailing(readUpdateState(dataDir), last + 21 * 24 * HOUR)).toBeNull();
    // The morning check fails too: 4 hours of failures and none since: said again, since the first.
    await check(last + 15 * HOUR);
    expect(releaseCheckFailing(readUpdateState(dataDir), last + 15 * HOUR)?.since).toBe(NOW);
  });

  test("a week asleep counts as no more than 90 minutes: one failure on waking stays quiet", async () => {
    page = captivePortal;
    api = rateLimited;
    // An hour on a train, then the lid closed for a week.
    for (let t = NOW; t <= NOW + HOUR; t += RELEASE_CHECK_RETRY_MS) await check(t);
    const wake = NOW + HOUR + 7 * 24 * HOUR;
    // The Wi-Fi is not up yet on waking: 1 h + at most 90 min is under 3 h.
    await check(wake);
    expect(releaseCheckFailing(readUpdateState(dataDir), wake)).toBeNull();
    // Still failing half an hour on: 3 hours of failing, since the train.
    let t = wake;
    for (; t <= wake + 30 * MIN; t += RELEASE_CHECK_RETRY_MS) await check(t);
    expect(releaseCheckFailing(readUpdateState(dataDir), t - RELEASE_CHECK_RETRY_MS)?.since).toBe(NOW);
  });

  for (const gapMinutes of [95, 120]) {
    test(`checks ${gapMinutes} minutes apart (a review window now and then, a laptop that sleeps a lot) still reach "can't check", and keep saying it`, async () => {
      page = captivePortal;
      api = rateLimited;
      const shownAt: number[] = [];
      for (let i = 0; i < 36; i++) {
        const t = NOW + i * gapMinutes * MIN;
        expect((await check(t)).outcome).toBe("failed");
        const failing = releaseCheckFailing(readUpdateState(dataDir), t);
        if (failing) {
          expect(failing.since).toBe(NOW);
          shownAt.push(i);
        }
      }
      // The third failed check (two gaps, each counted as 90 minutes) on, every one.
      expect(shownAt[0]).toBe(2);
      expect(shownAt).toHaveLength(34);
    });
  }

  test("a mirror that only the API may ask (PLANNOTATOR_UPDATE_API_URL), held back by the rate limit: still shown as failing", async () => {
    api = rateLimited;
    let fetches = 0;
    const apiOnly = (now: number) =>
      runReleaseCheck({
        dataDir,
        enabled: () => true,
        now: () => now,
        fetchReleasePage: async () => ({ ok: false, error: "no release page source", skipped: true }),
        fetchRelease: () => (fetches++, fetchLatestRelease(`${base()}/api/repos/backnotprop/plannotator/releases/latest`)),
      });
    let t = NOW;
    for (; t <= NOW + 5 * HOUR; t += RELEASE_CHECK_RETRY_MS) await apiOnly(t);
    // The API was asked once (then held back for 6 h), yet the run stays visible.
    expect(fetches).toBe(1);
    expect(releaseCheckFailing(readUpdateState(dataDir), t - RELEASE_CHECK_RETRY_MS)?.since).toBe(NOW);
  });

  test("a stamp in the future (the clock moved back) is no failure", () => {
    writeUpdateState({ releaseCheck: { attemptedAt: NOW, failedAt: NOW, failingSince: NOW + 10 * HOUR, error: "offline" } }, dataDir);
    expect(releaseCheckFailing(readUpdateState(dataDir), NOW + 5 * HOUR)).toBeNull();
  });

  test("a success another process recorded since (one that predates failingSince) ends it too", () => {
    writeUpdateState(
      {
        latestRelease: { tag: "0.28.32", fetchedAt: NOW + 4 * HOUR },
        releaseCheck: { attemptedAt: NOW + 4 * HOUR, failingSince: NOW, error: "offline" },
      },
      dataDir,
    );
    expect(releaseCheckFailing(readUpdateState(dataDir), NOW + 5 * HOUR)).toBeNull();
  });
});

describe("GitHub changing the redirect's spelling", () => {
  test("on github.com the owner or repository in another case is still read; a mirror is read exactly", () => {
    const github = "https://github.com/backnotprop/plannotator/releases/latest";
    expect(versionFromLatestRedirect(github, "https://github.com/BackNotProp/Plannotator/releases/tag/v0.28.32")).toBe("0.28.32");
    expect(versionFromLatestRedirect(github, "/backnotprop/plannotator/releases/tag/v0.28.32")).toBe("0.28.32");
    expect(versionFromLatestRedirect(pageUrl(), `${base()}/BackNotProp/Plannotator/releases/tag/v0.28.32`)).toBeNull();
    expect(versionFromLatestRedirect(pageUrl(), `${base()}/backnotprop/plannotator/releases/tag/v0.28.32`)).toBe("0.28.32");
  });

  test("another host or another path is still refused (and falls to the API, then to the failing state)", () => {
    expect(versionFromLatestRedirect(pageUrl(), "https://evil.example/backnotprop/plannotator/releases/tag/v9.9.9")).toBeNull();
    expect(versionFromLatestRedirect(pageUrl(), `${base()}/backnotprop/plannotator/releases`)).toBeNull();
  });
});

describe("a state file that cannot be written", () => {
  test("the machine still checks (throttled in memory) and knows the answer; nothing is lost to a failed write", async () => {
    let requests = 0;
    page = () => (requests++, redirectTo("0.28.32")());
    api = rateLimited;
    // update-state.json is a folder: every write of it fails.
    mkdirSync(join(dataDir, "update-state.json"));
    expect(await check(NOW)).toEqual({ outcome: "checked", version: "0.28.32" });
    expect(readUpdateState(dataDir).latestRelease?.tag).toBe("0.28.32");
    // Within the 10 minutes: answered from memory, no second request.
    expect((await check(NOW + 5 * MIN)).outcome).toBe("fresh");
    expect(requests).toBe(1);
    expect((await check(NOW + RELEASE_CHECK_RETRY_MS + MIN)).outcome).toBe("checked");
    expect(requests).toBe(2);
    // A failed write leaves no temp file behind.
    expect(readdirSync(dataDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("once the file can be written again, this process writes its own changes over what others wrote, never a stale copy", async () => {
    page = redirectTo("0.28.32");
    api = rateLimited;
    mkdirSync(join(dataDir, "update-state.json"));
    expect((await check(NOW)).outcome).toBe("checked");
    // The file comes back, and other processes write their own fields to it.
    rmSync(join(dataDir, "update-state.json"), { recursive: true });
    const others = {
      lastCheckAt: NOW + MIN,
      pending: { version: "0.28.32", fromVersion: "0.28.31", startedAt: NOW + MIN, by: "person" },
      snooze: { version: "0.28.33", until: NOW + HOUR },
    };
    writeFileSync(join(dataDir, "update-state.json"), JSON.stringify(others));
    // Read: theirs from the file, this process's answer from memory.
    const seen = readUpdateState(dataDir);
    expect(seen).toMatchObject(others);
    expect(seen.latestRelease?.tag).toBe("0.28.32");
    // The next write lands, with both.
    page = redirectTo("0.28.33");
    expect((await check(NOW + RELEASE_CHECK_RETRY_MS + MIN)).outcome).toBe("checked");
    const disk = JSON.parse(readFileSync(join(dataDir, "update-state.json"), "utf-8"));
    expect(disk.pending).toEqual(others.pending);
    expect(disk.lastCheckAt).toBe(others.lastCheckAt);
    expect(disk.latestRelease.tag).toBe("0.28.33");
    expect(disk.snooze).toEqual(others.snooze);
    // Memory mode is over: the file is the truth again.
    writeFileSync(join(dataDir, "update-state.json"), JSON.stringify({ ...disk, lastCheckAt: NOW + 2 * HOUR }));
    expect(readUpdateState(dataDir).lastCheckAt).toBe(NOW + 2 * HOUR);
  });
});

describe("why checking fails, in plain words", () => {
  test("no status codes: the page and the API by name, rate limits and unreachable said so", () => {
    expect(plainCheckError("page: HTTP 200; api: HTTP 403, rate limited")).toBe("release page didn't answer as expected; GitHub API rate-limited");
    expect(plainCheckError("page: Unable to connect. Is the computer able to access the url?; api: fetch failed")).toBe(
      "couldn't reach the release page; couldn't reach the GitHub API",
    );
    expect(plainCheckError("page: The operation timed out.")).toBe("release page took too long to answer");
    expect(plainCheckError("page: HTTP 429")).toBe("release page rate-limited");
    expect(plainCheckError("api: HTTP 403, rate limited")).toBe("GitHub API rate-limited");
    // What an older version stored: still a reason, never a code.
    expect(plainCheckError("HTTP 403")).toBe("GitHub didn't answer as expected");
    expect(plainCheckError('not a stable version: "v1.0.0-rc.1"')).toBe("GitHub named no stable release");
  });
});

describe("Remind me tomorrow never hides an update for longer than a day", () => {
  test("a snooze written while the clock was ahead ends a day from now at most", () => {
    const state = { snooze: { version: "0.28.32", until: NOW + 30 * 24 * HOUR } };
    expect(isSnoozed(state, "0.28.32", NOW)).toBe(false);
    expect(isSnoozed({ snooze: { version: "0.28.32", until: NOW + UPDATE_SNOOZE_MS } }, "0.28.32", NOW)).toBe(true);
    expect(isSnoozed({ snooze: { version: "0.28.32", until: NOW - 1 } }, "0.28.32", NOW)).toBe(false);
    expect(isSnoozed({ snooze: { version: "0.28.31", until: NOW + HOUR } }, "0.28.32", NOW)).toBe(false);
  });
});

describe("the terminal hint while checking fails", () => {
  test("says checking is failing, with the install command, once a day; a known newer release still wins", () => {
    writeUpdateState({ releaseCheck: { attemptedAt: NOW, failedAt: NOW, failingSince: NOW - 4 * HOUR, error: "page: HTTP 200" } }, dataDir);
    // A binary the install script does not manage (brew, nix): never the curl script.
    const unmanaged = takeUpdateHint({ current: "0.28.31", enabled: true, now: NOW, dataDir, platform: "linux", managed: false });
    expect(unmanaged).toContain("update it the way you installed it");
    expect(unmanaged).not.toContain("curl");
    writeUpdateState({ releaseCheck: { attemptedAt: NOW, failedAt: NOW, failingSince: NOW - 4 * HOUR, error: "page: HTTP 200" } }, dataDir);
    const line = takeUpdateHint({ current: "0.28.31", enabled: true, now: NOW, dataDir, platform: "linux" });
    expect(line).toContain("can't check for updates");
    expect(line).toContain("(release page didn't answer as expected)");
    expect(line).toContain("curl -fsSL https://plannotator.ai/install.sh | bash");
    expect(takeUpdateHint({ current: "0.28.31", enabled: true, now: NOW + HOUR, dataDir, platform: "linux" })).toBeNull();
    // Off: nothing at all.
    writeUpdateState({ releaseCheck: { attemptedAt: NOW, failingSince: NOW - 4 * HOUR, error: "x" } }, dataDir);
    expect(takeUpdateHint({ current: "0.28.31", enabled: false, now: NOW, dataDir })).toBeNull();
    writeUpdateState({ latestRelease: { tag: "0.28.32", fetchedAt: NOW - 5 * HOUR }, releaseCheck: { attemptedAt: NOW, failingSince: NOW - 4 * HOUR, error: "x" } }, dataDir);
    expect(takeUpdateHint({ current: "0.28.31", enabled: true, now: NOW, dataDir })).toContain("0.28.32 is available");
  });
});
