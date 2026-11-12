/**
 * A project's letter-mark picture through the Inbox's real door: `GET` and `POST /api/inbox/projects/:id/picture`
 * on a running Inbox (temp data dir and HOME, loopback, a scripted GitHub and tailscale: nothing real is asked).
 * What can regress: the switches taken from the request instead of config.json (a page turning GitHub on by
 * itself; only the repo's logo, a local file, may be asked for with `logo=1`, for the list dialog's Detailed card), an SVG served without its sandbox headers, the 404 the window draws letters on, a tailnet guest
 * reading or setting a picture, and a refusal that is not one of the approved words (a phone photo's data URL
 * once got a developer's sentence in the toast).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { startInboxServer, type InboxServer } from "./inbox";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const GITHUB_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const ICO = new Uint8Array([0, 0, 1, 0, ...new Array(30).fill(7)]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
const dataUrl = (bytes: Uint8Array, type: string) => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_BROWSER", "HOME"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];
const servers: InboxServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** A scripted tailscale that publishes the Inbox (as inbox-card-marks.test.ts): no real tailscale runs. */
function scriptedTailscale(magic: string, owner: string): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${magic}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: owner } } }));
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      return ok(
        JSON.stringify({
          TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
          Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${magic}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
        }),
      );
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok(`https://${magic}:${httpsPort}/\n`);
  };
}

/** A running Inbox with one project on github.com whose folder has a favicon.svg; config.json as given. */
async function world(config: Record<string, unknown>, tailscale?: { magic: string; owner: string }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-picture-route-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "web");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "favicon.svg"), SVG);
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.HOME = home;
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
  const writeConfig = (next: Record<string, unknown>) => writeFileSync(join(dataDir, "config.json"), JSON.stringify(next));
  writeConfig(config);
  const github: string[] = [];
  const server = await startInboxServer({
    dataDir,
    binaryPath: null,
    phones: false,
    readProjectRepo: async () => ({ display: "acme/web", host: "github.com" }),
    projectPictures: {
      fetch: async (url) => {
        github.push(url);
        return new Response(GITHUB_PNG, { status: 200, headers: { "content-type": "image/png" } });
      },
    },
    ...(tailscale ? { tailscale: scriptedTailscale(tailscale.magic, tailscale.owner) } : {}),
  });
  servers.push(server);
  const project = server.store.ensureProject({ name: "web", root: folder });
  const base = `http://127.0.0.1:${server.port}`;
  const path = `/api/inbox/projects/${project.id}/picture`;
  // The window's own cache key asks for everything: the answer must still follow config.json.
  const get = (headers: Record<string, string> = {}, query = "v=0-11") => fetch(`${base}${path}?${query}`, { headers });
  const post = (picture: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ picture }) });
  return { server, project, path, get, post, github, writeConfig };
}

const errorOf = async (response: Response) => (await response.json()) as { error: string; code: string };

