import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandBoardStamps } from "./stamps";
import { createShapeStore } from "./store";
import { fetchShapeWebPictures } from "./web-pictures";
import { handleShapeRoute } from "./routes";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "shape-web-pictures-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2"/></svg>';

function web(table: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetch = async (input: string | URL) => {
    const href = String(input);
    asked.push(href);
    const answer = table[href];
    return answer ? answer() : new Response("missing", { status: 404 });
  };
  return { fetch, asked };
}

const drawing = (html: string) => ({ title: "T", claim: "C", views: { picture: { html } } });

describe("fetching a board's web pictures", () => {
  test("each https picture is fetched once, by the address as the browser reads it, and named by its bytes", async () => {
    const w = web({
      "https://cdn.example.com/brand/acme?size=2&v=1": () => new Response(SVG),
      "https://cdn.example.com/a.png": () => new Response(PNG),
    });
    const board = {
      ...drawing('<svg><image href="https://cdn.example.com/brand/acme?size=2&amp;v=1"/></svg><img src="https://cdn.example.com/a.png"><img src="crop.png"><img src="data:image/png;base64,AAAA">'),
      refs: [{ n: 1, kind: "image", title: "A", target: "https://cdn.example.com/a.png" }, { n: 2, kind: "link", title: "Site", target: "https://example.com/" }],
    };
    const r = await fetchShapeWebPictures(board, { fetch: w.fetch });
    expect(r.errors).toEqual([]);
    expect(w.asked.sort()).toEqual(["https://cdn.example.com/a.png", "https://cdn.example.com/brand/acme?size=2&v=1"]);
    expect(r.pictures.get("https://cdn.example.com/brand/acme?size=2&amp;v=1")?.name).toBe("acme.svg");
    expect(r.pictures.get("https://cdn.example.com/a.png")?.name).toBe("a.png");
  });

  test("a page, a missing picture, an oversized one and a slow one are refused by field", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    const w = web({
      "https://example.com/page.png": () => new Response("<html><body>sign in</body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://example.com/big.png": () => new Response(big),
      "https://example.com/slow.png": () => new Response(new ReadableStream({ start() {} })),
    });
    const board = drawing(['page.png', 'gone.png', 'big.png', 'slow.png'].map((n) => `<img src="https://example.com/${n}">`).join("") + '<img src="https://user:pw@example.com/a.png">');
    const r = await fetchShapeWebPictures(board, { fetch: w.fetch, timeoutMs: 200 });
    expect(r.pictures.size).toBe(0);
    expect(r.errors).toEqual([
      'views.picture.html: "https://example.com/page.png" is not an image: its bytes are not a PNG, JPEG, GIF, WebP, SVG, AVIF or ICO (the site called it text/html)',
      'views.picture.html: "https://example.com/gone.png" could not be fetched: the site answered HTTP 404; download it and name the file, or leave it out',
      'views.picture.html: "https://example.com/big.png" is too large: more than 10 MB, the most a board keeps',
      'views.picture.html: "https://example.com/slow.png" timed out: it did not arrive within 0.2 s; download it and name the file, or leave it out',
      'views.picture.html: "https://user:pw@example.com/a.png" is not a web address this board can fetch (http or https, with a host)',
    ]);
    expect(w.asked).not.toContain("https://user:pw@example.com/a.png");
  });

  test("a picture whose address does not decode as a name is kept, and a network failure says what the network said", async () => {
    const w = web({ "https://example.com/logo%E0.png": () => new Response(PNG) });
    const fetch = async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("down.example")) throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
      return w.fetch(input);
    };
    const r = await fetchShapeWebPictures(drawing('<img src="https://example.com/logo%E0.png"><img src="https://down.example/a.png">'), { fetch });
    expect(r.pictures.get("https://example.com/logo%E0.png")?.name).toBe("logo_E0.png");
    expect(r.errors).toEqual([
      'views.picture.html: "https://down.example/a.png" could not be fetched (ConnectionRefused: Unable to connect. Is the computer able to access the url?); download it and name the file, or leave it out',
    ]);
  });

  test("the whole board gets one deadline: past it, the agent hears back about every picture still on its way", async () => {
    const fetch = async (input: string | URL) => (String(input).endsWith("/ok.png") ? new Response(PNG) : new Promise<Response>(() => {}));
    const names = ["ok", "a", "b", "c", "d", "e", "f"];
    const started = Date.now();
    const r = await fetchShapeWebPictures(drawing(names.map((n) => `<img src="https://example.com/${n}.png">`).join("")), { fetch, timeoutMs: 10_000, boardTimeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect([...r.pictures.keys()]).toEqual(["https://example.com/ok.png"]);
    expect(r.errors).toHaveLength(6);
    expect(r.errors.filter((e) => e.includes("timed out: the board's web pictures get 0.3 s in all, and this one was still on its way"))).toHaveLength(4);
    expect(r.errors.filter((e) => e.includes("was not fetched: the board's web pictures get 0.3 s in all"))).toHaveLength(2);
    for (const e of r.errors) expect(e).toEndWith("; download it and name the file, or leave it out");
  });
});

describe("a board with a logo, a screenshot and a web picture", () => {
  test("the logo is drawn, both pictures are kept in the board's files and served from there, and the board names no address", async () => {
    const dataDir = scratch();
    const folder = join(scratch(), "work");
    mkdirSync(join(folder, "shots"), { recursive: true });
    writeFileSync(join(folder, "shots", "screen.png"), PNG);
    const w = web({ "https://example.com/avatar": () => new Response(SVG) });
    const written = drawing(
      '<svg viewBox="0 0 400 200"><svg data-logo="stripe" x="0" y="0" width="40" height="40"/>'
        + '<image href="shots/screen.png" x="60" y="0" width="100" height="80"/>'
        + '<image href="https://example.com/avatar" x="200" y="0" width="40" height="40"/></svg>',
    );
    const board = expandBoardStamps(written).board;
    const fetched = await fetchShapeWebPictures(board, { fetch: w.fetch });
    expect(fetched.errors).toEqual([]);
    const store = createShapeStore({ dataDir });
    const r = store.update({ board, project: { name: "p", root: folder }, sourceDir: folder, webPictures: fetched.pictures });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const html = store.read(r.id)!.views.picture!.html;
    expect(html).toMatch(/<svg data-brand[^>]*data-logo="stripe"[^>]*viewBox="0 0 24 24"><title>Stripe<\/title><path fill="#[0-9A-Fa-f]{6}" d="/);
    expect(html).not.toContain("https://");
    expect(html).not.toContain("shots/");
    const names = [...html.matchAll(/href="files\/([^"]+)"/g)].map((m) => m[1]!);
    expect(names).toEqual([expect.stringMatching(/^[0-9a-f]{10}-screen\.png$/), expect.stringMatching(/^[0-9a-f]{10}-avatar\.svg$/)]);
    const served = await Promise.all(
      names.map((name) => {
        const url = new URL(`/api/shapes/${r.id}/files/${encodeURIComponent(name)}`, "http://x");
        return handleShapeRoute({ method: "GET", pathname: url.pathname, params: url.searchParams, json: async () => null }, { store });
      }),
    );
    expect(served.map((s) => ("file" in s ? s.file.contentType : s.status))).toEqual(["image/png", "image/svg+xml"]);
    expect(readFileSync("file" in served[1]! ? served[1].file.path : "", "utf8")).toBe(SVG);
  });
});
