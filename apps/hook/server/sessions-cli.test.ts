/**
 * `plannotator sessions` lists OpenCode's in-process servers beside the
 * binary's, marked as in OpenCode, and drops one whose server has stopped.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerInProcessSession } from "@plannotator/server/sessions";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
let stubs: string[] = [];
beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
const saved = process.env.PLANNOTATOR_DATA_DIR;
let dataDir = "";
afterEach(() => {
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function sessions(...flags: string[]) {
  return Bun.spawnSync([process.execPath, "run", entry, "sessions", ...flags], {
    env: {
      ...process.env,
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_UPDATE_CHECK: "0",
    },
  });
}

test("an OpenCode server is listed while it runs and dropped once it stops", async () => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-sessions-cli-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const info = { url: `http://localhost:${server.port}`, mode: "review" as const, project: "p", startedAt: new Date().toISOString(), label: "review-p" };
  registerInProcessSession("opencode", { ...info, port: server.port });
  try {
    const listed = JSON.parse(sessions("--json").stdout.toString());
    expect(listed).toMatchObject([{ index: 1, mode: "review", port: server.port, host: "opencode" }]);
    expect(sessions().stderr.toString()).toContain("(in OpenCode)");
  } finally {
    server.stop(true);
  }
  expect(sessions("--json").stdout.toString().trim()).toBe("[]");
  expect(readdirSync(join(dataDir, "sessions", "opencode"))).toEqual([]);
}, 30_000);
