/**
 * One release's notes fetched by its tag (fetchReleaseNotesFor), for a
 * version installed before the release check saw it, against a fake release API
 * on loopback (never GitHub): the request, the saved notes, the knob, the
 * per-version throttle, and stored notes without a "What's New" part.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RELEASE_API_URL,
  fetchReleaseNotesFor,
  patchUpdateState,
  readReleaseNotes,
  readUpdateState,
  RELEASE_ASSETS_FETCH_INTERVAL_MS,
  RELEASE_ASSETS_FETCH_RETRY_MS,
  RELEASE_CHECK_RETRY_MS,
  RELEASE_NOTES_PENDING_RETRY_MS,
  RELEASE_NOTES_YOUNG_MS,
  releaseTagApiUrl,
  updateCheckPaths,
  writeReleaseNotes,
} from "./update-check";

const NOW = 1_800_000_000_000;

const bodyFor = (version: string) =>
  [
    "| [v0.28.18](https://x/v0.28.18) | The Inbox's search |",
    "",
    `## What's New in v${version}`,
    "",
    "Notes the person reads.",
    "",
    "## Install / Update",
    "",
    "curl ...",
  ].join("\n");

interface Seen {
  path: string;
  userAgent: string | null;
}

let dataDir: string;
let seen: Seen[];
let answer: (path: string) => Response;
let server: ReturnType<typeof Bun.serve>;
let savedUrl: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-update-notes-"));
  seen = [];
  answer = (path) => {
    const m = /\/tags\/v(\d+\.\d+\.\d+)$/.exec(path);
    return m
      ? Response.json({ tag_name: `v${m[1]}`, published_at: "2026-10-14T09:00:00Z", body: bodyFor(m[1]!) })
      : new Response("not found", { status: 404 });
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ path, userAgent: req.headers.get("user-agent") });
      return answer(path);
    },
  });
  savedUrl = process.env.PLANNOTATOR_UPDATE_API_URL;
  process.env.PLANNOTATOR_UPDATE_API_URL = `http://127.0.0.1:${server.port}/repos/backnotprop/plannotator/releases/latest`;
});

afterEach(() => {
  server.stop(true);
  if (savedUrl === undefined) delete process.env.PLANNOTATOR_UPDATE_API_URL;
  else process.env.PLANNOTATOR_UPDATE_API_URL = savedUrl;
  rmSync(dataDir, { recursive: true, force: true });
});

const fetchNotes = (version: string, overrides: { now?: number; enabled?: boolean } = {}) =>
  fetchReleaseNotesFor({ version, dataDir, now: () => overrides.now ?? NOW, enabled: () => overrides.enabled ?? true });

describe("the tag URL", () => {
  test("GitHub's releases/tags/vX by default, and beside an override's latest", () => {
    expect(releaseTagApiUrl("0.28.19", {})).toBe(DEFAULT_RELEASE_API_URL.replace(/latest$/, "tags/v0.28.19"));
    expect(releaseTagApiUrl("v0.28.19", { PLANNOTATOR_UPDATE_API_URL: "http://127.0.0.1:9/releases/latest" })).toBe(
      "http://127.0.0.1:9/releases/tags/v0.28.19",
    );
    expect(releaseTagApiUrl("../x", {})).toBeNull();
  });
});

describe("fetchReleaseNotesFor", () => {
  test("a version with no saved notes is asked for once by its tag, and the notes are saved", async () => {
    expect(readReleaseNotes("0.28.19", dataDir)).toBeNull();
    const first = await fetchNotes("0.28.19");
    expect(first.outcome).toBe("fetched");
    expect(seen).toEqual([{ path: "/repos/backnotprop/plannotator/releases/tags/v0.28.19", userAgent: "plannotator-update-check" }]);
    const saved = readReleaseNotes("0.28.19", dataDir)!;
    expect(saved.notes).toBe("Notes the person reads.");
    expect(saved.publishedAt).toBe("2026-10-14T09:00:00Z");
    expect(saved.highlights.map((h) => h.version)).toEqual(["0.28.18"]);
    expect((await fetchNotes("0.28.19")).outcome).toBe("present");
    expect(seen.length).toBe(1);
  });

  test("update checks off: no request at all", async () => {
    expect((await fetchNotes("0.28.19", { enabled: false })).outcome).toBe("disabled");
    expect(seen.length).toBe(0);
    expect(readUpdateState(dataDir).notesFetch).toBeUndefined();
  });

  test("a failure waits 6 h before the next try; never a loop", async () => {
    answer = () => new Response("rate limited", { status: 403 });
    expect(await fetchNotes("0.28.19")).toEqual({ outcome: "failed", error: "HTTP 403" });
    expect(readUpdateState(dataDir).notesFetch?.["0.28.19"]).toMatchObject({ attemptedAt: NOW, failedAt: NOW, error: "HTTP 403" });
    expect((await fetchNotes("0.28.19", { now: NOW + 60_000 })).outcome).toBe("not-due");
    // Notes keep their own back-off, not the hourly release check's.
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_CHECK_RETRY_MS })).outcome).toBe("not-due");
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_ASSETS_FETCH_RETRY_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(1);
    answer = (path) => Response.json({ tag_name: "v0.28.19", body: bodyFor("0.28.19"), path });
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_ASSETS_FETCH_RETRY_MS })).outcome).toBe("fetched");
    expect(seen.length).toBe(2);
  });

  // The request-count promise of the network retry (F3 of #2338): a quick retry only after the network
  // came back, and a tag API that keeps failing while the release check answers waits 6 h, never 15 min.
  test("a failure is asked again 15 minutes after it once a release check answers, once; then 6 h while the check keeps answering", async () => {
    const answered = (at: number) =>
      patchUpdateState((s) => ({ ...s, latestRelease: { tag: "v0.28.19", fetchedAt: at }, releaseCheck: { attemptedAt: at } }), dataDir);
    answer = () => new Response("unavailable", { status: 502 });
    expect((await fetchNotes("0.28.19")).outcome).toBe("failed");
    // No release check has answered since: the network may still be down, 6 h.
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("not-due");
    answered(NOW + RELEASE_CHECK_RETRY_MS);
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS - 1 })).outcome).toBe("not-due");
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("failed");
    expect(seen.length).toBe(2);
    // It failed again with the network up: the check answers, so this source waits 6 h.
    answered(NOW + RELEASE_NOTES_PENDING_RETRY_MS + RELEASE_CHECK_RETRY_MS);
    const second = NOW + RELEASE_NOTES_PENDING_RETRY_MS;
    expect((await fetchNotes("0.28.19", { now: second + RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("not-due");
    expect((await fetchNotes("0.28.19", { now: second + RELEASE_ASSETS_FETCH_RETRY_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(2);
    expect((await fetchNotes("0.28.19", { now: second + RELEASE_ASSETS_FETCH_RETRY_MS })).outcome).toBe("failed");
    expect(seen.length).toBe(3);
  });

  test("a rate-limited failure is never asked again quickly, whatever the release check does", async () => {
    answer = () => new Response("rate limited", { status: 429 });
    expect((await fetchNotes("0.28.19")).outcome).toBe("failed");
    patchUpdateState((s) => ({ ...s, latestRelease: { tag: "v0.28.19", fetchedAt: NOW + 1 }, releaseCheck: { attemptedAt: NOW + 1 } }), dataDir);
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("not-due");
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_ASSETS_FETCH_RETRY_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(1);
  });

  test("a release check dated in the future (the clock moved back) does not unlock the quick retry", async () => {
    answer = () => new Response("unavailable", { status: 502 });
    expect((await fetchNotes("0.28.19")).outcome).toBe("failed");
    patchUpdateState((s) => ({ ...s, latestRelease: { tag: "v0.28.19", fetchedAt: NOW + RELEASE_ASSETS_FETCH_RETRY_MS }, releaseCheck: { attemptedAt: NOW } }), dataDir);
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("not-due");
    expect(seen.length).toBe(1);
  });

  // The answer clears the claim's in-flight mark: notes that could not be saved wait a day, not 15 minutes.
  test("an answer whose notes could not be saved is not asked again in 15 minutes", async () => {
    writeFileSync(updateCheckPaths(dataDir).notes, "not a folder"); // update-notes/ cannot be created
    expect((await fetchNotes("0.28.19")).outcome).toBe("fetched");
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("not-due");
    expect(seen.length).toBe(1);
  });

  test("an answer for another tag is a failure and saves nothing", async () => {
    answer = () => Response.json({ tag_name: "v0.28.18", body: bodyFor("0.28.18") });
    expect((await fetchNotes("0.28.19")).outcome).toBe("failed");
    expect(readReleaseNotes("0.28.19", dataDir)).toBeNull();
  });

  test("notes saved before the release body was edited (no What's New part) are fetched again, once a day at most", async () => {
    // What the release check saved from GitHub's generated notes, before the body was replaced.
    writeReleaseNotes({ version: "0.28.19", notes: "", highlights: [] }, dataDir);
    expect((await fetchNotes("0.28.19")).outcome).toBe("fetched");
    expect(readReleaseNotes("0.28.19", dataDir)!.notes).toBe("Notes the person reads.");
    expect(seen.length).toBe(1);

    // A release that really has no What's New part is not asked for again within 24 h.
    writeReleaseNotes({ version: "0.28.20", notes: "", highlights: [] }, dataDir);
    answer = () => Response.json({ tag_name: "v0.28.20", body: "## What's Changed\n\n* a PR" });
    expect((await fetchNotes("0.28.20")).outcome).toBe("fetched");
    expect((await fetchNotes("0.28.20", { now: NOW + RELEASE_ASSETS_FETCH_INTERVAL_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(2);
  });

  // The 0.28.37 bug: CI publishes GitHub's generated body and the written
  // notes replace it minutes later. An Inbox that asked in between waited a
  // day, so its "What's new" link never showed for that run.
  test("a young release answered without a What's New part is asked again after 15 minutes, not a day", async () => {
    const generated = "## What's Changed\n\n* a PR by someone";
    const publishedAt = new Date(NOW - 60_000).toISOString();
    answer = () => Response.json({ tag_name: "v0.28.37", published_at: publishedAt, body: generated });
    expect((await fetchNotes("0.28.37")).outcome).toBe("fetched");
    expect(readReleaseNotes("0.28.37", dataDir)!.notes).toBe("");
    expect((await fetchNotes("0.28.37", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(1);

    // Still the generated body: asked again on the same quick cadence.
    expect((await fetchNotes("0.28.37", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("fetched");
    expect((await fetchNotes("0.28.37", { now: NOW + 2 * RELEASE_NOTES_PENDING_RETRY_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(2);

    // The written notes are in now: the next try saves them, and nothing more is asked.
    answer = () => Response.json({ tag_name: "v0.28.37", published_at: publishedAt, body: bodyFor("0.28.37") });
    expect((await fetchNotes("0.28.37", { now: NOW + 2 * RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("fetched");
    expect(readReleaseNotes("0.28.37", dataDir)!.notes).toBe("Notes the person reads.");
    expect((await fetchNotes("0.28.37", { now: NOW + 3 * RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("present");
    expect(seen.length).toBe(3);
  });

  test("a release over 2 days old answered without a What's New part keeps the 24 h back-off", async () => {
    const publishedAt = new Date(NOW - RELEASE_NOTES_YOUNG_MS).toISOString();
    answer = () => Response.json({ tag_name: "v0.28.37", published_at: publishedAt, body: "## What's Changed\n" });
    expect((await fetchNotes("0.28.37")).outcome).toBe("fetched");
    expect((await fetchNotes("0.28.37", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("not-due");
    expect((await fetchNotes("0.28.37", { now: NOW + RELEASE_ASSETS_FETCH_INTERVAL_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(1);
    expect((await fetchNotes("0.28.37", { now: NOW + RELEASE_ASSETS_FETCH_INTERVAL_MS })).outcome).toBe("fetched");
    expect(seen.length).toBe(2);
  });

  test("the quick retry stops once the release turns 2 days old", async () => {
    const published = NOW - RELEASE_NOTES_YOUNG_MS + RELEASE_NOTES_PENDING_RETRY_MS;
    answer = () => Response.json({ tag_name: "v0.28.37", published_at: new Date(published).toISOString(), body: "" });
    expect((await fetchNotes("0.28.37")).outcome).toBe("fetched");
    // Due 15 minutes later, when the release is exactly 2 days old: no longer young, so a day.
    expect((await fetchNotes("0.28.37", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("not-due");
    expect(seen.length).toBe(1);
  });

  test("a process that quits mid-request (its claim never answered) is retried on the quick cadence, not in a day", async () => {
    const publishedAt = new Date(NOW - 60_000).toISOString();
    answer = () => Response.json({ tag_name: "v0.28.37", published_at: publishedAt, body: "## What's Changed\n" });
    expect((await fetchNotes("0.28.37")).outcome).toBe("fetched");
    // The next try claims, then its process goes away before GitHub answers.
    void fetchReleaseNotesFor({
      version: "0.28.37",
      dataDir,
      now: () => NOW + RELEASE_NOTES_PENDING_RETRY_MS,
      enabled: () => true,
      fetchRelease: () => new Promise<never>(() => {}),
    });
    expect(readUpdateState(dataDir).notesFetch?.["0.28.37"]?.attemptedAt).toBe(NOW + RELEASE_NOTES_PENDING_RETRY_MS);
    // A concurrent process still waits out the claim...
    expect((await fetchNotes("0.28.37", { now: NOW + 2 * RELEASE_NOTES_PENDING_RETRY_MS - 1 })).outcome).toBe("not-due");
    // ...and asks again 15 minutes after it, because the claim kept the release's date.
    answer = () => Response.json({ tag_name: "v0.28.37", published_at: publishedAt, body: bodyFor("0.28.37") });
    expect((await fetchNotes("0.28.37", { now: NOW + 2 * RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("fetched");
    expect(readReleaseNotes("0.28.37", dataDir)!.notes).toBe("Notes the person reads.");
  });

  test("update.log gets one line per version for a body without What's New, not one per retry", async () => {
    const publishedAt = new Date(NOW - 60_000).toISOString();
    answer = (path) =>
      Response.json({ tag_name: path.endsWith("v0.28.38") ? "v0.28.38" : "v0.28.37", published_at: publishedAt, body: "## What's Changed\n" });
    const pendingLines = (version: string) => {
      const log = existsSync(updateCheckPaths(dataDir).log) ? readFileSync(updateCheckPaths(dataDir).log, "utf-8") : "";
      return log.split("\n").filter((line) => line.includes(`release notes for ${version} have no`)).length;
    };
    for (let i = 0; i < 4; i++) {
      expect((await fetchNotes("0.28.37", { now: NOW + i * RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("fetched");
    }
    expect(seen.length).toBe(4);
    expect(pendingLines("0.28.37")).toBe(1);
    // Another version gets its own line.
    expect((await fetchNotes("0.28.38")).outcome).toBe("fetched");
    expect(pendingLines("0.28.38")).toBe(1);
  });

  test("not a version: nothing asked", async () => {
    expect((await fetchNotes("../../etc/passwd")).outcome).toBe("failed");
    expect(seen.length).toBe(0);
  });
});
