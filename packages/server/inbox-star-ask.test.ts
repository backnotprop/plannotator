/**
 * The star ask in the Inbox (inbox-star-ask.ts): its claim and its `POST /api/inbox/star-ask` actions, against a
 * config.json in a temp data dir and a fake gh (the real gh never runs, no Inbox starts).
 *
 * What regresses: a guest (a tailnet device that is not the owner) claiming or starring; a dev build claiming; the
 * claim stamping anything of the line (it stands aside: no other dialog's day may move), or its own reveal and the
 * shared record landing in two saves; a 204 showing it or touching the line; a retry with the page's key not shown
 * again (or another key shown); the Inbox showing it after a done screen did; a claim while the line is not free
 * running gh; Not now stamping the line's three-day wait; a star on an ask the Inbox did not show.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configStarAskStore, createStarAsk, type GhResult, type GhRunner } from "@plannotator/shared/star-ask";
import { claimInboxStar, inboxStarAction } from "./inbox-star-ask";

const original = process.env.PLANNOTATOR_DATA_DIR;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inbox-star-ask-"));
  process.env.PLANNOTATOR_DATA_DIR = dir;
});

afterEach(() => {
  if (original === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = original;
});

const config = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
const seed = (value: unknown) => writeFileSync(join(dir, "config.json"), JSON.stringify(value));
const status = (code: number): GhResult => ({ code: code < 300 ? 0 : 1, stdout: `HTTP/2.0 ${code} X\r\n\r\n`, stderr: "" });

function gh(...answers: GhResult[]): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: readonly string[]) => (calls.push([...args]), answers.shift() ?? status(500))) as GhRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

const ask = (run: GhRunner) => createStarAsk({ store: configStarAskStore, run, enabled: () => true, returning: () => true, timeoutMs: 50 });
const deps = (run: GhRunner, over: { release?: boolean; mayClaim?: boolean } = {}) => ({ service: ask(run), release: over.release ?? true, mayClaim: () => over.mayClaim ?? true });
const LINE = { lastShownAt: "2026-11-04T10:00:00.000Z", dayShownAt: "2026-11-04T10:00:00.000Z" };

describe("the Inbox's claim", () => {
  test("shown: its own reveal (with the page's key) and the shared record in one save, nothing of the line", async () => {
    seed({ inboxReveals: LINE });
    const run = gh(status(404));
    expect(await claimInboxStar(deps(run), true, "page-key-1")).toEqual({ show: true, canStar: true });
    const saved = config();
    expect(saved.inboxReveals).toEqual({ ...LINE, star: { shownAt: saved.starAsk.shownAt, key: "page-key-1" } });
    expect(saved.starAsk).toMatchObject({ surface: "inbox", canStar: true });
  });

  test("a guest or a dev build: nothing, and gh never runs", async () => {
    const run = gh(status(404));
    expect(await claimInboxStar(deps(run), false, null)).toEqual({ show: false, canStar: false });
    expect(await claimInboxStar(deps(run, { release: false }), true, null)).toEqual({ show: false, canStar: false });
    expect(run.calls).toEqual([]);
  });

  test("the line not free: nothing, and gh never runs", async () => {
    const run = gh(status(404));
    expect((await claimInboxStar(deps(run, { mayClaim: false }), true, null)).show).toBe(false);
    expect(run.calls).toEqual([]);
  });

  test("starred already (204): recorded, nothing shown, the line untouched", async () => {
    seed({ inboxReveals: LINE });
    expect((await claimInboxStar(deps(gh(status(204))), true, "page-key-1")).show).toBe(false);
    expect(config().inboxReveals).toEqual(LINE);
    expect(config().starAsk).toMatchObject({ answer: "already", surface: "inbox" });
  });

  test("the same page's retry (its key) is shown again while unanswered; another key is not", async () => {
    const run = gh(status(404));
    expect((await claimInboxStar(deps(run), true, "page-key-1")).show).toBe(true);
    expect(await claimInboxStar(deps(run), true, "page-key-1")).toEqual({ show: true, canStar: true });
    expect((await claimInboxStar(deps(run), true, "page-key-2")).show).toBe(false);
    expect(run.calls).toHaveLength(1);
  });

  test("after a done screen showed it: never in the Inbox", async () => {
    seed({ starAsk: { checkedAt: "2026-11-05T10:00:00.000Z", shownAt: "2026-11-05T10:01:00.000Z", surface: "plan", canStar: true } });
    const run = gh(status(404));
    expect((await claimInboxStar(deps(run), true, "page-key-1")).show).toBe(false);
    expect(run.calls).toEqual([]);
  });
});

describe("POST /api/inbox/star-ask", () => {
  test("star: the owner's click on the ask the Inbox showed stars it once; a guest never", async () => {
    seed({ starAsk: { shownAt: "2026-11-05T10:00:00.000Z", surface: "inbox", canStar: true } });
    const run = gh(status(204));
    expect(await inboxStarAction(ask(run), false, { action: "star" })).toEqual({ starred: false });
    expect(run.calls).toEqual([]);
    expect(await inboxStarAction(ask(run), true, { action: "star" })).toEqual({ starred: true });
    expect(config().starAsk).toMatchObject({ answer: "starred" });
  });

  test("star: never on an ask a done screen showed", async () => {
    seed({ starAsk: { shownAt: "2026-11-05T10:00:00.000Z", surface: "review", canStar: true } });
    const run = gh(status(204));
    expect(await inboxStarAction(ask(run), true, { action: "star" })).toEqual({ starred: false });
    expect(run.calls).toEqual([]);
  });

  test("Not now records the answer and stamps nothing of the line; a guest records nothing; a bad body is refused", async () => {
    seed({ inboxReveals: LINE, starAsk: { shownAt: "2026-11-05T10:00:00.000Z", surface: "inbox", canStar: false } });
    expect(await inboxStarAction(ask(gh()), false, { action: "answer", answer: "not-now" })).toEqual({ ok: false });
    expect(config().starAsk.answer).toBeUndefined();
    expect(await inboxStarAction(ask(gh()), true, { action: "answer", answer: "not-now" })).toEqual({ ok: true });
    expect(config().starAsk.answer).toBe("not-now");
    expect(config().inboxReveals).toEqual(LINE);
    await expect(inboxStarAction(ask(gh()), true, { action: "answer", answer: "maybe" })).rejects.toThrow();
  });
});
