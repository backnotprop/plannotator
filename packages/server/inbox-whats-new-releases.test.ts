import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readReleaseNotes,
  releaseBodyStamp,
  writeReleaseNotes,
  type FetchedRelease,
  type FetchReleaseListResult,
  type FetchReleaseResult,
} from "@plannotator/shared/update-check";
import { createInboxUpdates } from "./inbox-updates";
import {
  readReleaseList,
  refreshReleaseList,
  RELEASE_LIST_INTERVAL_MS,
  RELEASE_LIST_RETRY_MS,
  whatsNewReleases,
} from "./inbox-whats-new-releases";

const HOUR = 60 * 60 * 1000;
let dataDir: string;
let clock: number;
let savedEnv: Record<string, string | undefined>;
let listCalls: number;
let tagCalls: string[];
let listAnswer: () => FetchReleaseListResult;

const bodyOf = (version: string, tldr = "", table = "") =>
  [table, `## What's New in v${version}`, "", tldr, `What ${version} brings. More words after it.`, "", "## Install / Update", ""].join("\n");
const rel = (version: string, body = bodyOf(version)): FetchedRelease => ({ tag: `v${version}`, publishedAt: "2026-11-01T10:00:00Z", body });

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-wn-releases-")));
  savedEnv = { data: process.env.PLANNOTATOR_DATA_DIR, check: process.env.PLANNOTATOR_UPDATE_CHECK, api: process.env.PLANNOTATOR_UPDATE_API_URL };
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_UPDATE_CHECK;
  clock = Date.parse("2026-11-08T12:00:00Z");
  listCalls = 0;
  tagCalls = [];
  listAnswer = () => ({ ok: true, releases: [rel("0.28.53", bodyOf("0.28.53", "### TL;DR\n\n- **New:** Fifty-three\n")), rel("0.28.52"), rel("0.28.45")] });
});

afterEach(() => {
  const restore = (key: string, value: string | undefined) => (value === undefined ? delete process.env[key] : (process.env[key] = value));
  restore("PLANNOTATOR_DATA_DIR", savedEnv.data);
  restore("PLANNOTATOR_UPDATE_CHECK", savedEnv.check);
  restore("PLANNOTATOR_UPDATE_API_URL", savedEnv.api);
  rmSync(dataDir, { recursive: true, force: true });
});

function updates(version = "0.28.53") {
  return createInboxUpdates({
    dataDir,
    version,
    binaryPath: null,
    healthTickMs: 60_000,
    now: () => clock,
    whatsNewWaitMs: 2_000,
    fetchRelease: async (): Promise<FetchReleaseResult> => ({ ok: false, error: "not in this test" }),
    fetchReleasePage: async (): Promise<FetchReleaseResult> => ({ ok: false, error: "not in this test", skipped: true }),
    fetchReleaseList: async () => {
      listCalls++;
      return listAnswer();
    },
    fetchReleaseTag: async (v): Promise<FetchReleaseResult> => {
      tagCalls.push(v);
      return { ok: true, release: { tag: `v${v}`, body: bodyOf(v) } };
    },
    isManaged: () => false,
    listSessions: () => [],
    onChange: () => {},
  });
}

test("the list is asked at most once a day; in between the panel reads the cache (an hour after a failure)", async () => {
  const u = updates();
  const first = await u.whatsNewReleases();
  expect(listCalls).toBe(1);
  expect(first.releases.map((r) => r.version)).toEqual(["0.28.53", "0.28.52", "0.28.45"]);
  expect(first.latest).toBe("0.28.53");
  expect(first.releases[0]!.tldr).toEqual([{ label: "New", text: "Fifty-three" }]);

  clock += RELEASE_LIST_INTERVAL_MS - 60_000;
  await u.whatsNewReleases();
  await u.whatsNew("0.28.52");
  expect(listCalls).toBe(1);

  clock += 60_000;
  listAnswer = () => ({ ok: false, error: "fetch failed" });
  const offline = await u.whatsNewReleases();
  expect(listCalls).toBe(2);
  expect(offline.offline).toBe(true);
  expect(offline.releases.map((r) => r.version)).toEqual(["0.28.53", "0.28.52", "0.28.45"]);

  clock += RELEASE_LIST_RETRY_MS - 1;
  await u.whatsNewReleases();
  expect(listCalls).toBe(2);
  clock += 1;
  listAnswer = () => ({ ok: false, error: "HTTP 403", rateLimited: true, retryAfterMs: 3 * HOUR });
  await u.whatsNewReleases();
  expect(listCalls).toBe(3);
  clock += 2 * HOUR;
  await u.whatsNewReleases();
  expect(listCalls).toBe(3);
});

