/**
 * The one-time list options dialog's claim (approval "inbox-list-options-intro") on a real Inbox: decided at the first
 * release start, due only for someone who used an Inbox before, claimed once per machine. What regresses: a fresh
 * install getting it, a dev build deciding it, the dialog showing twice (two tabs, a reload), a claim with another
 * server session going through, or a claim that could not be saved showing it (it would show again on every load).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "./inbox";
import { __setConfigSaveMergeWindowHookForTest } from "@plannotator/shared/config";

const roots: string[] = [];
const servers: InboxServer[] = [];
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;

afterEach(() => {
  __setConfigSaveMergeWindowHookForTest(null);
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

/** An Inbox in a temp data dir; `usedBefore` writes the config an earlier Inbox would have left. */
async function world(options: { version: string; usedBefore: boolean }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-list-intro-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  // The Inbox reads config.json through the env, even when handed dataDir.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  if (options.usedBefore) writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxNotifications: { dismissed: true } }));
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, version: options.version });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: Record<string, unknown> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const due = async () => ((await (await fetch(`${base}/api/inbox/settings`)).json()) as { list_intro: { due: boolean } }).list_intro.due;
  const saved = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxListIntro as { dueAt?: string; shownAt?: string } | undefined;
  return { base, post, due, saved };
}

describe("the list options dialog's claim", () => {
  test("someone who used an Inbox before: due, and only the first claim ever shows it", async () => {
    const { base, post, due, saved } = await world({ version: "0.30.0", usedBefore: true });
    expect(await due()).toBe(true);
    expect(saved()?.dueAt).toMatch(/^\d{4}-/);
    expect(saved()?.shownAt).toBeUndefined();
    // Another server session (a page from an earlier start) claims nothing.
    expect((await post("/api/inbox/list-intro", { serverSession: "another" })).status).toBe(409);
    expect(await due()).toBe(true);
    expect((await fetch(`${base}/api/inbox/list-intro`)).status).toBe(405);
    // Two tabs ask: one shows it.
    const answers = await Promise.all([post("/api/inbox/list-intro"), post("/api/inbox/list-intro")]);
    const shows = await Promise.all(answers.map(async (answer) => ((await answer.json()) as { show: boolean }).show));
    expect(shows.filter(Boolean)).toHaveLength(1);
    expect(saved()?.shownAt).toMatch(/^\d{4}-/);
    expect(await due()).toBe(false);
    expect(await (await post("/api/inbox/list-intro")).json()).toEqual({ show: false, list_intro: { due: false } });
  });

  test("config.json can't be written: the claim shows nothing and it stays due for a later load", async () => {
    const { post, due, saved } = await world({ version: "0.30.0", usedBefore: true });
    expect(await due()).toBe(true);
    __setConfigSaveMergeWindowHookForTest(() => {
      throw new Error("disk full");
    });
    expect(await (await post("/api/inbox/list-intro")).json()).toEqual({ show: false, list_intro: { due: true } });
    expect(saved()?.shownAt).toBeUndefined();
    __setConfigSaveMergeWindowHookForTest(null);
    expect(((await (await post("/api/inbox/list-intro")).json()) as { show: boolean }).show).toBe(true);
  });

  test("a fresh install never gets it: marked shown at its first start", async () => {
    const { post, due, saved } = await world({ version: "0.30.0", usedBefore: false });
    expect(await due()).toBe(false);
    expect(saved()?.shownAt).toMatch(/^\d{4}-/);
    expect(saved()?.dueAt).toBeUndefined();
    expect(((await (await post("/api/inbox/list-intro")).json()) as { show: boolean }).show).toBe(false);
  });

  test("a dev build decides nothing, so the dialog never shows from it", async () => {
    const { post, due, saved } = await world({ version: "0.0.0-dev", usedBefore: true });
    expect(await due()).toBe(false);
    expect(saved()).toBeUndefined();
    expect(((await (await post("/api/inbox/list-intro")).json()) as { show: boolean }).show).toBe(false);
  });
});
