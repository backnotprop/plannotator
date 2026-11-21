/**
 * The Shapes server (shape.ts): Shape's page for people without the Inbox.
 *
 * What regresses:
 *  - it serves boards while the person never turned Shape on (config.json
 *    `inboxShape` unset or off): every `/api/shapes` path must answer 404;
 *  - another site reads a board (it names files and folders) or writes a note;
 *  - a DNS-rebinding page reaches it under another host name;
 *  - a page left open across a restart writes to the new server's boards
 *    (a foreign `serverSession` must answer 409; the page's own is accepted);
 *  - `server.json` names a stopped or dead server as running, or the next
 *    start forgets the last port, or annotate's
 *    live app probe does not know the port is Plannotator's;
 *  - it never exits once the last page closes (or exits with one open).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShapeStore } from "@plannotator/shared/shape/store";
import { listPlannotatorServerPorts } from "@plannotator/shared/plannotator-ports";
import { readShapeServerEntry, runningShapeServer, shapeServerPath, startShapeServer, type ShapeServer } from "./shape";

const roots: string[] = [];
const servers: ShapeServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const board = { title: "Kettle", claim: "Built.", views: { picture: { html: '<p data-mark="k">One whistle</p>' } } };

async function world(options: { config?: Record<string, unknown> | null; idleMs?: number; onIdle?: () => void; port?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-shape-server-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  if (options.config !== null) writeFileSync(join(dataDir, "config.json"), JSON.stringify(options.config ?? { inboxShape: true }));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const project = join(root, "app");
  mkdirSync(project, { recursive: true });
  const made = createShapeStore({ dataDir }).update({ board, project: { root: project, name: "app" }, session: { id: "ses_a", host: "claude-code" } });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const server = await startShapeServer({ dataDir, page: () => "<!doctype html><title>shape page</title>", version: "9.9.9", idleMs: options.idleMs, onIdle: options.onIdle, port: options.port, watchMs: 30 });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { root, dataDir, server, base, get, post, id: made.id };
}

// The binary embeds the page gzipped (13 MB → 3 MB). What regresses: a browser that takes gzip gets the bytes without
// `Content-Encoding: gzip` (a page of binary garbage), or one that does not gets gzip anyway.
test("a gzipped page: sent as it is to a browser that takes gzip, unzipped to one that does not", async () => {
  const { gzipSync, gunzipSync } = await import("node:zlib");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-shape-server-gz-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const html = "<!doctype html><title>shape page</title><p>Grid ✓</p>";
  const gz = gzipSync(html);
  const server = await startShapeServer({ dataDir, pageGzip: () => gz, shape: true, port: 0 });
  servers.push(server);
  const raw = (headers: Record<string, string>) =>
    new Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }>((done, fail) => {
      // node:http: no Accept-Encoding of its own and no automatic unzip, so the bytes are what was sent.
      const req = require("node:http").request({ host: "127.0.0.1", port: server.port, path: "/", headers }, (res: import("node:http").IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => done({ headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", fail);
      req.end();
    });
  const zipped = await raw({ "Accept-Encoding": "gzip, deflate, br" });
  expect(zipped.headers["content-encoding"]).toBe("gzip");
  expect(zipped.headers.vary).toBe("Accept-Encoding");
  expect(Buffer.compare(zipped.body, gz)).toBe(0);
  expect(gunzipSync(zipped.body).toString("utf8")).toBe(html);
  for (const accept of [{}, { "Accept-Encoding": "identity" }, { "Accept-Encoding": "br, gzip;q=0" }]) {
    const plain = await raw(accept);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body.toString("utf8")).toBe(html);
  }
});

async function eventsStatus(base: string): Promise<number> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/shapes/events`, { signal: controller.signal });
  controller.abort();
  return response.status;
}

test("Shape unset or off: the page loads, and every board path answers 404", async () => {
  for (const config of [null, { inboxShape: false }]) {
    const w = await world({ config });
    expect((await w.get("/")).status).toBe(200);
    const info = (await (await w.get("/api/shape-server")).json()) as { on: boolean; shape_server: number };
    expect(info).toMatchObject({ shape_server: 1, on: false });
    expect((await w.get("/api/shapes")).status).toBe(404);
    expect((await w.get(`/api/shapes/${w.id}`)).status).toBe(404);
    expect((await w.post(`/api/shapes/${w.id}/notes`, { kind: "change", v: 1, view: "picture", text: "Two" })).status).toBe(404);
    expect(await eventsStatus(w.base)).toBe(404);
    // Nothing was written while off.
    expect(createShapeStore({ dataDir: w.dataDir }).notes(w.id)).toHaveLength(0);
  }
});

test("on: the page reads the grid and a board, and a Change it waits for the agent", async () => {
  const w = await world();
  const page = await w.get("/");
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const list = (await (await w.get("/api/shapes?preview=1")).json()) as { shapes: { id: string; preview: unknown }[] };
  expect(list.shapes.map((s) => s.id)).toEqual([w.id]);
  expect(list.shapes[0]!.preview).toBeTruthy();
  const info = (await (await w.get("/api/shape-server")).json()) as { serverSession: string };
  const note = await w.post(`/api/shapes/${w.id}/notes`, { kind: "change", v: 1, view: "picture", part: "k", text: "Two whistles", serverSession: info.serverSession });
  expect(note.status).toBe(200);
  const waiting = createShapeStore({ dataDir: w.dataDir }).waiting(w.id);
  expect(waiting.map((n) => n.text)).toEqual(["Two whistles"]);
});

test("another site is refused, reads included; this page's own requests are not", async () => {
  const w = await world();
  const foreign = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" };
  expect((await w.get("/api/shapes", foreign)).status).toBe(403);
  expect((await w.get(`/api/shapes/${w.id}`, foreign)).status).toBe(403);
  expect((await w.get("/api/shape-server", foreign)).status).toBe(403);
  expect((await w.post(`/api/shapes/${w.id}/notes`, { kind: "change", v: 1, view: "picture", text: "x" }, foreign)).status).toBe(403);
  const own = { Origin: w.base, "Sec-Fetch-Site": "same-origin" };
  expect((await w.get("/api/shapes", own)).status).toBe(200);
  expect(createShapeStore({ dataDir: w.dataDir }).notes(w.id)).toHaveLength(0);
});

test("another host name (a DNS-rebinding page) is refused before any route", async () => {
  const w = await world();
  const response = await fetch(`${w.base}/api/shapes`, { headers: { Host: "attacker.example" } });
  expect(response.status).toBe(403);
});

test("a write from a page of another server (a stale serverSession) answers 409 and saves nothing", async () => {
  const w = await world();
  const stale = await w.post(`/api/shapes/${w.id}/notes`, { kind: "change", v: 1, view: "picture", text: "x", serverSession: "0".repeat(32) });
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { code: string }).code).toBe("session_mismatch");
  expect((await w.post(`/api/shapes/${w.id}/seen`, { n: 1, serverSession: "0".repeat(32) })).status).toBe(409);
  expect(createShapeStore({ dataDir: w.dataDir }).notes(w.id)).toHaveLength(0);
});

test("server.json names the running server; a stopped or dead one is not running, and the next start takes its port", async () => {
  const w = await world();
  const entry = readShapeServerEntry(w.dataDir);
  expect(entry).toMatchObject({ v: 1, pid: process.pid, port: w.server.port, version: "9.9.9" });
  expect((await runningShapeServer(w.dataDir))?.port).toBe(w.server.port);
  // Annotate's live app probe never proxies a Plannotator server: this one is on its list.
  expect(listPlannotatorServerPorts(w.dataDir)).toContain(w.server.port);
  const port = w.server.port;
  w.server.stop();
  servers.splice(servers.indexOf(w.server), 1);
  // Kept with no process: nothing reads it as running, and the next start takes the same port.
  expect(readShapeServerEntry(w.dataDir)).toMatchObject({ pid: 0, port });
  expect(await runningShapeServer(w.dataDir)).toBeNull();
  expect(listPlannotatorServerPorts(w.dataDir)).not.toContain(port);
  let again = await startShapeServer({ dataDir: w.dataDir, version: "9.9.9" });
  servers.push(again);
  expect(again.port).toBe(port);
  again.stop();
  // An entry whose process died without stopping (a crash): the same.
  writeFileSync(shapeServerPath(w.dataDir), JSON.stringify({ v: 1, pid: 2 ** 22 + 12345, port, url: `http://127.0.0.1:${port}`, version: "old", started: "" }));
  expect(await runningShapeServer(w.dataDir)).toBeNull();
  again = await startShapeServer({ dataDir: w.dataDir, version: "9.9.9" });
  servers.push(again);
  expect(again.port).toBe(port);
  expect(readShapeServerEntry(w.dataDir)?.pid).toBe(process.pid);
});

test("idle: it waits while a page is open, and calls onIdle once the last page closed", async () => {
  let idled = 0;
  const w = await world({ idleMs: 150, onIdle: () => idled++ });
  const controller = new AbortController();
  const stream = await fetch(`${w.base}/api/shapes/events`, { signal: controller.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  await reader.read(); // the hello frame: the page is open
  expect(w.server.pages()).toBe(1);
  await Bun.sleep(300);
  expect(idled).toBe(0);
  controller.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 40 && w.server.pages() > 0; i++) await Bun.sleep(25);
  expect(w.server.pages()).toBe(0);
  await Bun.sleep(300);
  expect(idled).toBe(1);
});
