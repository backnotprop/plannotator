/**
 * A start that outlasts the starter's wait because the Inbox is moving into SQLite (the switch, off for everyone):
 * real processes in a scratch HOME and data dir (never the person's Inbox), the move held 8 s by the sandbox-only
 * `PLANNOTATOR_INBOX_IMPORT_DELAY_MS` against a starter's wait cut to 3 s (`PLANNOTATOR_INBOX_START_TIMEOUT_MS`).
 *
 * What this catches: a starter (`--background`, an agent's start) that gives up on an Inbox that is only busy moving
 * and reports it as failed; the upgrading line missing from the starter's terminal; and a second starter that takes
 * the start lock as stale while the move runs, starting a second Inbox whose move throws the first one's away.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INBOX_START_LOCK, readInboxRegistry } from "@plannotator/shared/inbox/registry";
import { INBOX_UPGRADING_LINE } from "@plannotator/shared/inbox/store-log/sqlite/move-words";
import { writeInboxWorld } from "../../../packages/shared/inbox/store-log/world";
import { INBOX_UPGRADE_MARKER } from "../../../packages/shared/inbox/store-log/sqlite/upgrade-marker";
import { stubbedAgentClis } from "../../../tests/helpers/agent-cli-guard";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { type InboxEntry, inboxEntryOf, stopProvenInboxes } from "../../../tests/helpers/inbox-process";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
let stubs: string[] = [];
const started: { entry: InboxEntry; root: string }[] = [];

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
const agents = stubbedAgentClis();

function start(root: string, env: Record<string, string>) {
  const at = Date.now();
  const proc = Bun.spawn([process.execPath, "run", entry, "inbox", "--background"], { cwd: root, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([stdout, stderr, code]) => ({ stdout, stderr, code, ms: Date.now() - at }));
}

test(
  "a starter waits out a move into SQLite longer than its wait, says so, and a second starter meanwhile starts no second Inbox",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-upgrade-wait-")));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const dataDir = join(root, "data");
    writeInboxWorld({ dataDir, seed: 3, steps: 120 });
    const inbox = join(dataDir, "inbox");
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
      PLANNOTATOR_TEST_SANDBOX: "1",
      PLANNOTATOR_INBOX_SQLITE: "1",
      PLANNOTATOR_INBOX_START_TIMEOUT_MS: "3000",
      PLANNOTATOR_INBOX_IMPORT_DELAY_MS: "8000",
    };

    // Every process that ran the move, as the marker names them while it runs.
    const movers = new Set<string>();
    let watching = true;
    const watch = (async () => {
      while (watching) {
        try {
          movers.add(readFileSync(join(inbox, INBOX_UPGRADE_MARKER), "utf8").trim());
        } catch {
          // No move running.
        }
        await Bun.sleep(50);
      }
    })();

    const first = start(root, env);
    // Once the move runs, the start lock reads as old as a dead starter's (past its 30 s), and a second starter comes.
    while (!existsSync(join(inbox, INBOX_UPGRADE_MARKER))) await Bun.sleep(50);
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(inbox, INBOX_START_LOCK), old, old);
    const second = start(root, env);
    const [a, b] = await Promise.all([first, second]);
    watching = false;
    await watch;
    const named = inboxEntryOf(dataDir);
    if (named) started.push({ entry: named, root });

    expect(a.code).toBe(0);
    expect(a.ms).toBeGreaterThan(8_000);
    expect(a.stderr).toContain(INBOX_UPGRADING_LINE);
    expect(b.code).toBe(0);
    expect(b.stdout).toBe(a.stdout);
    expect(a.stdout.trim()).toBe(readInboxRegistry(dataDir)!.url);
    // One move, by the one Inbox that serves now, finished: on the database, nothing of the move left over.
    expect([...movers]).toEqual([String(named!.pid)]);
    expect(existsSync(join(inbox, "inbox.db"))).toBe(true);
    expect(existsSync(join(inbox, INBOX_UPGRADE_MARKER))).toBe(false);
  },
  60_000,
);
