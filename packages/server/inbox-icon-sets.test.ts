/**
 * Icon sets for agents' icons ("Sets" in the face picker): the `set:<set>/<icon>` face, the built-in sets embedded
 * from packages/inbox/assets/icon-sets, and a fetchable set downloaded on one click (inbox-icon-set-fetch.ts) from a
 * local fake server (tests/helpers/fake-icon-set.ts: generated pictures, 127.0.0.1 only). Temp data dirs only.
 *
 * What this catches: a `set:` face an older Plannotator cannot skip, or the faces file's version bumped; a built-in
 * icon outside its archive, of another type, or a set whose look (pixel size, one colour) the window would draw wrong;
 * game-icons.net's credit missing or changed; an icon served without the sandbox headers; the pointer read without
 * the picker asking (or at all when it is off); a download that does not finish in one click, does not resume after a
 * stop, needs the network once done, keeps a file that is not a picture or is too big, or follows a redirect to a
 * private address.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_AGENT_ICONS_KEPT, INBOX_OWN_FACE, isInboxAgentFace, readInboxAgentFaces, type InboxIconSet, type InboxIconSetListing } from "@plannotator/core/inbox-types";
import { createInboxAgentFacesFile, INBOX_AGENT_FACES_FILE } from "@plannotator/shared/inbox/agent-faces";
import { sniffImageContentType } from "@plannotator/shared/review-image";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { creature, serveFakeIconSet, type FakeIconSet } from "../../tests/helpers/fake-icon-set";
import { deflateSync } from "node:zlib";
import { decodePng, encodePng, trimPng } from "./inbox-icon-trim";
import { startInboxServer, type InboxServer } from "./inbox";
import { createBuiltInIconSets } from "./inbox-icon-sets";
import { carefulGet, createIconSetFetcher, iconSetsPointer, INBOX_ICON_SETS_POINTER_DEFAULT, isPrivateAddress } from "./inbox-icon-set-fetch";

const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_BROWSER", "PLANNOTATOR_ICON_SETS_URL", "HOME"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];
const servers: InboxServer[] = [];
const fakes: FakeIconSet[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  for (const fake of fakes.splice(0)) await fake.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const scratch = (prefix: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
};
const fake = async (options: Parameters<typeof serveFakeIconSet>[0] = {}) => {
  const served = await serveFakeIconSet(options);
  fakes.push(served);
  return served;
};
const BUILT_IN = new Set(["tiny-creatures", "game-icons", "dcss"]);
const fetcherAt = (dir: string, pointer: string | null, extra: Partial<Parameters<typeof createIconSetFetcher>[0]> = {}) => createIconSetFetcher({ dir, pointer, builtIn: BUILT_IN, ...extra });

describe("the set: face", () => {
  test("round-trips at v: 1; a released reader and the upload build's reader skip it and keep the rest", () => {
    const dir = join(scratch("pn-icon-set-faces-"), "inbox");
    const faces = createInboxAgentFacesFile(dir, () => {});
    faces.change({ agent: "ses_set", face: "set:tiny-creatures/zombie" });
    faces.change({ agent: "ses_fetched", face: "set:blobs/25" });
    faces.change({ agent: "ses_own", face: `own:${"b".repeat(64)}` });
    faces.change({ agent: "ses_glass", face: "glass-blue" });
    const raw = JSON.parse(readFileSync(join(dir, INBOX_AGENT_FACES_FILE), "utf8"));
    expect(raw.v).toBe(1);
    const again = createInboxAgentFacesFile(dir, () => {}).wire().faces;
    expect(again.ses_set).toEqual({ face: "set:tiny-creatures/zombie", sessions: [] });
    expect(again.ses_fetched).toEqual({ face: "set:blobs/25", sessions: [] });
    // Not a set icon's id: refused like any unknown face (no path, no capitals, no empty parts).
    for (const bad of ["set:", "set:dcss", "set:dcss/", "set:/x", "set:../x/y", "set:dcss/../../x", "set:DCSS/orc", "set:dcss/orc/extra", `set:${"a".repeat(41)}/x`]) expect(isInboxAgentFace(bad)).toBe(false);
    expect(readInboxAgentFaces({ x: { face: "set:dcss/a b", sessions: [] } })).toEqual({});

    // 0.28.60's reader, as released: a closed list, entries it does not know dropped one by one.
    const RELEASED = ["agent", "glass", "glass-red", "glass-orange", "yellow", "glass-green", "glass-teal", "glass-blue", "glass-purple", "glass-pink", "glass-ice", "transparent", "totman"];
    // The upload build's reader (feat/inbox-own-agent-icon): the same list plus `own:<hash>`.
    const readers = [(face: string) => RELEASED.includes(face), (face: string) => RELEASED.includes(face) || INBOX_OWN_FACE.test(face)];
    for (const knows of readers) {
      if (typeof raw.v === "number" && raw.v > 1) throw new Error("an older reader would refuse the whole file");
      const out = Object.fromEntries(Object.entries(raw.faces as Record<string, { face: string }>).filter(([, entry]) => knows(entry.face) && entry.face !== "agent"));
      expect(Object.keys(out).sort()).toEqual(knows(`own:${"b".repeat(64)}`) ? ["ses_glass", "ses_own"] : ["ses_glass"]);
    }
  });

  test("set icons never count against the uploads' cap: the faces file keeps them however many there are", () => {
    const dir = join(scratch("pn-icon-set-cap-"), "inbox");
    const faces = createInboxAgentFacesFile(dir, () => {});
    for (let i = 0; i < INBOX_AGENT_ICONS_KEPT + 5; i++) faces.change({ agent: `ses_${i}`, face: `set:dcss/icon-${i}` });
    expect(Object.keys(faces.wire().faces)).toHaveLength(INBOX_AGENT_ICONS_KEPT + 5);
    // No uploads folder appears: a set icon is not a copy.
    expect(existsSync(join(dir, "agent-icons"))).toBe(false);
  });
});

describe("the built-in sets", () => {
  test("every icon is in its archive, one type per set, numbered 1..count; the looks the window draws", async () => {
    const sets = createBuiltInIconSets();
    const list = await sets.list();
    expect(list.map((set) => set.id)).toEqual(["tiny-creatures", "game-icons", "dcss", "noto-3d"]);
    const looks = Object.fromEntries(list.map((set) => [set.id, { pixelated: !!set.pixelated, size: set.size ?? null, mono: !!set.mono, count: set.count }]));
    expect(looks).toEqual({
      "tiny-creatures": { pixelated: true, size: 16, mono: false, count: 170 },
      "game-icons": { pixelated: false, size: null, mono: true, count: 334 },
      dcss: { pixelated: true, size: 32, mono: false, count: 419 },
      "noto-3d": { pixelated: false, size: 80, mono: false, count: 149 },
    });
    for (const set of list) {
      const listing = (await sets.listing(set.id))!;
      expect(listing.icons.map((icon) => icon.n)).toEqual(Array.from({ length: set.count }, (_, i) => i + 1));
      expect(new Set(listing.icons.map((icon) => icon.id)).size).toBe(set.count);
      for (const icon of listing.icons) {
        expect(isInboxAgentFace(`set:${set.id}/${icon.id}`)).toBe(true);
        const read = (await sets.read(set.id, icon.id))!;
        expect(sniffImageContentType(new Uint8Array(read.body))).toBe(read.type);
      }
      // The window never gets the archive's offsets.
      expect(JSON.stringify(listing)).not.toContain('"at"');
    }
    expect(await sets.read("dcss", "no-such-icon")).toBeNull();
    expect(await sets.read("no-such-set", "orc")).toBeNull();
  });

  test("game-icons.net carries its CC BY 3.0 credit, in the set, its credits file and the NOTICE", async () => {
    const CREDIT = "Icons made by Delapouite, Lorc, Caro Asercion, Skoll, Cathelineau, Carl Olsen, DarkZaitzev, Faithtoken, Sparker. Available on https://game-icons.net. Licensed under CC BY 3.0.";
    const sets = createBuiltInIconSets();
    const game = (await sets.list()).find((set) => set.id === "game-icons")!;
    expect(game).toMatchObject({ credit: CREDIT, credits: true, licence: "CC-BY-3.0" });
    expect(await sets.credits("game-icons")).toContain(CREDIT);
    const notice = readFileSync(join(import.meta.dir, "../inbox/assets/icon-sets/NOTICE"), "utf8").replace(/\s+/g, " ");
    expect(notice).toContain(CREDIT.replace("Licensed under CC BY 3.0.", "Licensed under CC BY 3.0"));
    expect(notice).toContain("CC0");
  });
});

async function inboxWorld(pointer: string | null) {
  const root = scratch("plannotator-inbox-icon-sets-");
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.HOME = home;
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  process.env.PLANNOTATOR_ICON_SETS_URL = pointer ?? "off";
  delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
  writeFileSync(join(dataDir, "config.json"), "{}");
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const list = async (remote = false) => ((await (await fetch(`${base}/api/inbox/icon-sets${remote ? "?remote=1" : ""}`)).json()) as { sets: InboxIconSet[] }).sets;
  return { dataDir, base, list };
}

describe("the routes, through a running Inbox", () => {
  test("built-in icons are served sandboxed; the pointer is read only when the picker's Sets asks; one click gets a set", async () => {
    const served = await fake({ count: 12 });
    const w = await inboxWorld(served.pointer);
    // Started, and the built-in sets listed: nothing asked of the network.
    expect((await w.list()).map((set) => set.id)).toEqual(["tiny-creatures", "game-icons", "dcss", "noto-3d"]);
    expect(served.total()).toBe(0);

    const icon = await fetch(`${w.base}/api/inbox/icon-sets/game-icons/air-man`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
    expect(icon.headers.get("content-security-policy")).toContain("sandbox");
    expect(icon.headers.get("content-disposition")).toBe("attachment");
    expect(icon.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect((await fetch(`${w.base}/api/inbox/icon-sets/tiny-creatures/zombie`)).headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${w.base}/api/inbox/icon-sets/dcss/no-such`)).status).toBe(404);
    expect((await fetch(`${w.base}/api/inbox/icon-sets/dcss/orc/..`)).status).toBe(404);
    expect((await fetch(`${w.base}/api/inbox/icon-sets/dcss/orc`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    const credits = await fetch(`${w.base}/api/inbox/icon-sets/game-icons?credits=1`);
    expect(credits.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(credits.headers.get("content-security-policy")).toContain("sandbox");
    expect(await credits.text()).toContain("Icons made by Delapouite");
    expect(served.total()).toBe(0);

    // The picker's Sets: the pointer once, the set offered, nothing downloaded.
    const offered = (await w.list(true)).find((set) => set.id === "blobs");
    expect(offered).toMatchObject({ name: "Blobs", count: 12, kind: "fetchable", get: { state: "none", have: 0 } });
    expect(served.total()).toBe(1);
    await w.list(true);
    expect(served.total()).toBe(1);

    // One click.
    const got = await fetch(`${w.base}/api/inbox/icon-sets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ get: "blobs" }) });
    expect(got.status).toBe(200);
    for (let i = 0; i < 100; i++) {
      if ((await w.list()).find((set) => set.id === "blobs")?.get?.state === "done") break;
      await Bun.sleep(30);
    }
    const listing = (await (await fetch(`${w.base}/api/inbox/icon-sets/blobs`)).json()) as InboxIconSetListing;
    expect(listing).toMatchObject({ kind: "fetchable", count: 12, pixelated: true, size: 16, get: { state: "done", have: 12 } });
    expect(listing.icons.slice(0, 2)).toEqual([
      { id: "1", n: 1, name: "Mossy" },
      { id: "2", n: 2, name: "Mote" },
    ]);
    const fetched = await fetch(`${w.base}/api/inbox/icon-sets/blobs/2`);
    expect(fetched.headers.get("content-type")).toBe("image/png");
    expect(fetched.headers.get("content-security-policy")).toContain("sandbox");
    // Kept in this Inbox's data folder.
    expect(readdirSync(join(w.dataDir, "inbox", "icon-sets", "blobs")).filter((name) => name.endsWith(".png"))).toHaveLength(12);
    // A face for it round-trips like any other.
    const saved = await fetch(`${w.base}/api/inbox/agent-faces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: "ses_x", face: "set:blobs/2" }) });
    expect(((await saved.json()) as { faces: Record<string, { face: string }> }).faces.ses_x!.face).toBe("set:blobs/2");
    // Another site cannot start a download.
    expect((await fetch(`${w.base}/api/inbox/icon-sets`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ get: "blobs" }) })).status).toBe(403);
  });

  test("with the pointer off, the picker's Sets makes no request at all", async () => {
    const served = await fake();
    const w = await inboxWorld(null);
    expect((await w.list(true)).map((set) => set.kind)).toEqual(["built-in", "built-in", "built-in", "built-in"]);
    expect((await fetch(`${w.base}/api/inbox/icon-sets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ get: "blobs" }) })).status).toBe(404);
    expect(served.total()).toBe(0);
  });
});

describe("a fetchable set", () => {
  test("the pointer: the default address, or none when set off; never read without the picker asking", async () => {
    expect(iconSetsPointer({})).toBe(INBOX_ICON_SETS_POINTER_DEFAULT);
    expect(iconSetsPointer({ PLANNOTATOR_ICON_SETS_URL: "" })).toBeNull();
    expect(iconSetsPointer({ PLANNOTATOR_ICON_SETS_URL: "off" })).toBeNull();
    expect(iconSetsPointer({ PLANNOTATOR_ICON_SETS_URL: "http://127.0.0.1:1/x.json" })).toBe("http://127.0.0.1:1/x.json");
    let asked = 0;
    const counting = (async () => {
      asked++;
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const dir = join(scratch("pn-icon-set-pointer-"), "icon-sets");
    // The default pointer (which does not exist yet): listing, getting and resuming without the picker ask nothing.
    const quiet = fetcherAt(dir, INBOX_ICON_SETS_POINTER_DEFAULT, { fetch: counting, classify: async () => "public" });
    quiet.resume();
    expect(await quiet.list(false)).toEqual([]);
    expect(asked).toBe(0);
    // The picker asks: one read, a missing pointer offers nothing, and is not asked again at once.
    expect(await quiet.list(true)).toEqual([]);
    expect(await quiet.list(true)).toEqual([]);
    expect(asked).toBe(1);
    // Off: nothing, ever.
    const off = fetcherAt(dir, null, { fetch: counting });
    expect(await off.list(true)).toEqual([]);
    expect(await off.get("blobs")).toBeNull();
    expect(asked).toBe(1);
  });

  test("a stopped download resumes where it stopped, then works with the network gone", async () => {
    const served = await fake({ count: 20, failFrom: 11 });
    const dir = join(scratch("pn-icon-set-resume-"), "icon-sets");
    const first = fetcherAt(dir, served.pointer);
    await first.list(true);
    expect((await first.get("blobs"))!.get!.state).toBe("getting");
    await first.running("blobs");
    expect((await first.list(false))[0]!.get).toEqual({ state: "failed", have: 10 });
    expect(first.listing("blobs")!.have).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));

    // The Inbox starts again (a new fetcher on the same folder) and the server is back: the stopped set goes on alone,
    // asking only for the icons it lacks.
    served.heal();
    const before = new Map(served.hits);
    const second = fetcherAt(dir, served.pointer);
    second.resume();
    await second.running("blobs");
    expect((await second.list(false))[0]!.get).toEqual({ state: "done", have: 20 });
    for (let n = 1; n <= 10; n++) expect(served.hits.get(`/icons/${n}.png`)).toBe(before.get(`/icons/${n}.png`));
    expect(served.hits.get("/blobs.json")).toBe(1);
    expect(existsSync(join(dir, "blobs", ".getting"))).toBe(false);

    // Offline: the server gone, a new start. Listed (the pointer cannot be read), every icon served from the folder.
    await served.stop();
    fakes.splice(fakes.indexOf(served), 1);
    const offline = fetcherAt(dir, served.pointer);
    const listed = await offline.list(true);
    expect(listed.map((set) => [set.id, set.get])).toEqual([["blobs", { state: "done", have: 20 }]]);
    for (let n = 1; n <= 20; n++) expect(sniffImageContentType(offline.read("blobs", String(n))!.body)).toBe("image/png");
  });

  test("a file that is not a picture, or is too big, is refused and never kept; the rest are", async () => {
    const served = await fake({ count: 8, notImage: [3], huge: [5] });
    const dir = join(scratch("pn-icon-set-refuse-"), "icon-sets");
    const fetcher = fetcherAt(dir, served.pointer);
    await fetcher.list(true);
    await fetcher.get("blobs");
    await fetcher.running("blobs");
    expect((await fetcher.list(false))[0]!.get).toEqual({ state: "failed", have: 6 });
    const files = readdirSync(join(dir, "blobs"));
    expect(files.some((name) => name.startsWith("3.") || name.startsWith("5."))).toBe(false);
    expect(fetcher.read("blobs", "3")).toBeNull();
    // A file planted in the folder that is not a picture is not served either.
    writeFileSync(join(dir, "blobs", "7.png"), "<html></html>");
    expect(fetcher.read("blobs", "7")).toBeNull();
  });

  test("no redirect or link to a private address from a public pointer; http(s) only", async () => {
    const served = await fake({ count: 4, redirect: { 2: "http://localhost:9/secret.png" } });
    // The fake server's own address plays the public internet here; `localhost` is private.
    const classify = async (host: string) => (host === "127.0.0.1" ? "public" : "private") as "public" | "private";
    const dir = join(scratch("pn-icon-set-private-"), "icon-sets");
    const fetcher = fetcherAt(dir, served.pointer, { classify });
    await fetcher.list(true);
    await fetcher.get("blobs");
    await fetcher.running("blobs");
    expect((await fetcher.list(false))[0]!.get).toEqual({ state: "failed", have: 3 });
    expect(fetcher.read("blobs", "2")).toBeNull();

    const policy = { fetch, classify, allowPrivate: false };
    expect(await carefulGet("http://localhost:9/x.png", 1024, policy)).toEqual({ ok: false, reason: "private" });
    for (const bad of ["file:///etc/passwd", "data:image/png;base64,AAAA", "ftp://example.com/x.png", "http://user:pw@127.0.0.1/x"]) expect(await carefulGet(bad, 1024, policy)).toEqual({ ok: false, reason: "bad_url" });
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.1", "169.254.169.254", "100.100.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("trimming a fetched set's PNGs", () => {
  /** A palette PNG (colour type 3, 8 bits, a tRNS clear index 0) of `size` px with a w × h block at (x, y). */
  function palettePng(size: number, x0: number, y0: number, w: number, h: number): Uint8Array {
    const rgba = new Uint8Array(size * size * 4);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) rgba.set([200, 40, 40, 255], (y * size + x) * 4);
    const rgbaPng = encodePng(size, size, rgba);
    // Rewrite as a palette PNG: index 1 for the block, 0 (clear) elsewhere.
    const raw = new Uint8Array(size * (size + 1));
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) raw[y * (size + 1) + 1 + x] = 1;
    const chunk = (name: string, body: Uint8Array) => {
      const out = new Uint8Array(12 + body.length);
      const view = new DataView(out.buffer);
      view.setUint32(0, body.length);
      out.set(new TextEncoder().encode(name), 4);
      out.set(body, 8);
      let c = 0xffffffff;
      for (const b of out.subarray(4, 8 + body.length)) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      view.setUint32(8 + body.length, (c ^ 0xffffffff) >>> 0);
      return out;
    };
    const head = rgbaPng.slice(16, 29);
    head[9] = 3;
    const parts = [rgbaPng.slice(0, 8), chunk("IHDR", head), chunk("PLTE", new Uint8Array([0, 0, 0, 200, 40, 40])), chunk("tRNS", new Uint8Array([0])), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
    return new Uint8Array(Buffer.concat(parts));
  }

  test("a sprite small in a large clear square comes out trimmed to its picture, centred in a square", () => {
    for (const bytes of [palettePng(96, 30, 40, 24, 36), creature(5)]) {
      const before = decodePng(bytes)!;
      const trimmed = trimPng(bytes);
      if (before.width === 16) {
        // The generated creature nearly fills its 16 px: nothing worth trimming, kept as it came.
        expect(trimmed === null || decodePng(trimmed)!.width <= 16).toBe(true);
        continue;
      }
      const after = decodePng(trimmed!)!;
      expect([after.width, after.height]).toEqual([38, 38]);
      // The block's pixels, all of them, in the middle; the corners clear.
      const opaque = [...Array(after.width * after.height).keys()].filter((i) => after.rgba[i * 4 + 3]! > 0).length;
      expect(opaque).toBe(24 * 36);
      expect(after.rgba[3]).toBe(0);
    }
    // Not a PNG, or nothing to trim: kept as it came.
    expect(trimPng(new TextEncoder().encode("<html></html>"))).toBeNull();
    expect(trimPng(encodePng(8, 8, new Uint8Array(8 * 8 * 4).fill(255)))).toBeNull();
  });
});
