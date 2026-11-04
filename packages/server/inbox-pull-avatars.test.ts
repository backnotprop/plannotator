/**
 * PR authors' pictures for the Pull requests list (inbox-pull-avatars.ts), through a scripted fetch and DNS: never
 * the network, a temp folder for the disk cache.
 *
 * What regresses:
 *  - a login the list never showed (or a URL the page names) making the Inbox fetch anything;
 *  - a second fetch for a picture read within the day, in this process or the next (the disk cache);
 *  - a failed fetch served as a picture, or a failed refetch losing the picture already kept;
 *  - the cache growing past its cap, or dropping the newest picture before the oldest;
 *  - something not an image (SVG, HTML) or too big served from the Inbox's origin; a fetch that never ends;
 *  - loopback http fetched outside the test sandbox.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPullAvatars, type PullAvatarOptions } from "./inbox-pull-avatars";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-pull-avatars-"));
  dirs.push(dir);
  return join(dir, "pull-avatars");
};

/** A PNG's signature and a body of `size` bytes in all. */
const png = (size = 64, fill = 1) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};

interface Scripted {
  fetched: string[];
  answer: (url: string) => Response | Promise<Response>;
  options: Partial<PullAvatarOptions>;
}

function scripted(answer: (url: string) => Response | Promise<Response> = () => new Response(png(), { headers: { "content-type": "image/png" } })): Scripted {
  const s: Scripted = {
    fetched: [],
    answer,
    options: {
      fetch: async (url) => {
        s.fetched.push(url);
        return s.answer(url);
      },
      // Every name is public here; the tests that need otherwise say so.
      lookup: async () => ["140.82.112.3"],
      env: {},
    },
  };
  return s;
}

const URL_A = "https://avatars.githubusercontent.com/u/1?v=4";

