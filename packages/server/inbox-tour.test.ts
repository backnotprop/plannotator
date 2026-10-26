/**
 * The onboarding tour's server side (approval "inbox-onboarding-tour"): the
 * read-only fixture routes (served from the embedded content, only names the
 * manifest lists, sandboxed) and the `tour` settings key (config.json
 * `inboxTour`, written by the server only, every part checked first).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_TOUR_ASSET_PATHS } from "./inbox-tour-content";

const roots: string[] = [];
const servers: InboxServer[] = [];
let savedDataDir: string | undefined;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-tour-")));
  roots.push(root);
  const dataDir = join(root, "data");
  // config.json is read through the env, even with `dataDir`.
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  const at = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}${path}`, init);
  const settings = (body: Record<string, unknown>) =>
    at("/api/inbox/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
  return { dataDir, at, settings };
}

test("the fixture and every listed asset are served read only; nothing else is", async () => {
  const { at } = await setup();
  const fixture = await at("/api/inbox/tour/fixture.json");
  expect(fixture.status).toBe(200);
  expect(fixture.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(((await fixture.json()) as { threads: unknown[] }).threads.length).toBe(3);
  for (const name of Object.keys(INBOX_TOUR_ASSET_PATHS)) {
    const res = await at(`/api/inbox/tour/assets/${name}`);
    expect(res.status, name).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("content-security-policy")).toStartWith("sandbox");
  }
  const mock = await at("/api/inbox/tour/assets/vscode-mockups.html");
  expect(mock.headers.get("content-security-policy")).not.toContain("allow-same-origin");
  expect(mock.headers.get("content-security-policy")).toContain("default-src 'none'");
  for (const bad of ["/api/inbox/tour/assets/fixture.json", "/api/inbox/tour/assets/..%2Finbox.json", "/api/inbox/tour/assets/", "/api/inbox/tour/nope"]) {
    expect((await at(bad)).status, bad).toBe(404);
  }
  expect((await at("/api/inbox/tour/fixture.json", { method: "POST" })).status).toBe(405);
  expect((await at("/api/inbox/tour/fixture.json", { headers: { "Sec-Fetch-Site": "same-site" } })).status).toBe(403);
  const etag = fixture.headers.get("etag")!;
  expect((await at("/api/inbox/tour/fixture.json", { headers: { "If-None-Match": etag } })).status).toBe(304);
});

test("the tour setting: each true stamps now, notify_again is a flag, anything else refused and nothing written", async () => {
  const { dataDir, at, settings } = await setup();
  const read = async () => ((await (await at("/api/inbox/settings")).json()) as { tour: Record<string, unknown> }).tour;
  expect(await read()).toEqual({ version: 2, seen_at: null, finished_at: null, skipped_at: null, notify_again: false });
  const seen = await settings({ tour: { seen: true } });
  expect(seen.status).toBe(200);
  const after = ((await seen.json()) as { tour: Record<string, string | null> }).tour;
  expect(after.seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(after.finished_at).toBeNull();
  await settings({ tour: { finished: true, notify_again: true } });
  const done = await read();
  expect(done.finished_at).toBeTruthy();
  expect(done.notify_again).toBe(true);
  expect(done.seen_at).toBe(after.seen_at);
  expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxTour.finished_at).toBe(done.finished_at);
  for (const bad of [{ tour: {} }, { tour: { seen: "yes" } }, { tour: { started: true } }, { tour: [] }, { tour: { skipped: true }, text_size: 99 }]) {
    const res = await settings(bad);
    expect(res.status, JSON.stringify(bad)).toBe(422);
  }
  // The refused requests wrote nothing (the last one's tour part was valid).
  expect((await read()).skipped_at).toBeNull();
});

test("the film clip answers HTTP Range (206, 416, If-Range); EVALUATION.md is sandboxed plain text", async () => {
  const { at } = await setup();
  const whole = await at("/api/inbox/tour/assets/film-clip.mp4");
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-type")).toBe("video/mp4");
  expect(whole.headers.get("accept-ranges")).toBe("bytes");
  const size = (await whole.arrayBuffer()).byteLength;
  expect(size).toBeGreaterThan(100_000);
  const etag = whole.headers.get("etag")!;
  const part = await at("/api/inbox/tour/assets/film-clip.mp4", { headers: { Range: "bytes=0-1" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe(`bytes 0-1/${size}`);
  expect((await part.arrayBuffer()).byteLength).toBe(2);
  const tail = await at("/api/inbox/tour/assets/film-clip.mp4", { headers: { Range: "bytes=-10" } });
  expect(tail.headers.get("content-range")).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
  const past = await at("/api/inbox/tour/assets/film-clip.mp4", { headers: { Range: `bytes=${size}-` } });
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe(`bytes */${size}`);
  // If-Range: this version's ETag keeps the range; anything else is the whole film.
  expect((await at("/api/inbox/tour/assets/film-clip.mp4", { headers: { Range: "bytes=4-9", "If-Range": etag } })).status).toBe(206);
  expect((await at("/api/inbox/tour/assets/film-clip.mp4", { headers: { Range: "bytes=4-9", "If-Range": '"other"' } })).status).toBe(200);
  const head = await at("/api/inbox/tour/assets/film-clip.mp4", { method: "HEAD", headers: { Range: "bytes=0-99" } });
  expect(head.status).toBe(206);
  expect(head.headers.get("x-content-type-options")).toBe("nosniff");
  expect(head.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  const md = await at("/api/inbox/tour/assets/evaluation.md");
  expect(md.status).toBe(200);
  expect(md.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(md.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect(await md.text()).toContain("Most of it exists");
});
