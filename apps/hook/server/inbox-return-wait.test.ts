import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INBOX_START_LOCK, readInboxRegistry } from "@plannotator/shared/inbox/registry";
import { INBOX_DB_FILE, INBOX_RETURN_PARTIAL } from "@plannotator/shared/inbox/store-log/sqlite-return/return";
import { stubbedAgentClis } from "../../../tests/helpers/agent-cli-guard";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { type InboxEntry, inboxEntryOf, stopProvenInboxes } from "../../../tests/helpers/inbox-process";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const fixture = resolve(import.meta.dir, "../../../packages/shared/inbox/store-log/sqlite-return/fixtures/v0.28.64");
const roots: string[] = [];
let stubs: string[] = [];
const started: { entry: InboxEntry; root: string }[] = [];
const agents = stubbedAgentClis();

beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(async () => {
  await stopProvenInboxes(started.splice(0), { signal: "SIGKILL" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function start(root: string, env: Record<string, string>) {
  const at = Date.now();
  const proc = Bun.spawn([process.execPath, "run", entry, "inbox", "--background"], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([stdout, stderr, code]) => ({ stdout, stderr, code, ms: Date.now() - at }));
}

test(
  "a starter waits out a way back longer than its wait, and a second starter meanwhile runs no second one",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-return-wait-")));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const dataDir = join(root, "data");
    const inbox = join(dataDir, "inbox");
    cpSync(join(fixture, "inbox"), inbox, { recursive: true });
    const db = new Database(join(inbox, INBOX_DB_FILE), { create: true });
    db.run(readFileSync(join(inbox, "inbox.sql"), "utf8"));
    db.close();
    rmSync(join(inbox, "inbox.sql"));
    const env = {
      ...agents.env,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: tmpdir(),
      PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9",
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      BROWSER: NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_TEST_SANDBOX: "1",
      PLANNOTATOR_INBOX_START_TIMEOUT_MS: "3000",
      PLANNOTATOR_INBOX_RETURN_DELAY_MS: "8000",
    };

    const first = start(root, env);
    const at = Date.now();
    while (!existsSync(join(inbox, INBOX_RETURN_PARTIAL))) await Bun.sleep(50);
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(inbox, INBOX_START_LOCK), old, old);
    await Bun.sleep(Math.max(0, 3_500 - (Date.now() - at)));
    const second = start(root, env);
    const [a, b] = await Promise.all([first, second]);
    let named = inboxEntryOf(dataDir);
    for (let waited = 0; !named && waited < 15_000; waited += 100) {
      await Bun.sleep(100);
      named = inboxEntryOf(dataDir);
    }
    if (named) started.push({ entry: named, root });

    expect(a.code).toBe(0);
    expect(a.ms).toBeGreaterThan(8_000);
    expect(b.code).toBe(0);
    expect(b.stdout).toBe(a.stdout);
    expect(a.stdout.trim()).toBe(readInboxRegistry(dataDir)!.url);
    const log = readFileSync(join(inbox, "inbox.log"), "utf8");
    expect(log.match(/moved back from inbox\.db/g)).toHaveLength(1);
    expect(log).not.toContain("could not start");
    expect(log.match(/the way back held/g)).toHaveLength(1);
    expect(existsSync(join(inbox, INBOX_DB_FILE))).toBe(false);
    expect(existsSync(join(inbox, "seq.json"))).toBe(true);
    expect(existsSync(join(inbox, "initiatives.jsonl"))).toBe(true);
  },
  60_000,
);
