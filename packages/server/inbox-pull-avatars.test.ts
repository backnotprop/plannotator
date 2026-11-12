import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
      lookup: async () => ["140.82.112.3"],
      env: {},
    },
  };
  return s;
}

const URL_A = "https://avatars.githubusercontent.com/u/1?s=96&v=4";

async function settledImages(dir: string, count: number): Promise<string[]> {
  const images = () => readdirSync(dir).filter((n) => n.endsWith(".img"));
  for (let i = 0; i < 200 && images().length > count; i++) await new Promise((done) => setTimeout(done, 10));
  return images();
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const picture = () => new Response(png(), { headers: { "content-type": "image/png" } });

describe("PR authors' pictures", () => {
  test("a login the list did not show is refused, and nothing is fetched", async () => {
    const s = scripted();
    const avatars = createPullAvatars({ ...s.options, dir: tempDir() });
    avatars.allow("github.com", { tomas: URL_A });
    expect(avatars.known("github.com", "tomas")).toBe(true);
    expect(avatars.known("github.com", "mallory")).toBe(false);
    expect(await avatars.get("github.com", "mallory")).toEqual({ ok: false, miss: "unknown" });
    expect(await avatars.get("ghe.corp.example", "tomas")).toEqual({ ok: false, miss: "unknown" });
    avatars.allow("github.com", { priya: URL_A });
    expect(await avatars.get("github.com", "tomas")).toEqual({ ok: false, miss: "unknown" });
    expect(s.fetched).toEqual([]);
  });

  test("a GitHub picture is asked for at a face's size, its full upload or a smaller size it named; others stay as given", async () => {
    const s = scripted();
    const avatars = createPullAvatars({ ...s.options, dir: tempDir() });
    avatars.allow("github.com", {
      full: "https://avatars.githubusercontent.com/u/1000002?u=4f69eb&v=4",
      small: "https://avatars.githubusercontent.com/u/1000001?s=48&v=4",
      sized: "https://avatars.githubusercontent.com/u/1000003?size=48",
    });
    avatars.allow("ghe.example", { server: "https://ghe.example/avatars/u/7?v=4" });
    avatars.allow("gitlab.com", { lab: "https://gitlab.com/uploads/-/system/user/avatar/9/me.png?width=64" });
    await avatars.get("github.com", "full");
    await avatars.get("github.com", "small");
    await avatars.get("github.com", "sized");
    await avatars.get("ghe.example", "server");
    await avatars.get("gitlab.com", "lab");
    expect(s.fetched).toEqual([
      "https://avatars.githubusercontent.com/u/1000002?u=4f69eb&v=4&s=96",
      "https://avatars.githubusercontent.com/u/1000001?s=96&v=4",
      "https://avatars.githubusercontent.com/u/1000003?s=96",
      "https://ghe.example/avatars/u/7?v=4&s=96",
      "https://gitlab.com/uploads/-/system/user/avatar/9/me.png?width=64",
    ]);
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
    const next = createPullAvatars({ ...s.options, dir, now: () => now });
    next.allow("github.com", { tomas: URL_A });
    expect((await next.get("github.com", "tomas")).ok).toBe(true);
    expect(s.fetched).toEqual([URL_A]);
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
    expect(await avatars.get("github.com", "tomas")).toEqual({ ok: false, miss: "status" });
    expect(s.fetched).toHaveLength(1);
    now += 2 * 60 * 60 * 1000;
    s.answer = () => new Response(png(), { headers: { "content-type": "image/png" } });
    expect((await avatars.get("github.com", "tomas")).ok).toBe(true);
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
    const images = await settledImages(dir, 2);
    expect(images).toHaveLength(2);
    expect(images.reduce((sum, n) => sum + statSync(join(dir, n)).size, 0)).toBeLessThanOrEqual(2500);
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
    avatars.allow("ghe.corp.example", { ana: "https://ghe.corp.example/avatars/u/3?s=96", eve: "https://intranet.corp.example/x.png", loop: "http://127.0.0.1:8123/a.png" });
    expect((await avatars.get("ghe.corp.example", "ana")).ok).toBe(true);
    expect(await avatars.get("ghe.corp.example", "eve")).toEqual({ ok: false, miss: "not_public" });
    expect(await avatars.get("ghe.corp.example", "loop")).toEqual({ ok: false, miss: "not_https" });
    expect(s.fetched).toEqual(["https://ghe.corp.example/avatars/u/3?s=96"]);

    const sandboxed = scripted();
    const fake = createPullAvatars({ ...sandboxed.options, env: { PLANNOTATOR_TEST_SANDBOX: "1" }, dir: tempDir() });
    fake.allow("github.com", { loop: "http://127.0.0.1:8123/a.png", far: "http://avatars.example/a.png" });
    expect((await fake.get("github.com", "loop")).ok).toBe(true);
    expect(await fake.get("github.com", "far")).toEqual({ ok: false, miss: "not_https" });
    expect(sandboxed.fetched).toEqual(["http://127.0.0.1:8123/a.png"]);
  });

  test("a host the last list did not name keeps no login (its project removed, its CLI signed out)", async () => {
    const s = scripted();
    const avatars = createPullAvatars({ ...s.options, dir: tempDir() });
    avatars.allowOnly([
      { host: "github.com", avatars: { tomas: URL_A } },
      { host: "gitlab.com", avatars: { jun: "https://gitlab.com/uploads/-/system/user/avatar/7/a.png" } },
    ]);
    expect(avatars.known("gitlab.com", "jun")).toBe(true);
    avatars.allowOnly([{ host: "GitHub.com", avatars: { priya: URL_A } }]);
    expect(avatars.known("gitlab.com", "jun")).toBe(false);
    expect(avatars.known("github.com", "tomas")).toBe(false);
    expect(avatars.known("github.com", "priya")).toBe(true);
    expect(await avatars.get("gitlab.com", "jun")).toEqual({ ok: false, miss: "unknown" });
    avatars.allowOnly([]);
    expect(avatars.known("github.com", "priya")).toBe(false);
    expect(s.fetched).toEqual([]);
  });

  test("the cache size is kept as pictures are written: a restarted Inbox learns it from the folder and trims past the cap", async () => {
    const dir = tempDir();
    let now = 1_000_000;
    const s = scripted(() => new Response(png(1000), { headers: { "content-type": "image/png" } }));
    const first = createPullAvatars({ ...s.options, dir, now: () => now, capBytes: 3500 });
    first.allow("github.com", { a: `${URL_A}&a`, b: `${URL_A}&b`, c: `${URL_A}&c` });
    for (const login of ["a", "b", "c"]) {
      now += 1000;
      expect((await first.get("github.com", login)).ok).toBe(true);
    }
    expect(await settledImages(dir, 3)).toHaveLength(3);
    await new Promise((done) => setTimeout(done, 100));
    writeFileSync(join(dir, "planted.img"), png(1000));
    writeFileSync(join(dir, "planted.json"), JSON.stringify({ type: "image/png", at: 0, url: "x" }));
    now += 25 * 60 * 60 * 1000;
    expect((await first.get("github.com", "c")).ok).toBe(true);
    await new Promise((done) => setTimeout(done, 100));
    expect(readdirSync(dir).filter((n) => n.endsWith(".img"))).toHaveLength(4);
    expect(readdirSync(dir)).toContain("planted.img");
    const next = createPullAvatars({ ...s.options, dir, now: () => now, capBytes: 2500 });
    next.allow("github.com", { d: `${URL_A}&d` });
    now += 1000;
    expect((await next.get("github.com", "d")).ok).toBe(true);
    const kept = await settledImages(dir, 2);
    expect(kept).toHaveLength(2);
    expect(kept.reduce((sum, n) => sum + statSync(join(dir, n)).size, 0)).toBeLessThanOrEqual(2500);
  });

  test("misses are dropped after their hour: memory holds only the ones still remembered", async () => {
    const s = scripted(() => new Response("nope", { status: 404 }));
    let now = 1_000_000;
    const avatars = createPullAvatars({ ...s.options, dir: tempDir(), now: () => now });
    avatars.allow("github.com", { a: `${URL_A}&a`, b: `${URL_A}&b`, c: `${URL_A}&c`, d: `${URL_A}&d` });
    for (const login of ["a", "b", "c"]) expect(await avatars.get("github.com", login)).toEqual({ ok: false, miss: "status" });
    expect(avatars.missesHeld()).toBe(3);
    now += 2 * 60 * 60 * 1000;
    expect(await avatars.get("github.com", "d")).toEqual({ ok: false, miss: "status" });
    expect(avatars.missesHeld()).toBe(1);
  });

  describe("redirects", () => {
    test("to a private address (a name that resolves to 10.x, or the metadata IP) is refused", async () => {
      for (const location of ["https://internal.corp.example/a.png", "https://169.254.169.254/latest/meta-data/"]) {
        const s = scripted((url) => (url === URL_A ? redirect(location) : picture()));
        s.options.lookup = async (name) => (name === "internal.corp.example" ? ["10.0.0.7"] : ["140.82.112.3"]);
        const avatars = createPullAvatars({ ...s.options, dir: tempDir() });
        avatars.allow("github.com", { tomas: URL_A });
        expect(await avatars.get("github.com", "tomas")).toEqual({ ok: false, miss: "not_public" });
        expect(s.fetched).toEqual([URL_A]);
      }
    });

    test("to plain http is refused", async () => {
      const s = scripted((url) => (url === URL_A ? redirect("http://avatars.example/a.png") : picture()));
      const avatars = createPullAvatars({ ...s.options, dir: tempDir() });
      avatars.allow("github.com", { tomas: URL_A });
      expect(await avatars.get("github.com", "tomas")).toEqual({ ok: false, miss: "redirect" });
      expect(s.fetched).toEqual([URL_A]);
    });

    test("three are followed; a fourth is refused", async () => {
      const chain = (hops: number) => (url: string) => {
        const at = Number(new URL(url).searchParams.get("hop") ?? "0");
        return at < hops ? redirect(`https://avatars.example/a.png?hop=${at + 1}`) : picture();
      };
      const three = scripted(chain(3));
      const ok = createPullAvatars({ ...three.options, dir: tempDir() });
      ok.allow("github.com", { tomas: "https://avatars.example/a.png" });
      expect((await ok.get("github.com", "tomas")).ok).toBe(true);
      expect(three.fetched).toHaveLength(4);

      const four = scripted(chain(4));
      const refused = createPullAvatars({ ...four.options, dir: tempDir() });
      refused.allow("github.com", { tomas: "https://avatars.example/a.png" });
      expect(await refused.get("github.com", "tomas")).toEqual({ ok: false, miss: "redirect" });
      expect(four.fetched).toHaveLength(4);
    });

    test("to the forge's private host on another port is refused: the forge is its name and its own port", async () => {
      const privateNames = async () => ["10.0.0.5"];
      for (const location of ["https://ghe.corp.example:8443/x.png", "https://ghe.corp.example:444/x.png"]) {
        const s = scripted((url) => (url.endsWith("/avatars/u/3?s=96") ? redirect(location) : picture()));
        s.options.lookup = privateNames;
        const avatars = createPullAvatars({ ...s.options, dir: tempDir() });
        avatars.allow("ghe.corp.example", { ana: "https://ghe.corp.example/avatars/u/3?s=96" });
        expect(await avatars.get("ghe.corp.example", "ana")).toEqual({ ok: false, miss: "not_public" });
        expect(s.fetched).toEqual(["https://ghe.corp.example/avatars/u/3?s=96"]);
      }
      const same = scripted((url) => (url.endsWith("/avatars/u/3?s=96") ? redirect("https://ghe.corp.example:443/x.png") : picture()));
      same.options.lookup = privateNames;
      const onDefault = createPullAvatars({ ...same.options, dir: tempDir() });
      onDefault.allow("ghe.corp.example", { ana: "https://ghe.corp.example/avatars/u/3?s=96" });
      expect((await onDefault.get("ghe.corp.example", "ana")).ok).toBe(true);

      const ported = scripted((url) =>
        url.endsWith("/avatars/u/4?s=96") ? redirect("https://ghe.corp.example/x.png") : url.endsWith("/avatars/u/5?s=96") ? redirect("https://ghe.corp.example:9443/x.png") : url.endsWith("/avatars/u/6") ? redirect("https://ghe.corp.example:8443/y.png") : picture(),
      );
      ported.options.lookup = privateNames;
      const onPort = createPullAvatars({ ...ported.options, dir: tempDir() });
      onPort.allow("ghe.corp.example", {
        ana: "https://ghe.corp.example:8443/avatars/u/3?s=96",
        bo: "https://ghe.corp.example:8443/avatars/u/4?s=96",
        cy: "https://ghe.corp.example:8443/avatars/u/5?s=96",
        di: "https://ghe.corp.example:8443/avatars/u/6",
      });
      expect((await onPort.get("ghe.corp.example", "ana")).ok).toBe(true);
      expect(await onPort.get("ghe.corp.example", "bo")).toEqual({ ok: false, miss: "not_public" });
      expect(await onPort.get("ghe.corp.example", "cy")).toEqual({ ok: false, miss: "not_public" });
      expect((await onPort.get("ghe.corp.example", "di")).ok).toBe(true);
    });
  });
});