test("any release the list names opens, its notes from the list's own answer; one it does not name is never fetched", async () => {
  const u = updates();
  const answer = await u.whatsNew("0.28.45");
  expect(answer.kind).toBe("notes");
  if (answer.kind === "notes") expect(answer.notes.notes).toBe("What 0.28.45 brings. More words after it.");
  expect(tagCalls).toEqual([]);
  expect(listCalls).toBe(1);

  listAnswer = () => ({ ok: true, releases: [rel("0.28.53"), rel("0.28.44", "## What's Changed\n\n* a PR\n")] });
  clock += RELEASE_LIST_INTERVAL_MS;
  const later = await u.whatsNew("0.28.44");
  expect(later.kind).toBe("notes");
  expect(tagCalls).toEqual(["0.28.44"]);

  const unknown = await u.whatsNew("0.27.1");
  expect(unknown).toEqual({ kind: "missing", reason: "not_found" });
  expect(tagCalls).toEqual(["0.28.44"]);
});

test("saved notes without a TL;DR are written again once when the list's body differs; notes with one are left as saved", async () => {
  writeReleaseNotes({ version: "0.28.52", notes: "Old words.", highlights: [] }, dataDir);
  writeReleaseNotes({ version: "0.28.45", notes: "Kept words.", highlights: [], tldr: [{ label: "Fixed", text: "Kept" }], stamp: "other" }, dataDir);
  const backfilled = bodyOf("0.28.52", "### TL;DR\n\n- **Changed:** Backfilled\n");
  listAnswer = () => ({ ok: true, releases: [rel("0.28.53"), rel("0.28.52", backfilled), rel("0.28.45")] });
  const first = await refreshReleaseList({ dataDir, now: () => clock, enabled: () => true, fetchList: async () => listAnswer() });
  expect(first).toMatchObject({ outcome: "fetched", written: ["0.28.53", "0.28.52"] });
  const now52 = readReleaseNotes("0.28.52", dataDir)!;
  expect(now52.tldr).toEqual([{ label: "Changed", text: "Backfilled" }]);
  expect(now52.stamp).toBe(releaseBodyStamp(backfilled));
  expect(readReleaseNotes("0.28.45", dataDir)!.notes).toBe("Kept words.");

  clock += RELEASE_LIST_INTERVAL_MS;
  const again = await refreshReleaseList({ dataDir, now: () => clock, enabled: () => true, fetchList: async () => listAnswer() });
  expect(again).toMatchObject({ outcome: "fetched", written: [] });
});

test("update checks off: no list, no notes request, and the page says why", async () => {
  process.env.PLANNOTATOR_UPDATE_CHECK = "0";
  writeReleaseNotes({ version: "0.28.50", notes: "Saved before.", highlights: [] }, dataDir);
  const u = updates();
  const panel = await u.whatsNewReleases();
  expect(panel.releases.map((r) => r.version)).toEqual(["0.28.53", "0.28.50"]);
  expect(panel.offline).toBe(false);
  expect(await u.whatsNew("0.28.53")).toEqual({ kind: "missing", reason: "checks_off" });
  expect((await u.whatsNew("0.28.50")).kind).toBe("notes");
  expect(await u.whatsNew("0.28.53", 200, { retry: true })).toEqual({ kind: "missing", reason: "checks_off" });
  expect(listCalls).toBe(0);
  expect(tagCalls).toEqual([]);
  expect(readReleaseList(dataDir)).toBeNull();
});

