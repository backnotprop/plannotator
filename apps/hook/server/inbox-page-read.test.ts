import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stubbedAgentClis } from "../../../tests/helpers/agent-cli-guard";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { type InboxEntry, inboxEntryOf, stopProvenInboxes } from "../../../tests/helpers/inbox-process";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const preload = resolve(import.meta.dir, "../../../tests/helpers/redirect-inbox-page.ts");
const roots: string[] = [];
let stubs: string[] = [];
const dataDirs = new Map<string, string>();
const children: Bun.Subprocess<"ignore", "ignore", "pipe">[] = [];

beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => removeStubbedHtml(stubs));
afterEach(async () => {
  const started = [...dataDirs].flatMap(([root, dataDir]) => {
    const named = inboxEntryOf(dataDir);
    return named ? [{ entry: named, root }] : [];
  });
  dataDirs.clear();
  await stopProvenInboxes(started, { signal: "SIGKILL" });
  for (const child of children.splice(0)) {
    // inbox-guard: own child (this test spawned it, in its own scratch HOME; already gone when it ended by itself)
    child.kill("SIGKILL");
    await child.exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const agents = stubbedAgentClis();

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-page-read-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const dataDir = join(root, "data");
  dataDirs.set(root, dataDir);
  const page = join(root, "inbox.html");
  const env = {
    ...agents.env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmpdir(),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_UPDATE_CHECK: "0",
    PLANNOTATOR_TEST_INBOX_PAGE: page,
  };
  const spawn = (args: string[]) => {
    const proc = Bun.spawn([process.execPath, "run", "--preload", preload, entry, ...args], { cwd: root, env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    children.push(proc);
    return proc;
  };
  return { root, dataDir, page, spawn };
}

async function finish(proc: (typeof children)[number], ms = 20_000): Promise<{ exit: number; stderr: string }> {
  const stderr = new Response(proc.stderr).text();
  // inbox-guard: own child
  const deadline = setTimeout(() => proc.kill("SIGKILL"), ms);
  const exit = await proc.exited;
  clearTimeout(deadline);
  return { exit, stderr: await stderr };
}

test.each([
  [["inbox", "mcp"], 0],
  [["inbox", "status"], 1],
] as const)("%j runs without the page", async (args, code) => {
  const box = sandbox();
  const { exit, stderr } = await finish(box.spawn([...args]));
  expect(stderr).not.toContain("ENOENT");
  expect(exit).toBe(code);
}, 30_000);

test("serving answers with the page it read", async () => {
  const box = sandbox();
  writeFileSync(box.page, "<!doctype html><title>Inbox</title><p data-page-under-test></p>");
  const proc = box.spawn(["inbox", "--no-open"]);
  let named: InboxEntry | null = null;
  for (let i = 0; i < 300 && !named && proc.exitCode === null; i++) {
    named = inboxEntryOf(box.dataDir);
    if (!named) await Bun.sleep(100);
  }
  if (!named) throw new Error(`the Inbox did not start: ${(await finish(proc, 0)).stderr}`);

  const page = await fetch(`http://127.0.0.1:${named.port}/`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("data-page-under-test");
}, 40_000);

test("serving without the page fails before it starts an Inbox", async () => {
  const box = sandbox();
  const { exit, stderr } = await finish(box.spawn(["inbox", "--no-open"]));
  expect(stderr).toContain("ENOENT");
  expect(exit).not.toBe(0);
  expect(inboxEntryOf(box.dataDir)).toBeNull();
}, 30_000);
