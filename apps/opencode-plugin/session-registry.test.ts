/**
 * The review and annotate commands' servers are listed in `plannotator
 * sessions` only while they wait: the entry goes when the decision comes, and
 * when the wait or the stop throws. A command with no project is "unknown".
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideListed } from "./session-registry";

const saved = process.env.PLANNOTATOR_DATA_DIR;
let dataDir = "";
afterEach(() => {
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function sandbox(): string {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-opencode-sessions-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  return join(dataDir, "sessions", "opencode");
}

function stubServer(decide: (listed: string[]) => Promise<{ approved: boolean }>, dir: string) {
  const server = {
    port: 45123,
    url: "http://localhost:45123",
    stopped: false,
    waitForDecision: () => decide(readdirSync(dir)),
    stop: () => {
      server.stopped = true;
    },
  };
  return server;
}

test("listed while it waits, gone once the decision comes", async () => {
  const dir = sandbox();
  let seen: string[] = [];
  const server = stubServer(async (listed) => ((seen = listed), { approved: true }), dir);
  expect(await decideListed(server, "review", "p")).toEqual({ approved: true });
  expect(seen).toEqual([`${process.pid}-45123.json`]);
  expect(server.stopped).toBe(true);
  expect(readdirSync(dir)).toEqual([]);
});

test("a command with no project is listed as unknown, never as OpenCode's own folder", async () => {
  const dir = sandbox();
  let project = "";
  const server = stubServer(async (listed) => {
    project = JSON.parse(readFileSync(join(dir, listed[0]!), "utf-8")).project;
    return { approved: true };
  }, dir);
  await decideListed(server, "review", undefined);
  expect(project).toBe("unknown");
});

test("a stop that throws still removes the entry", async () => {
  const dir = sandbox();
  const server = stubServer(async () => ({ approved: true }), dir);
  server.stop = () => {
    throw new Error("stop failed");
  };
  await expect(decideListed(server, "review", "p")).rejects.toThrow("stop failed");
  expect(readdirSync(dir)).toEqual([]);
});

test("a wait that throws still stops the server and removes the entry", async () => {
  const dir = sandbox();
  const failure = new Error("decision failed");
  const server = stubServer(async () => {
    throw failure;
  }, dir);
  await expect(decideListed(server, "annotate", "p")).rejects.toBe(failure);
  expect(server.stopped).toBe(true);
  expect(readdirSync(dir)).toEqual([]);
});
