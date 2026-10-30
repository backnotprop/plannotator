/**
 * Images in the What's new page (inbox-whats-new-images.ts): which URLs the
 * Inbox fetches, the caps on each image, the release check's switch and
 * claim, and the route that serves the copies. GitHub is a fake on loopback,
 * reached the way tests reach the release API (PLANNOTATOR_UPDATE_API_URL);
 * nothing here asks the real GitHub.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEASE_CHECK_RETRY_MS,
  RELEASE_NOTES_PENDING_RETRY_MS,
  readReleaseNotes,
  readUpdateState,
  writeReleaseNotes,
  writeUpdateState,
} from "@plannotator/shared/update-check";
import { startInboxServer, type InboxServer } from "./inbox";
import {
  RELEASE_IMAGES_MAX,
  allowedReleaseImageUrl,
  fetchReleaseImage,
  fetchReleaseImagesFor,
  readReleaseImages,
  releaseImageSources,
} from "./inbox-whats-new-images";

/** A PNG header naming its size (enough for the sniffer and the pixel cap). */
function png(width = 2, height = 3, pad = 0): Uint8Array {
  const bytes = new Uint8Array(33 + pad);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

let dataDir: string;
let savedDataDir: string | undefined;
let savedCheck: string | undefined;
let savedUrl: string | undefined;
let gh: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let requests: { path: string; ua: string | null }[];
let otherRequests: number;
let routes: Record<string, () => Response>;
const servers: InboxServer[] = [];

const origin = () => `http://127.0.0.1:${gh.port}`;
const asset = (name: string) => `${origin()}/user-attachments/assets/${name}`;

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-whatsnew-images-")));
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  savedCheck = process.env.PLANNOTATOR_UPDATE_CHECK;
  savedUrl = process.env.PLANNOTATOR_UPDATE_API_URL;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_UPDATE_CHECK;
  requests = [];
  otherRequests = 0;
  routes = {};
  gh = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push({ path, ua: req.headers.get("user-agent") });
      const route = routes[path];
      return route ? route() : new Response("not found", { status: 404 });
    },
  });
  // Another loopback origin: not the one the knob names, so not allowed.
  other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      otherRequests++;
      return new Response(png(), { headers: { "content-type": "image/png" } });
    },
  });
  process.env.PLANNOTATOR_UPDATE_API_URL = `${origin()}/repos/backnotprop/plannotator/releases/latest`;
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  gh.stop(true);
  other.stop(true);
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("PLANNOTATOR_DATA_DIR", savedDataDir);
  restore("PLANNOTATOR_UPDATE_CHECK", savedCheck);
  restore("PLANNOTATOR_UPDATE_API_URL", savedUrl);
  rmSync(dataDir, { recursive: true, force: true });
});

const writeNotes = (notes: string, version = "0.28.12") => writeReleaseNotes({ version, notes, highlights: [] }, dataDir);

