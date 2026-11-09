/**
 * The session registry: writes are atomic, and the read-only lister the
 * update advert runs on every page payload never deletes a file. OpenCode's
 * in-process servers are listed apart: the update checks never see them, and
 * no entry outlives its server.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listInProcessSessions,
  listLiveSessions,
  listSessions,
  registerInProcessSession,
  registerSession,
  type SessionInfo,
} from "./sessions";

let dataDir: string;
let saved: string | undefined;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-sessions-"));
  saved = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
  rmSync(dataDir, { recursive: true, force: true });
});

const info = (pid: number): SessionInfo => ({
  pid,
  port: 1234,
  url: "http://localhost:1234",
  mode: "review",
  project: "p",
  startedAt: new Date().toISOString(),
  label: "review-p",
});

/** A pid that has exited. */
function deadPid(): number {
  const proc = Bun.spawnSync(["true"]);
  return proc.pid;
}

test("registerSession writes through a temp file: only the finished .json is left", () => {
  registerSession(info(process.pid));
  const dir = join(dataDir, "sessions");
  expect(readdirSync(dir)).toEqual([`${process.pid}.json`]);
  expect(listLiveSessions().map((s) => s.pid)).toEqual([process.pid]);
});

test("listLiveSessions reads only: a half-written or dead entry is skipped, never deleted", () => {
  const dir = join(dataDir, "sessions");
  mkdirSync(dir, { recursive: true });
  registerSession(info(process.pid));
  writeFileSync(join(dir, "424242.json"), '{"pid": 424242, "port"');
  const dead = deadPid();
  writeFileSync(join(dir, `${dead}.json`), JSON.stringify(info(dead)));
  writeFileSync(join(dir, "99.json.abc.tmp"), "{");

  for (let i = 0; i < 3; i++) expect(listLiveSessions().map((s) => s.pid)).toEqual([process.pid]);
  expect(readdirSync(dir).sort()).toEqual([`${dead}.json`, "424242.json", `${process.pid}.json`, "99.json.abc.tmp"].sort());

  // listSessions keeps its cleanup (plannotator sessions); the temp file is not its business either.
  expect(listSessions().map((s) => s.pid)).toEqual([process.pid]);
  expect(readdirSync(dir).sort()).toEqual([`${process.pid}.json`, "99.json.abc.tmp"].sort());
});

test("listLiveSessions on a data dir with no sessions folder answers nothing and creates nothing", () => {
  expect(listLiveSessions()).toEqual([]);
  expect(existsSync(join(dataDir, "sessions"))).toBe(false);
});

test("registerSession never throws when the data dir can't be written (a file in its place)", () => {
  const blocked = join(dataDir, "not-a-dir");
  writeFileSync(blocked, "x");
  process.env.PLANNOTATOR_DATA_DIR = blocked;
  expect(() => registerSession(info(process.pid))).not.toThrow();
});

describe("in-process sessions (OpenCode)", () => {
  const opencodeDir = () => join(dataDir, "sessions", "opencode");
  const entry = (port: number) => ({
    port,
    url: `http://localhost:${port}`,
    mode: "review" as const,
    project: "p",
    startedAt: new Date().toISOString(),
    label: "review-p",
  });
  const serve = () => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });

  test("listed while its server answers; the update checks' readers never see it", async () => {
    const server = serve();
    try {
      const unlist = registerInProcessSession("opencode", entry(server.port));
      // listSessions and listLiveSessions read what every released binary
      // reads (the top folder's *.json), so an older binary skips it too.
      expect(listSessions()).toEqual([]);
      expect(listLiveSessions()).toEqual([]);
      expect(readdirSync(opencodeDir())).toEqual([`${process.pid}-${server.port}.json`]);
      expect(await listInProcessSessions("opencode")).toMatchObject([{ pid: process.pid, port: server.port, host: "opencode" }]);

      unlist();
      expect(readdirSync(opencodeDir())).toEqual([]);
      expect(() => unlist()).not.toThrow();
    } finally {
      server.stop(true);
    }
  });

  test("a stale entry is dropped and removed: its server stopped, its process gone, or unreadable", async () => {
    const stopped = serve();
    registerInProcessSession("opencode", entry(stopped.port));
    stopped.stop(true);

    const live = serve();
    try {
      const dead = deadPid();
      writeFileSync(join(opencodeDir(), `${dead}-${live.port}.json`), JSON.stringify({ ...entry(live.port), pid: dead, host: "opencode" }));
      writeFileSync(join(opencodeDir(), "1-2.json"), '{"pid": 1, "port"');

      expect(await listInProcessSessions("opencode")).toEqual([]);
      expect(readdirSync(opencodeDir())).toEqual([]);
    } finally {
      live.stop(true);
    }
  });

  test("registering removes entries whose process is gone, and keeps live ones, without waiting for a list", () => {
    mkdirSync(opencodeDir(), { recursive: true });
    const write = (pid: number, port: number) =>
      writeFileSync(join(opencodeDir(), `${pid}-${port}.json`), JSON.stringify({ ...entry(port), pid, host: "opencode" }));
    write(deadPid(), 1);
    write(process.ppid, 3);
    // pid 1 belongs to root: kill(1, 0) answers EPERM for anyone else, which is alive.
    if (process.platform !== "win32") write(1, 4);
    const unlist = registerInProcessSession("opencode", entry(2));
    const kept = [`${process.pid}-2.json`, `${process.ppid}-3.json`, ...(process.platform !== "win32" ? ["1-4.json"] : [])];
    expect(readdirSync(opencodeDir()).sort()).toEqual(kept.sort());
    unlist();
  });

  test("the process's exit removes its entries; a killed process's entry is dropped by the next list", async () => {
    const script = [
      `import { registerInProcessSession } from ${JSON.stringify(join(import.meta.dir, "sessions.ts"))};`,
      `const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });`,
      `registerInProcessSession("opencode", { ...${JSON.stringify(entry(0))}, port: server.port });`,
      `console.log("ready");`,
      `if (process.argv.includes("--exit")) process.exit(0);`,
    ].join("\n");
    const run = (arg: string) =>
      Bun.spawn([process.execPath, "-e", script, "--", arg], {
        env: { ...process.env, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_INBOX_CONNECT: "0", PLANNOTATOR_UPDATE_CHECK: "0" },
        stdout: "pipe",
        stderr: "inherit",
      });

    const exits = run("--exit");
    expect(await exits.exited).toBe(0);
    expect(readdirSync(opencodeDir())).toEqual([]);

    const killed = run("--stay");
    try {
      const first = await killed.stdout.getReader().read();
      expect(new TextDecoder().decode(first.value)).toContain("ready");
      expect(readdirSync(opencodeDir())).toHaveLength(1);
    } finally {
      killed.kill("SIGKILL");
      await killed.exited;
    }
    expect(await listInProcessSessions("opencode")).toEqual([]);
    expect(readdirSync(opencodeDir())).toEqual([]);
  });
});
