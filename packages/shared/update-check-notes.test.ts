/**
 * One release's notes fetched by its tag (fetchReleaseNotesFor), for a
 * version installed before the daily check saw it, against a fake release API
 * on loopback (never GitHub): the request, the saved notes, the knob, the
 * per-version throttle, and stored notes without a "What's New" part.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RELEASE_API_URL,
  fetchReleaseNotesFor,
  readReleaseNotes,
  readUpdateState,
  RELEASE_CHECK_INTERVAL_MS,
  RELEASE_CHECK_RETRY_MS,
  releaseTagApiUrl,
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
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_CHECK_RETRY_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(1);
    answer = (path) => Response.json({ tag_name: "v0.28.19", body: bodyFor("0.28.19"), path });
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_CHECK_RETRY_MS })).outcome).toBe("fetched");
    expect(seen.length).toBe(2);
  });

  test("an answer for another tag is a failure and saves nothing", async () => {
    answer = () => Response.json({ tag_name: "v0.28.18", body: bodyFor("0.28.18") });
    expect((await fetchNotes("0.28.19")).outcome).toBe("failed");
    expect(readReleaseNotes("0.28.19", dataDir)).toBeNull();
  });

  test("notes saved before the release body was edited (no What's New part) are fetched again, once a day at most", async () => {
    // What the daily check saved from GitHub's generated notes, before the body was replaced.
    writeReleaseNotes({ version: "0.28.19", notes: "", highlights: [] }, dataDir);
    expect((await fetchNotes("0.28.19")).outcome).toBe("fetched");
    expect(readReleaseNotes("0.28.19", dataDir)!.notes).toBe("Notes the person reads.");
    expect(seen.length).toBe(1);

    // A release that really has no What's New part is not asked for again within 24 h.
    writeReleaseNotes({ version: "0.28.20", notes: "", highlights: [] }, dataDir);
    answer = () => Response.json({ tag_name: "v0.28.20", body: "## What's Changed\n\n* a PR" });
    expect((await fetchNotes("0.28.20")).outcome).toBe("fetched");
    expect((await fetchNotes("0.28.20", { now: NOW + RELEASE_CHECK_INTERVAL_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(2);
  });

  test("not a version: nothing asked", async () => {
    expect((await fetchNotes("../../etc/passwd")).outcome).toBe("failed");
    expect(seen.length).toBe(0);
  });
});
