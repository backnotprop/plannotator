/**
 * `plannotator shape open [<shp_id>]`: the Shape page for people without the
 * Plannotator Inbox (SPEC.md §4, "CLI"). It reuses the Shapes server that
 * `shapes/server.json` names, or starts one detached (`plannotator shape
 * serve`, internal), then opens the page: the grid of boards, or one board.
 *
 * Like every `plannotator shape …`, it runs only while Shape is on (index.ts
 * prints the one `shape_off` line otherwise).
 *
 * `shape serve` (internal, not in the help): runs the Shapes server in this
 * process until no page has been open for 30 minutes. A second one exits at
 * once when one already runs.
 */
import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { isShapeId } from "@plannotator/shared/shape/format";
import { createShapeStore, shapesDirOf } from "@plannotator/shared/shape/store";
import { runningShapeServer, shapeServerOpenPages, startShapeServer, type ShapeServerEntry } from "@plannotator/server/shape";

const START_TIMEOUT_MS = 10_000;
const START_LOCK = "server.start.lock";
const START_LOCK_STALE_MS = 15_000;
export const SHAPE_SERVER_LOG = "server.log";

export interface ShapeOpenDeps {
  dataDir: string;
  /** Opens the URL in the person's browser; `remote` when nothing could open it here. */
  openUrl: (url: string) => Promise<"opened" | "none" | "remote" | "failed">;
  /** Starts `plannotator shape serve` detached (tests pass a stand-in). */
  spawnServer?: (dataDir: string) => void;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** How long to wait for a started server (tests shorten it). */
  startTimeoutMs?: number;
  /**
   * Bare `plannotator shape`: when a Shape page is already open on the running server, print the address and open
   * no second tab (the open page shows each new version by itself). `shape open` always opens one: an agent runs it
   * on purpose. When the count cannot be read (an older server, no answer in time), a page is opened.
   */
  reuseOpenPage?: boolean;
}

/** `shape open` arguments: one board id at most, and `--json`. */
export function parseShapeOpen(argv: readonly string[]): { ok: true; id: string | null; json: boolean } | { ok: false; error: string } {
  let id: string | null = null;
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--")) return { ok: false, error: `shape open does not take ${arg}.` };
    else if (id) return { ok: false, error: "shape open takes one shape id at most." };
    else id = arg;
  }
  return { ok: true, id, json };
}

/** The page's address: the grid, or one board (`#shape=<id>`). */
export function shapePageUrl(base: string, id: string | null): string {
  return id ? `${base}/#shape=${encodeURIComponent(id)}` : `${base}/`;
}

function takeStartLock(dataDir: string): (() => void) | null {
  const dir = shapesDirOf(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, START_LOCK);
  const take = () => {
    closeSync(openSync(path, "wx", 0o600));
    return () => rmSync(path, { force: true });
  };
  try {
    return take();
  } catch {
    try {
      // A starter that died holding it: break it once it is old.
      if (Date.now() - statSync(path).mtimeMs > START_LOCK_STALE_MS) {
        rmSync(path, { force: true });
        return take();
      }
    } catch {
      // gone meanwhile, or taken again
    }
    return null;
  }
}

function defaultSpawn(dataDir: string): void {
  const dir = shapesDirOf(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dir, SHAPE_SERVER_LOG), "a", 0o600);
  const script = process.argv[1];
  const self = script && /\.(?:[cm]?[jt]s)$/.test(script) ? [process.execPath, script] : [process.execPath];
  const child = spawn(self[0]!, [...self.slice(1), "shape", "serve"], {
    detached: true,
    // Never the caller's folder: a long-lived process would hold the agent's project as its working directory.
    cwd: dir,
    windowsHide: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, PLANNOTATOR_DATA_DIR: dataDir },
  });
  child.unref();
  closeSync(log);
}

/** The running Shapes server, starting one detached when none runs. Throws when it cannot start. */
export async function ensureShapeServer(deps: Pick<ShapeOpenDeps, "dataDir" | "spawnServer" | "startTimeoutMs">): Promise<ShapeServerEntry> {
  const running = await runningShapeServer(deps.dataDir);
  if (running) return running;
  const release = takeStartLock(deps.dataDir);
  try {
    if (release) (deps.spawnServer ?? defaultSpawn)(deps.dataDir);
    const until = Date.now() + (deps.startTimeoutMs ?? START_TIMEOUT_MS);
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      const started = await runningShapeServer(deps.dataDir, 1000);
      if (started) return started;
    }
  } finally {
    release?.();
  }
  throw new Error(`The Shape page's server did not start; see ${join(shapesDirOf(deps.dataDir), SHAPE_SERVER_LOG)}.`);
}

/** `plannotator shape open [<shp_id>] [--json]`; the exit code. */
export async function runShapeOpen(argv: readonly string[], deps: ShapeOpenDeps): Promise<number> {
  const out = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const err = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  const parsed = parseShapeOpen(argv);
  if (!parsed.ok) {
    err(parsed.error);
    return 2;
  }
  if (parsed.id && (!isShapeId(parsed.id) || !createShapeStore({ dataDir: deps.dataDir }).get(parsed.id))) {
    err(`not_found: No shape ${parsed.id}. List them with \`plannotator shape list\`.`);
    return 1;
  }
  let entry: ShapeServerEntry;
  try {
    entry = await ensureShapeServer(deps);
  } catch (error) {
    err(`not_started: ${(error as Error).message}`);
    return 1;
  }
  const url = shapePageUrl(entry.url, parsed.id);
  if (deps.reuseOpenPage && ((await shapeServerOpenPages(entry)) ?? 0) > 0) {
    if (parsed.json) out(JSON.stringify({ url, opened: false }));
    else out(url);
    return 0;
  }
  const opened = await deps.openUrl(url);
  if (parsed.json) out(JSON.stringify({ url, opened: opened === "opened" }));
  else out(url);
  return 0;
}

/** `plannotator shape serve` (internal): the Shapes server in this process, until it is idle. */
export async function runShapeServe(deps: { dataDir: string; page: () => string; version: string }): Promise<number> {
  if (await runningShapeServer(deps.dataDir)) return 0;
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => (resolveExit = r));
  const server = await startShapeServer({
    dataDir: deps.dataDir,
    page: deps.page,
    version: deps.version,
    onIdle: () => {
      server.stop();
      resolveExit(0);
    },
  });
  const quit = () => {
    server.stop();
    resolveExit(0);
  };
  process.once("SIGTERM", quit);
  process.once("SIGINT", quit);
  process.stderr.write(`Plannotator Shape: ${server.url}/\n`);
  return exited;
}