describe("which URLs are fetched", () => {
  const env = {} as NodeJS.ProcessEnv;
  test("GitHub's hosts, https only", () => {
    const ok = (u: string) => allowedReleaseImageUrl(u, env) !== null;
    expect(ok("https://github.com/user-attachments/assets/0b1c-uuid")).toBe(true);
    expect(ok("https://private-user-images.githubusercontent.com/1/2.png?jwt=x")).toBe(true);
    expect(ok("https://user-images.githubusercontent.com/1/2.png")).toBe(true);
    // Only the hosts release attachments use: not gist., objects., camo. or others.
    expect(ok("https://gist.githubusercontent.com/u/abc/raw/a.png")).toBe(false);
    expect(ok("https://objects.githubusercontent.com/a.png")).toBe(false);
    expect(ok("https://camo.githubusercontent.com/abc")).toBe(false);
    expect(ok("https://avatars.githubusercontent.com/u/1")).toBe(false);
    expect(ok("https://githubusercontent.com/a.png")).toBe(false);
    // An empty label never passes.
    expect(ok("https://.githubusercontent.com/a.png")).toBe(false);
    expect(ok("https://private-user-images..githubusercontent.com/a.png")).toBe(false);
    expect(ok("https://private-user-images.githubusercontent.com./a.png")).toBe(false);
    expect(ok("https://github.com./user-attachments/assets/a")).toBe(false);
    expect(ok("https://raw.githubusercontent.com/backnotprop/plannotator/main/a.png")).toBe(true);
    // raw only for this repository; github.com only for attachments.
    expect(ok("https://raw.githubusercontent.com/someone/else/main/a.png")).toBe(false);
    expect(ok("https://github.com/backnotprop/plannotator/raw/main/a.png")).toBe(false);
    expect(ok("https://github.com/user-attachments/files/1/a.zip")).toBe(false);
    // Lookalikes, other schemes, ports and credentials.
    expect(ok("https://githubusercontent.com.evil.example/a.png")).toBe(false);
    expect(ok("https://evilgithubusercontent.com/a.png")).toBe(false);
    expect(ok("https://example.com/a.png")).toBe(false);
    expect(ok("http://github.com/user-attachments/assets/a")).toBe(false);
    expect(ok("https://github.com:8443/user-attachments/assets/a")).toBe(false);
    expect(ok("https://u:p@github.com/user-attachments/assets/a")).toBe(false);
    expect(ok("//github.com/user-attachments/assets/a")).toBe(false);
    expect(ok("data:image/png;base64,AAAA")).toBe(false);
  });

  test("loopback only through the knob, and only its own origin", () => {
    expect(allowedReleaseImageUrl("http://127.0.0.1:9999/x.png", env)).toBeNull();
    const knob = { PLANNOTATOR_UPDATE_API_URL: "http://127.0.0.1:9999/releases/latest" } as NodeJS.ProcessEnv;
    expect(allowedReleaseImageUrl("http://127.0.0.1:9999/x.png", knob)).not.toBeNull();
    expect(allowedReleaseImageUrl("http://127.0.0.1:9998/x.png", knob)).toBeNull();
    // A mirror that is not loopback widens nothing.
    const mirror = { PLANNOTATOR_UPDATE_API_URL: "https://mirror.example/releases/latest" } as NodeJS.ProcessEnv;
    expect(allowedReleaseImageUrl("https://mirror.example/x.png", mirror)).toBeNull();
  });

  test("the notes' images: in text order, once, outside code, allowed only, at most 12", () => {
    const a = "https://github.com/user-attachments/assets/a";
    const b = "https://private-user-images.githubusercontent.com/b.png";
    const notes = [
      `![one](${a})`,
      `<img width="600" alt="two" src="${b}" />`,
      "```",
      "![code](https://github.com/user-attachments/assets/in-code)",
      "```",
      `![again](${a})`,
      "![elsewhere](https://example.com/x.png)",
      ...Array.from({ length: 20 }, (_, i) => `![n${i}](https://github.com/user-attachments/assets/n${i})`),
    ].join("\n\n");
    const sources = releaseImageSources(notes, {} as NodeJS.ProcessEnv);
    expect(sources.slice(0, 3)).toEqual([a, b, "https://github.com/user-attachments/assets/n0"]);
    expect(sources).toHaveLength(RELEASE_IMAGES_MAX);
    expect(sources).not.toContain("https://example.com/x.png");
  });
});

