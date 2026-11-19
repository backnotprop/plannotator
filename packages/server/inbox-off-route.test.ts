/**
 * Settings → General's Turn the Inbox off, at the Inbox server
 * (`POST /api/inbox/off`, inbox-on-settle.ts). Starts an in-process Inbox in a
 * scratch data dir, so CI runs it.
 *
 * Regressions guarded: another site's page turning the Inbox off; the record
 * not saying off; Plannotator's untouched note left behind; the Inbox not
 * stopping after it answered.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readInboxOnRecord, turnInboxOn } from "@plannotator/shared/inbox/inbox-on";
import { startInboxServer, type InboxServer } from "./inbox";
import { addInboxNote } from "./inbox-agent-notes";
import { createAgentEnvironment } from "./inbox-agents";

const servers: InboxServer[] = [];
let saved: string | undefined;
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
});

test("one POST turns it off: record off, the untouched note gone, then the Inbox stops; another site's page cannot", async () => {
  const dataDir = join(realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-off-"))), "data");
  mkdirSync(dataDir, { recursive: true });
  saved = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  // The preload makes the home a scratch folder: the note goes there, never in a real ~/.claude.
  expect(homedir().startsWith(realpathSync(tmpdir())) || homedir().startsWith(tmpdir())).toBe(true);
  turnInboxOn("command", dataDir);
  expect(addInboxNote("claude-code", dataDir, createAgentEnvironment())).toMatchObject({ ok: true });
  const note = join(homedir(), ".claude", "rules", "plannotator-inbox.md");
  expect(existsSync(note)).toBe(true);

  let stopRequested = false;
  const server = await startInboxServer({ dataDir, onStopRequested: () => void (stopRequested = true) });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const post = (origin: string) =>
    fetch(`${base}/api/inbox/off`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ serverSession: server.serverSession }) });

  expect((await post("https://evil.example")).status).toBe(403);
  expect(readInboxOnRecord(dataDir)?.on).toBe(true);

  const answer = await post(base);
  expect(answer.status).toBe(200);
  const body = (await answer.json()) as { lines: string[] };
  expect(body.lines[0]).toBe("The Plannotator Inbox is off on this computer: agents lose it from their next session, and nothing starts it.");
  expect(body.lines.at(-1)).toBe("Turn it back on any time with plannotator inbox.");
  expect(readInboxOnRecord(dataDir)).toMatchObject({ on: false, by: "off" });
  expect(existsSync(note)).toBe(false);
  for (let i = 0; i < 40 && !stopRequested; i++) await Bun.sleep(50);
  expect(stopRequested).toBe(true);
});
