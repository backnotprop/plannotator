/**
 * The board style through the servers (approval "shape-board-style-switch"): Settings → Capabilities → Board
 * style writes config.json `shapeBoardStyle` through POST /api/inbox/settings `{ shape_style }`, every settings read
 * names it beside the Shape switch, and the Shapes server's `/api/shape-server` gives it to the standalone page.
 * (Pi mounts no Shape routes and has no Shapes server; packages/shared/shape/switch.ts is the one reader.)
 *
 * What regresses: a person who never chose being sent Rounded; a pick that is not kept or not read back; a value no
 * build knows saved; an Inbox with Shape off naming the style; the standalone page drawing another style than the
 * Inbox's.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "./inbox";
import { startShapeServer, type ShapeServer } from "./shape";

const roots: string[] = [];
const servers: { stop: () => void }[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

function dataDirWith(config: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-shape-style-server-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  return dataDir;
}

async function inbox(config: Record<string, unknown>) {
  const dataDir = dataDirWith(config);
  const server: InboxServer = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const read = async () => (await (await fetch(`${base}/api/inbox/settings?store=0`)).json()) as { shape?: { on: boolean }; shape_style?: unknown };
  const save = (body: Record<string, unknown>) =>
    fetch(`${base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
  const onDisk = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Record<string, unknown>;
  return { read, save, onDisk };
}

test("Shape on: Sharp until picked; a pick is kept in config.json and read back; anything else is refused", async () => {
  const { read, save, onDisk } = await inbox({ inboxShape: true });
  expect((await read()).shape_style).toBe("sharp");
  for (const bad of ["square", "Sharp", 1, null, { style: "rounded" }]) {
    const refused = await save({ shape_style: bad });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { code?: string }).code).toBe("validation_error");
  }
  expect(onDisk().shapeBoardStyle).toBeUndefined();

  const saved = await save({ shape_style: "rounded" });
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as { shape_style?: unknown }).shape_style).toBe("rounded");
  expect(onDisk().shapeBoardStyle).toBe("rounded");
  expect((await read()).shape_style).toBe("rounded");

  expect((await save({ shape_style: "sharp" })).status).toBe(200);
  expect(onDisk().shapeBoardStyle).toBe("sharp");
  expect((await read()).shape_style).toBe("sharp");
});

test("Shape off: a settings read names no style (as it names no Shape switch)", async () => {
  const { read } = await inbox({ shapeBoardStyle: "rounded" });
  const settings = await read();
  expect(settings.shape).toBeUndefined();
  expect(settings.shape_style).toBeUndefined();
});

test("the Shapes server tells the standalone page the person's style", async () => {
  for (const [config, style] of [[{ inboxShape: true }, "sharp"], [{ inboxShape: true, shapeBoardStyle: "rounded" }, "rounded"]] as const) {
    const dataDir = dataDirWith(config);
    const server: ShapeServer = await startShapeServer({ dataDir, page: () => "<!doctype html>", port: 0 });
    servers.push(server);
    const info = (await (await fetch(`http://127.0.0.1:${server.port}/api/shape-server`)).json()) as { board_style?: unknown };
    expect(info.board_style).toBe(style);
  }
});