describe("fetching one image", () => {
  test("follows a redirect within the allowed hosts, with the update check's user agent", async () => {
    routes["/user-attachments/assets/a"] = () => new Response(null, { status: 302, headers: { location: "/private/a.png" } });
    routes["/private/a.png"] = () => new Response(png(4, 5));
    const result = await fetchReleaseImage(asset("a"));
    expect(result).toMatchObject({ ok: true, contentType: "image/png", width: 4, height: 5 });
    expect(requests.map((r) => r.ua)).toEqual(["plannotator-update-check", "plannotator-update-check"]);
  });

  test("a redirect off the allowed hosts is not followed", async () => {
    routes["/user-attachments/assets/a"] = () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${other.port}/a.png` } });
    expect(await fetchReleaseImage(asset("a"))).toEqual({ ok: false, error: "redirected off the allowed hosts" });
    routes["/user-attachments/assets/b"] = () => new Response(null, { status: 301, headers: { location: "https://example.com/b.png" } });
    expect(await fetchReleaseImage(asset("b"))).toEqual({ ok: false, error: "redirected off the allowed hosts" });
    expect(otherRequests).toBe(0);
  });

  test("a redirect loop stops", async () => {
    routes["/user-attachments/assets/a"] = () => new Response(null, { status: 302, headers: { location: "/user-attachments/assets/a" } });
    expect(await fetchReleaseImage(asset("a"))).toEqual({ ok: false, error: "too many redirects" });
    expect(requests.length).toBe(6);
  });

  test("over 10 MB, declared or streamed, is refused", async () => {
    routes["/user-attachments/assets/declared"] = () => new Response(png(2, 2, 11 * 1024 * 1024));
    expect(await fetchReleaseImage(asset("declared"))).toEqual({ ok: false, error: "larger than 10 MB" });
    routes["/user-attachments/assets/streamed"] = () => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 0) controller.enqueue(png());
          if (sent > 12 * 1024 * 1024) return controller.close();
          controller.enqueue(new Uint8Array(1024 * 1024));
          sent += 1024 * 1024;
        },
      });
      return new Response(body);
    };
    expect(await fetchReleaseImage(asset("streamed"))).toEqual({ ok: false, error: "larger than 10 MB" });
  });

  test("over 50 megapixels, not an image, an HTTP error", async () => {
    routes["/user-attachments/assets/huge"] = () => new Response(png(10_000, 10_000));
    expect(await fetchReleaseImage(asset("huge"))).toEqual({ ok: false, error: "more than 50 megapixels" });
    routes["/user-attachments/assets/html"] = () => new Response("<html>nope</html>", { headers: { "content-type": "image/png" } });
    expect(await fetchReleaseImage(asset("html"))).toEqual({ ok: false, error: "not an image" });
    expect(await fetchReleaseImage(asset("missing"))).toEqual({ ok: false, error: "HTTP 404" });
  });

  test("a slow answer times out", async () => {
    routes["/user-attachments/assets/slow"] = () =>
      new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "image/png" } });
    const result = await fetchReleaseImage(asset("slow"), { timeoutMs: 200 });
    expect(result.ok).toBe(false);
  });
});

describe("a release's images", () => {
  const deps = (over: Partial<Parameters<typeof fetchReleaseImagesFor>[0]> = {}) => ({
    version: "0.28.12",
    dataDir,
    enabled: () => true,
    ...over,
  });

  test("stored beside the notes, mapped by src; a failed one is left out and the notes stay", async () => {
    routes["/user-attachments/assets/a"] = () => new Response(png(4, 5));
    routes["/user-attachments/assets/b"] = () => new Response(png(6, 7));
    writeNotes(`Hello.\n\n![a](${asset("a")})\n\n<img alt="b" src="${asset("b")}">\n\n![gone](${asset("gone")})`);
    const outcome = await fetchReleaseImagesFor(deps());
    expect(outcome).toMatchObject({ outcome: "fetched", stored: [asset("a"), asset("b")], failed: [{ src: asset("gone"), error: "HTTP 404" }] });
    const images = readReleaseImages("0.28.12", dataDir);
    expect(Object.keys(images).sort()).toEqual([asset("a"), asset("b")].sort());
    expect(images[asset("a")]).toMatchObject({ content_type: "image/png", width: 4, height: 5 });
    const dir = join(dataDir, "update-notes", "0.28.12");
    expect(readdirSync(dir).sort()).toEqual([images[asset("a")]!.file, images[asset("b")]!.file, "images.json"].sort());
    expect(readReleaseNotes("0.28.12", dataDir)?.notes).toStartWith("Hello.");
    // The claim, with the failure: no second request within 6 h.
    expect(readUpdateState(dataDir).releaseImagesFetch?.["0.28.12"]).toMatchObject({ failedAt: expect.any(Number), error: "HTTP 404" });
    const before = requests.length;
    expect(await fetchReleaseImagesFor(deps())).toEqual({ outcome: "not-due" });
    // Images keep the notes' back-off, not the hourly release check's.
    expect(await fetchReleaseImagesFor(deps({ now: () => Date.now() + RELEASE_CHECK_RETRY_MS }))).toEqual({ outcome: "not-due" });
    expect(requests.length).toBe(before);
    // Six hours later only the missing one is asked for again.
    expect(await fetchReleaseImagesFor(deps({ now: () => Date.now() + 6 * 60 * 60 * 1000 + 1 }))).toMatchObject({ outcome: "fetched", stored: [] });
    expect(requests.slice(before).map((r) => r.path)).toEqual(["/user-attachments/assets/gone"]);
  });

  test("everything stored: nothing is asked", async () => {
    routes["/user-attachments/assets/a"] = () => new Response(png());
    writeNotes(`![a](${asset("a")})`);
    await fetchReleaseImagesFor(deps());
    const before = requests.length;
    expect(await fetchReleaseImagesFor(deps({ now: () => Date.now() + 48 * 60 * 60 * 1000 }))).toEqual({ outcome: "present" });
    expect(requests.length).toBe(before);
  });

  test("update checks off: no request at all", async () => {
    routes["/user-attachments/assets/a"] = () => new Response(png());
    writeNotes(`![a](${asset("a")})`);
    expect(await fetchReleaseImagesFor(deps({ enabled: () => false }))).toEqual({ outcome: "disabled" });
    expect(requests).toEqual([]);
    expect(readUpdateState(dataDir).releaseImagesFetch).toBeUndefined();
  });

  test("a process that quits mid-fetch (its claim never answered) is retried after 15 minutes, not in a day", async () => {
    routes["/user-attachments/assets/a"] = () => new Response(png());
    writeNotes(`![a](${asset("a")})`);
    const start = Date.now();
    // The first try claims, then its process goes away before any image answers.
    void fetchReleaseImagesFor(deps({ now: () => start, fetchImpl: (() => new Promise<never>(() => {})) as unknown as typeof fetch }));
    expect(readUpdateState(dataDir).releaseImagesFetch?.["0.28.12"]?.attemptedAt).toBe(start);
    // A concurrent process still waits out the claim (a live fetch takes about 3 min at most)...
    expect(await fetchReleaseImagesFor(deps({ now: () => start + RELEASE_NOTES_PENDING_RETRY_MS - 1 }))).toEqual({ outcome: "not-due" });
    expect(requests).toEqual([]);
    // ...and asks again 15 minutes after it.
    expect(await fetchReleaseImagesFor(deps({ now: () => start + RELEASE_NOTES_PENDING_RETRY_MS }))).toMatchObject({ outcome: "fetched", stored: [asset("a")] });
    expect(Object.keys(readReleaseImages("0.28.12", dataDir))).toEqual([asset("a")]);
  });

  test("an answer clears the in-flight mark: an image added to the notes later waits the answer's day", async () => {
    routes["/user-attachments/assets/a"] = () => new Response(png());
    routes["/user-attachments/assets/b"] = () => new Response(png(4, 5));
    writeNotes(`![a](${asset("a")})`);
    const start = Date.now();
    expect(await fetchReleaseImagesFor(deps({ now: () => start }))).toMatchObject({ outcome: "fetched", stored: [asset("a")] });
    // The release body is edited after publishing: the notes now show a second image.
    writeNotes(`![a](${asset("a")})\n\n![b](${asset("b")})`);
    const before = requests.length;
    expect(await fetchReleaseImagesFor(deps({ now: () => start + RELEASE_NOTES_PENDING_RETRY_MS }))).toEqual({ outcome: "not-due" });
    expect(requests.length).toBe(before);
    expect(await fetchReleaseImagesFor(deps({ now: () => start + 24 * 60 * 60 * 1000 }))).toMatchObject({ outcome: "fetched", stored: [asset("b")] });
  });

  test("at most 12 per release", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 15; i++) {
      routes[`/user-attachments/assets/n${i}`] = () => new Response(png(1, i + 1));
      lines.push(`![n${i}](${asset(`n${i}`)})`);
    }
    writeNotes(lines.join("\n\n"));
    const outcome = await fetchReleaseImagesFor(deps());
    expect(outcome.outcome === "fetched" && outcome.stored.length).toBe(12);
    expect(requests).toHaveLength(12);
  });
});

describe("the What's new page and its image route", () => {
  async function start(env: Record<string, string> = {}): Promise<InboxServer> {
    Object.assign(process.env, env);
    const server = await startInboxServer({
      dataDir,
      version: "0.28.12",
      binaryPath: null,
      healthTickMs: 60_000,
      updates: {
        fetchRelease: async () => ({ ok: false, error: "offline" }),
        isManaged: () => true,
        listSessions: () => [],
        launchInstaller: () => {},
      },
    });
    servers.push(server);
    return server;
  }
  const url = (server: InboxServer, src: string, version = "0.28.12") =>
    `http://127.0.0.1:${server.port}/api/inbox/whats-new/image?version=${version}&src=${encodeURIComponent(src)}`;

  test("the page lists the stored images and the route serves them with the image headers", async () => {
    routes["/user-attachments/assets/a"] = () => new Response(png(4, 5));
    writeNotes(`Notes.\n\n![a](${asset("a")})\n\n![gone](${asset("gone")})`);
    const server = await start();
    const page = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/whats-new?version=0.28.12`)).json()) as { images: string[] };
    expect(page.images).toEqual([asset("a")]);

    const res = await fetch(url(server, asset("a")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("x-image-width")).toBe("4");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png(4, 5));
    expect((await fetch(url(server, asset("a")), { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await fetch(url(server, asset("a")), { method: "HEAD" })).status).toBe(200);

    const code = async (r: Response) => [r.status, ((await r.json()) as { code: string }).code];
    expect(await code(await fetch(url(server, asset("a")), { headers: { "sec-fetch-site": "cross-site" } }))).toEqual([403, "cross_origin"]);
    expect(await code(await fetch(url(server, asset("a")), { headers: { "sec-fetch-site": "same-site" } }))).toEqual([403, "cross_origin"]);
    expect(await code(await fetch(url(server, asset("gone"))))).toEqual([404, "image_not_stored"]);
    expect(await code(await fetch(url(server, asset("never-in-notes"))))).toEqual([404, "image_not_referenced"]);
    expect(await code(await fetch(url(server, asset("a"), "../x")))).toEqual([422, "validation_error"]);
    expect(await code(await fetch(url(server, asset("a")), { method: "POST" }))).toEqual([405, "method_not_allowed"]);
  });

  test("a stored file that no longer matches its name is not served", async () => {
    routes["/user-attachments/assets/a"] = () => new Response(png(4, 5));
    writeNotes(`![a](${asset("a")})`);
    const server = await start();
    await fetch(`http://127.0.0.1:${server.port}/api/inbox/whats-new?version=0.28.12`);
    const entry = readReleaseImages("0.28.12", dataDir)[asset("a")]!;
    writeFileSync(join(dataDir, "update-notes", "0.28.12", entry.file), png(9, 9));
    expect((await fetch(url(server, asset("a")))).status).toBe(404);
  });

  test("update checks off: the page fetches no image and lists none", async () => {
    routes["/user-attachments/assets/a"] = () => new Response(png());
    writeNotes(`![a](${asset("a")})`);
    const server = await start({ PLANNOTATOR_UPDATE_CHECK: "0" });
    const page = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/whats-new?version=0.28.12`)).json()) as { images: string[] };
    expect(page.images).toEqual([]);
    expect(requests).toEqual([]);
    expect(existsSync(join(dataDir, "update-notes", "0.28.12"))).toBe(false);
  });

  test("a version this Inbox has no reason to show fetches nothing", async () => {
    routes["/user-attachments/assets/a"] = () => new Response(png());
    writeNotes(`![a](${asset("a")})`, "0.20.1");
    writeUpdateState({}, dataDir);
    const server = await start();
    const page = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/whats-new?version=0.20.1`)).json()) as { images: string[] };
    expect(page.images).toEqual([]);
    expect(requests).toEqual([]);
  });
});