describe("PR authors' pictures", () => {
  test("a login the list did not show is refused, and nothing is fetched", async () => {
    const s = scripted();
    const avatars = createPullAvatars({ ...s.options, dir: tempDir() });
    avatars.allow("github.com", { tomas: URL_A });
    expect(avatars.known("github.com", "tomas")).toBe(true);
    expect(avatars.known("github.com", "mallory")).toBe(false);
    expect(await avatars.get("github.com", "mallory")).toEqual({ ok: false, miss: "unknown" });
    // Another host's list does not vouch for a login here.
    expect(await avatars.get("ghe.corp.example", "tomas")).toEqual({ ok: false, miss: "unknown" });
    // A new list without the login takes its permission away.
    avatars.allow("github.com", { priya: URL_A });
    expect(await avatars.get("github.com", "tomas")).toEqual({ ok: false, miss: "unknown" });
    expect(s.fetched).toEqual([]);
  });

  test("a picture read within the day is served from the cache: no second fetch, in this process or the next", async () => {
    const s = scripted();
    const dir = tempDir();
    let now = 1_000_000;
    const first = createPullAvatars({ ...s.options, dir, now: () => now });
    first.allow("github.com", { tomas: URL_A });
    const got = await first.get("github.com", "tomas");
    expect(got.ok && got.type).toBe("image/png");
    now += 60_000;
    expect((await first.get("github.com", "tomas")).ok).toBe(true);
    expect(s.fetched).toEqual([URL_A]);
    // A restarted Inbox reads it from disk.
    const next = createPullAvatars({ ...s.options, dir, now: () => now });
    next.allow("github.com", { tomas: URL_A });
    expect((await next.get("github.com", "tomas")).ok).toBe(true);
    expect(s.fetched).toEqual([URL_A]);
    // Past the day it is fetched again; a new URL (a changed picture) at once.
    now += 25 * 60 * 60 * 1000;
    await next.get("github.com", "tomas");
    expect(s.fetched).toHaveLength(2);
    next.allow("github.com", { tomas: `${URL_A}&changed` });
    await next.get("github.com", "tomas");
    expect(s.fetched).toHaveLength(3);
  });

  test("a failed fetch is a miss (the window shows initials); a failed refetch serves the picture already kept", async () => {
    const s = scripted(() => new Response("nope", { status: 404 }));
    let now = 1_000_000;
    const avatars = createPullAvatars({ ...s.options, dir: tempDir(), now: () => now });
    avatars.allow("github.com", { tomas: URL_A });
    expect(await avatars.get("github.com", "tomas")).toEqual({ ok: false, miss: "status" });
    // Remembered for a while: not asked again at once.
    expect(await avatars.get("github.com", "tomas")).toEqual({ ok: false, miss: "status" });
    expect(s.fetched).toHaveLength(1);
    now += 2 * 60 * 60 * 1000;
    s.answer = () => new Response(png(), { headers: { "content-type": "image/png" } });
    expect((await avatars.get("github.com", "tomas")).ok).toBe(true);
    // A day later the forge fails: the kept picture still shows.
    now += 25 * 60 * 60 * 1000;
    s.answer = () => Promise.reject(new Error("offline"));
    const kept = await avatars.get("github.com", "tomas");
    expect(kept.ok).toBe(true);
    expect(s.fetched).toHaveLength(3);
  });

  test("the cache stays under its cap: the oldest picture goes first", async () => {
    const s = scripted(() => new Response(png(1000), { headers: { "content-type": "image/png" } }));
    const dir = tempDir();
    let now = 1_000_000;
    const avatars = createPullAvatars({ ...s.options, dir, now: () => now, capBytes: 2500 });
    avatars.allow("github.com", { a: `${URL_A}&a`, b: `${URL_A}&b`, c: `${URL_A}&c` });
    for (const login of ["a", "b", "c"]) {
      now += 1000;
      expect((await avatars.get("github.com", login)).ok).toBe(true);
    }
    const images = readdirSync(dir).filter((n) => n.endsWith(".img"));
    expect(images).toHaveLength(2);
    expect(images.reduce((sum, n) => sum + statSync(join(dir, n)).size, 0)).toBeLessThanOrEqual(2500);
    // The newest two are kept: no fetch for them; the oldest is fetched again.
    const before = s.fetched.length;
    await avatars.get("github.com", "c");
    await avatars.get("github.com", "b");
    expect(s.fetched.length).toBe(before);
    await avatars.get("github.com", "a");
    expect(s.fetched.length).toBe(before + 1);
  });

  test("only an image is served: SVG, HTML and a body past the size cap are refused", async () => {
    const cases: [Response, string][] = [
      [new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", { headers: { "content-type": "image/svg+xml" } }), "not_image"],
      [new Response("<html></html>", { headers: { "content-type": "text/html" } }), "not_image"],
      // Declared an image, but its bytes are not one.
      [new Response("<svg/>", { headers: { "content-type": "image/png" } }), "not_image"],
      [new Response(png(5000), { headers: { "content-type": "image/png" } }), "too_big"],
    ];
    for (const [response, miss] of cases) {
      const s = scripted(() => response);
      const avatars = createPullAvatars({ ...s.options, dir: tempDir(), maxBytes: 4096 });
      avatars.allow("github.com", { tomas: URL_A });
      expect(await avatars.get("github.com", "tomas")).toEqual({ ok: false, miss: miss as never });
    }
  });

  test("a fetch that never answers ends at the deadline", async () => {
    const s = scripted(() => new Promise<Response>(() => {}));
    const avatars = createPullAvatars({ ...s.options, dir: tempDir(), timeoutMs: 50 });
    avatars.allow("github.com", { tomas: URL_A });
    expect(await avatars.get("github.com", "tomas")).toEqual({ ok: false, miss: "timeout" });
  });

  test("a private address is refused unless it is the forge's own host; loopback http only in the test sandbox", async () => {
    const s = scripted();
    s.options.lookup = async (name) => (name === "ghe.corp.example" ? ["10.0.0.5"] : ["10.0.0.9"]);
    const avatars = createPullAvatars({ ...s.options, dir: tempDir() });
    avatars.allow("ghe.corp.example", { ana: "https://ghe.corp.example/avatars/u/3", eve: "https://intranet.corp.example/x.png", loop: "http://127.0.0.1:8123/a.png" });
    expect((await avatars.get("ghe.corp.example", "ana")).ok).toBe(true);
    expect(await avatars.get("ghe.corp.example", "eve")).toEqual({ ok: false, miss: "not_public" });
    expect(await avatars.get("ghe.corp.example", "loop")).toEqual({ ok: false, miss: "not_https" });
    expect(s.fetched).toEqual(["https://ghe.corp.example/avatars/u/3"]);

    const sandboxed = scripted();
    const fake = createPullAvatars({ ...sandboxed.options, env: { PLANNOTATOR_TEST_SANDBOX: "1" }, dir: tempDir() });
    fake.allow("github.com", { loop: "http://127.0.0.1:8123/a.png", far: "http://avatars.example/a.png" });
    expect((await fake.get("github.com", "loop")).ok).toBe(true);
    // Only loopback: plain http elsewhere stays refused.
    expect(await fake.get("github.com", "far")).toEqual({ ok: false, miss: "not_https" });
    expect(sandboxed.fetched).toEqual(["http://127.0.0.1:8123/a.png"]);
  });
});