test("GitHub out of reach: the notes are 'unreachable', and Try again asks once more at once", async () => {
  listAnswer = () => ({ ok: false, error: "fetch failed" });
  const u = createInboxUpdates({
    dataDir,
    version: "0.28.53",
    binaryPath: null,
    healthTickMs: 60_000,
    now: () => clock,
    whatsNewWaitMs: 2_000,
    fetchReleaseList: async () => {
      listCalls++;
      return listAnswer();
    },
    fetchReleaseTag: async (v) => {
      tagCalls.push(v);
      return { ok: false, error: "fetch failed" };
    },
    onChange: () => {},
  });
  expect(await u.whatsNew("0.28.53")).toEqual({ kind: "missing", reason: "unreachable" });
  expect([listCalls, tagCalls.length]).toEqual([1, 1]);
  expect(await u.whatsNew("0.28.53")).toEqual({ kind: "missing", reason: "unreachable" });
  expect([listCalls, tagCalls.length]).toEqual([1, 1]);
  await u.whatsNew("0.28.53", 2_000, { retry: true });
  expect([listCalls, tagCalls.length]).toEqual([2, 2]);
});

test("the panel's rows: newest first, the running version always in, each row's table line from the newest saved notes", () => {
  writeReleaseNotes(
    {
      version: "0.28.53",
      notes: "Newest. Second sentence.",
      highlights: [
        { version: "0.28.52", text: "From fifty-three's table" },
        { version: "0.28.40", text: "Forty, from fifty-three" },
      ],
      tldr: [{ label: "New", text: "A" }],
    },
    dataDir,
  );
  writeReleaseNotes({ version: "0.28.52", notes: "Fifty-two opens with this. Then more.", highlights: [{ version: "0.28.40", text: "Forty, older table" }] }, dataDir);
  writeReleaseNotes({ version: "0.28.40", notes: "", highlights: [] }, dataDir);
  const model = whatsNewReleases(dataDir, { current: "0.28.41", refreshing: false, known: ["0.28.41"] });
  expect(model.releases.map((r) => r.version)).toEqual(["0.28.53", "0.28.52", "0.28.41", "0.28.40"]);
  const by = new Map(model.releases.map((r) => [r.version, r]));
  expect(by.get("0.28.52")).toMatchObject({ tldr: [], listed: { text: "From fifty-three's table", in: "0.28.53" }, sentence: "Fifty-two opens with this.", saved: true });
  expect(by.get("0.28.40")).toMatchObject({ listed: { text: "Forty, from fifty-three", in: "0.28.53" }, sentence: null, saved: false });
  expect(by.get("0.28.41")).toMatchObject({ tldr: [], listed: null, sentence: null, saved: false });
});

test("the real request: one GET of …/releases?per_page=20 beside the API URL knob, with the update check's user agent", async () => {
  const seen: { path: string; ua: string | null }[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname + url.search, ua: req.headers.get("user-agent") });
      if (url.pathname !== "/repos/o/r/releases") return new Response("not found", { status: 404 });
      return Response.json([
        { tag_name: "v0.28.53", published_at: "2026-11-08T00:00:00Z", body: bodyOf("0.28.53") },
        { tag_name: "v0.29.0-rc.1", prerelease: true, body: bodyOf("0.29.0") },
        { tag_name: "v0.28.52", draft: true, body: "" },
        { tag_name: "nightly", body: "" },
      ]);
    },
  });
  try {
    process.env.PLANNOTATOR_UPDATE_API_URL = `http://127.0.0.1:${api.port}/repos/o/r/releases/latest`;
    const out = await refreshReleaseList({ dataDir, now: () => clock, enabled: () => true });
    expect(out).toMatchObject({ outcome: "fetched", versions: ["0.28.53"] });
    expect(seen).toEqual([{ path: "/repos/o/r/releases?per_page=20", ua: "plannotator-update-check" }]);
    expect(readReleaseNotes("0.28.53", dataDir)?.publishedAt).toBe("2026-11-08T00:00:00Z");
  } finally {
    api.stop(true);
  }
});