describe("GET /api/inbox/projects/:id/picture", () => {
  test("the switches come from config.json, never the request; the 404 the window draws letters on; an SVG sandboxed", async () => {
    const w = await world({ inboxRows: ["marksProjects"], inboxRowsDefaults: 99 });
    const none = await w.get();
    expect(none.status).toBe(404);
    expect((await errorOf(none)).code).toBe("no_picture");
    expect(w.github).toEqual([]);

    // The list dialog's Detailed card asks for the repo's logo before the look is saved: served, from the folder;
    // the request still never turns GitHub on.
    const asked = await w.get({}, "v=0-11&logo=1&github=1&githubPictures=1");
    expect(asked.status).toBe(200);
    expect(await asked.text()).toBe(SVG);
    expect(w.github).toEqual([]);

    w.writeConfig({ inboxRows: ["marksProjects", "repoLogo"], inboxRowsDefaults: 99 });
    const logo = await w.get();
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(logo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(logo.headers.get("content-security-policy")).toContain("sandbox");
    expect(logo.headers.get("content-disposition")).toBe("attachment");
    expect(logo.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(await logo.text()).toBe(SVG);
    expect(w.github).toEqual([]);

    w.writeConfig({ inboxRows: ["marksProjects", "githubPictures"], inboxRowsDefaults: 99 });
    const owner = await w.get();
    expect(owner.status).toBe(200);
    expect(owner.headers.get("content-type")).toBe("image/png");
    expect(owner.headers.get("content-disposition")).toBeNull();
    expect(new Uint8Array(await owner.arrayBuffer())).toEqual(GITHUB_PNG);
    expect(w.github).toHaveLength(1);
    expect(new URL(w.github[0]!).host).toBe("avatars.githubusercontent.com");
  });

  test("another site is refused", async () => {
    const w = await world({ inboxRows: ["marksProjects", "repoLogo"], inboxRowsDefaults: 99 });
    expect((await w.get({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await w.get({ Origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("POST /api/inbox/projects/:id/picture", () => {
  test("Set picture… wins over the switches, Remove picture takes it away; refusals are only the approved words", async () => {
    const w = await world({ inboxRows: ["marksProjects"], inboxRowsDefaults: 99 });
    const set = await w.post(dataUrl(PNG, "image/png"));
    expect(set.status).toBe(200);
    expect(typeof ((await set.json()) as { project: { picture?: number } }).project.picture).toBe("number");
    const shown = await w.get();
    expect(shown.status).toBe(200);
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(PNG);

    // A phone photo: a data URL far past the limit gets the size words, not a sentence about data URLs.
    const photo = await w.post(`data:image/jpeg;base64,${"A".repeat(900_000)}`);
    expect(photo.status).toBe(422);
    expect((await errorOf(photo)).error).toBe("Picture: at most 512 KB.");
    const justOver = await w.post(dataUrl(new Uint8Array(512 * 1024 + 1).fill(0x89), "image/png"));
    expect((await errorOf(justOver)).error).toBe("Picture: at most 512 KB.");
    for (const bad of ["hello", dataUrl(new TextEncoder().encode("<html></html>"), "image/png"), dataUrl(ICO, "image/x-icon"), 42]) {
      const refused = await w.post(bad);
      expect(refused.status).toBe(422);
      expect((await errorOf(refused)).error).toBe("Picture: a PNG, JPEG, GIF, WebP or SVG image.");
    }
    // Nothing refused changed the picture.
    expect(new Uint8Array(await (await w.get()).arrayBuffer())).toEqual(PNG);

    const removed = await w.post(null);
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { project: { picture?: number } }).project.picture).toBeUndefined();
    expect((await w.get()).status).toBe(404);
  });

  test("another site and another session's tab are refused, and nothing is set", async () => {
    const w = await world({ inboxRows: ["marksProjects"], inboxRowsDefaults: 99 });
    expect((await w.post(dataUrl(PNG, "image/png"), { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await w.post(dataUrl(PNG, "image/png"), { Origin: "https://evil.example" })).status).toBe(403);
    const stale = await fetch(`http://127.0.0.1:${w.server.port}${w.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ picture: dataUrl(PNG, "image/png"), serverSession: "not-this-one" }),
    });
    expect(stale.status).toBe(409);
    expect((await w.get()).status).toBe(404);
  });
});

describe("over the tailnet", () => {
  test("a guest the owner allowed reads and sets a picture as the owner does (owner ruling 2026-11-11: a picture is a logo)", async () => {
    const MAGIC = "macbook-pro.tail0000.ts.net";
    const OWNER = "ramos@example.com";
    const GUEST = "guest@example.com";
    const w = await world({ inboxTailscale: true, inboxTailscaleAllow: [GUEST], inboxRows: ["marksProjects", "repoLogo"], inboxRowsDefaults: 99 }, { magic: MAGIC, owner: OWNER });
    const listener = w.server.tailscale.listenerPort();
    expect(listener).not.toBeNull();
    const headers = (login: string) => ({ Host: `${MAGIC}:${w.server.port}`, "Tailscale-User-Login": login, Origin: `https://${MAGIC}:${w.server.port}`, "Content-Type": "application/json" });
    const at = `http://127.0.0.1:${listener}${w.path}`;

    const read = await fetch(at, { headers: headers(GUEST) });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/svg+xml");
    const write = await fetch(at, { method: "POST", headers: headers(GUEST), body: JSON.stringify({ serverSession: w.server.serverSession, picture: dataUrl(PNG, "image/png") }) });
    expect(write.status).toBe(200);
    expect((await w.get()).headers.get("content-type")).toBe("image/png");

    const owner = await fetch(at, { headers: headers(OWNER) });
    expect(owner.status).toBe(200);
    expect(owner.headers.get("content-type")).toBe("image/png");
  });
});
