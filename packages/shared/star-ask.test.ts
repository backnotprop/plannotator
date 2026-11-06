/**
 * The "Star the repo" ask's decisions (approval "star-ask", 2026-11-06; packages/shared/star-ask.ts), with a fake gh
 * and an in-memory config.json record: the real gh is never run (an absolute path to a scratch script stands in for it
 * where the spawn itself is tested).
 *
 * What regresses: the ask showing in a dev build, a test or CI; showing to someone in their first week; showing twice
 * (a second surface, a second tab, a surface after an answer, a hand-edited record); the already-starred check reading
 * a 204 as "show it" or anything but a 404 as "gh can star"; a missing gh, a signed-out gh or a gh that never answers
 * holding the ask back (or hanging past the timeout) instead of falling back to the link; starring without a click, or
 * with no shown record, or twice on a double click; a star written as starred when GitHub refused it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STAR_ASK_CHECK_ARGS,
  STAR_ASK_STAR_ARGS,
  checkStarred,
  createGhRunner,
  createStarAsk,
  ghHttpStatus,
  readStarAskRecord,
  setStarAskRelease,
  starAskEnabled,
  starAskOpen,
  starAskReturning,
  starAskRoute,
  starRepo,
  type GhResult,
  type GhRunner,
  type StarAskRecord,
  type StarAskStore,
} from "./star-ask";

const ok = (status: number): GhResult => ({ code: status < 300 ? 0 : 1, stdout: `HTTP/2.0 ${status} X\r\nContent-Type: application/json\r\n\r\n`, stderr: status < 300 ? "" : `gh: Not Found (HTTP ${status})` });

/** A fake gh: answers each call from the list, and records the arguments. */
function fakeGh(...answers: Array<GhResult | "hang">): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = ((args: readonly string[]) => {
    calls.push([...args]);
    const next = answers.shift() ?? ok(500);
    return next === "hang" ? new Promise<GhResult>(() => {}) : Promise.resolve(next);
  }) as GhRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

function memoryStore(initial?: unknown): StarAskStore & { raw: unknown; writes: number; failWrites?: boolean } {
  const store = {
    raw: initial,
    writes: 0,
    failWrites: false,
    read() {
      return { record: readStarAskRecord({ starAsk: store.raw as StarAskRecord }), raw: store.raw };
    },
    write(record: StarAskRecord) {
      if (store.failWrites) return false;
      store.writes++;
      store.raw = { ...record };
      return true;
    },
  };
  return store;
}

const NOW = new Date("2026-11-06T13:00:00.000Z");
function service(store: StarAskStore, run: GhRunner, over: { enabled?: boolean; returning?: boolean } = {}) {
  return createStarAsk({ store, run, enabled: () => over.enabled ?? true, returning: () => over.returning ?? true, now: () => NOW, timeoutMs: 50 });
}

afterEach(() => setStarAskRelease(null));

describe("who: release builds only", () => {
  test("a release build outside CI and the sandbox", () => {
    expect(starAskEnabled({}, true)).toBe(true);
    expect(starAskEnabled({}, false)).toBe(false);
  });

  test("never in CI, never under the test sandbox (whatever the build) unless the preview is asked for", () => {
    expect(starAskEnabled({ CI: "true" }, true)).toBe(false);
    expect(starAskEnabled({ PLANNOTATOR_TEST_SANDBOX: "1" }, true)).toBe(false);
    expect(starAskEnabled({ NODE_ENV: "test" }, true)).toBe(false);
    expect(starAskEnabled({ PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_STAR_ASK_PREVIEW: "1" }, false)).toBe(true);
    // The preview means nothing outside the sandbox: a dev build stays off.
    expect(starAskEnabled({ PLANNOTATOR_STAR_ASK_PREVIEW: "1" }, false)).toBe(false);
  });

  test("this test process is never a release, and a host's word overrides the compiled-in mark", () => {
    expect(starAskEnabled(process.env)).toBe(false);
    setStarAskRelease(true);
    expect(starAskEnabled({})).toBe(true);
  });
});

describe("who: returning people (the daily ping's first-use week)", () => {
  const dir = (firstWeek?: string) => {
    const path = mkdtempSync(join(tmpdir(), "star-ask-"));
    if (firstWeek) writeFileSync(join(path, "ping.json"), JSON.stringify({ firstWeek }));
    return path;
  };

  test("week 2 or later from ping.json's firstWeek; never in the first week", () => {
    expect(starAskReturning(dir("2026-10-26"), NOW.getTime())).toBe(true);
    expect(starAskReturning(dir("2026-11-02"), NOW.getTime())).toBe(false);
  });

  test("with no ping.json (the ping off), a data folder made today is the first week", () => {
    expect(starAskReturning(dir(), NOW.getTime())).toBe(false);
  });
});

describe("the already-starred check (gh)", () => {
  test("asks GitHub about the repository with the person's gh, on github.com", () => {
    expect(STAR_ASK_CHECK_ARGS).toEqual(["api", "--include", "--hostname", "github.com", "user/starred/backnotprop/plannotator"]);
    expect(STAR_ASK_STAR_ARGS).toEqual(["api", "--include", "--hostname", "github.com", "-X", "PUT", "user/starred/backnotprop/plannotator"]);
  });

  test("204: starred; 404: not starred; anything else: unknown", async () => {
    expect(await checkStarred(fakeGh(ok(204)), 50)).toBe("starred");
    expect(await checkStarred(fakeGh(ok(404)), 50)).toBe("not-starred");
    expect(await checkStarred(fakeGh(ok(401)), 50)).toBe("unknown");
    expect(await checkStarred(fakeGh(ok(500)), 50)).toBe("unknown");
  });

  test("gh missing, signed out, or silent past the timeout: unknown, never a hang", async () => {
    expect(await checkStarred(fakeGh({ code: null, stdout: "", stderr: "" }), 50)).toBe("unknown");
    expect(await checkStarred(fakeGh({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }), 50)).toBe("unknown");
    expect(await checkStarred(fakeGh({ code: null, stdout: "", stderr: "", timedOut: true }), 50)).toBe("unknown");
    const started = Date.now();
    expect(await checkStarred(fakeGh("hang"), 50)).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(2_000);
    const throwing: GhRunner = () => Promise.reject(new Error("boom"));
    expect(await checkStarred(throwing, 50)).toBe("unknown");
  });

  test("the status comes from the status line, else gh's own (HTTP n) error", () => {
    expect(ghHttpStatus({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" })).toBe(404);
    expect(ghHttpStatus({ code: 0, stdout: "HTTP/1.1 204 No Content\r\n", stderr: "" })).toBe(204);
    expect(ghHttpStatus({ code: 0, stdout: "", stderr: "" })).toBeNull();
  });

  test("the star: true only on GitHub's 204", async () => {
    expect(await starRepo(fakeGh(ok(204)), 50)).toBe(true);
    expect(await starRepo(fakeGh(ok(403)), 50)).toBe(false);
    expect(await starRepo(fakeGh("hang"), 50)).toBe(false);
  });
});

describe("the runner (a scratch program, never the real gh)", () => {
  const program = (body: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "star-ask-gh-")), "gh");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  test.skipIf(process.platform === "win32")("passes the arguments, reads the status line, and stops a slow program at the timeout", async () => {
    const answers = program('case "$*" in *PUT*) printf "HTTP/2.0 204 No Content\\r\\n\\r\\n"; exit 0;; *) printf "HTTP/2.0 404 Not Found\\r\\n\\r\\n"; echo "gh: Not Found (HTTP 404)" >&2; exit 1;; esac');
    expect(await checkStarred(createGhRunner(answers), 2_000)).toBe("not-starred");
    expect(await starRepo(createGhRunner(answers), 2_000)).toBe(true);
    const slow = program("sleep 5");
    const started = Date.now();
    const result = await createGhRunner(slow)(["api"], 100);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a program that does not exist resolves with no code (the link fallback)", async () => {
    const result = await createGhRunner(join(tmpdir(), "no-such-dir-star-ask", "gh"))(["api"], 1_000);
    expect(result.code).toBeNull();
  });
});

describe("the claim: once, everywhere", () => {
  test("not starred (404): shown, stamped once with when and where, and the button stars with gh", async () => {
    const store = memoryStore();
    const gh = fakeGh(ok(404));
    expect(await service(store, gh).claim("plan")).toEqual({ show: true, canStar: true });
    expect(store.raw).toEqual({ shownAt: NOW.toISOString(), surface: "plan", canStar: true });
    expect(gh.calls).toEqual([[...STAR_ASK_CHECK_ARGS]]);
  });

  test("starred already (204): nothing shows, and it is recorded so no surface asks again", async () => {
    const store = memoryStore();
    expect(await service(store, fakeGh(ok(204))).claim("review")).toEqual({ show: false, canStar: false });
    expect(store.raw).toEqual({ answer: "already", answeredAt: NOW.toISOString(), surface: "review" });
    expect(await service(store, fakeGh(ok(404))).claim("inbox")).toEqual({ show: false, canStar: false });
  });

  test("gh unknown (missing, signed out, timeout): shown anyway, with the link", async () => {
    for (const answer of [{ code: null, stdout: "", stderr: "" }, ok(401), "hang" as const]) {
      const store = memoryStore();
      expect(await service(store, fakeGh(answer)).claim("annotate")).toEqual({ show: true, canStar: false });
    }
  });

  test("shown on one surface: never on another, nor a second tab of the same one", async () => {
    const store = memoryStore();
    expect((await service(store, fakeGh(ok(404))).claim("plan")).show).toBe(true);
    const gh = fakeGh(ok(404));
    expect((await service(store, gh).claim("inbox")).show).toBe(false);
    expect((await service(store, gh).claim("plan")).show).toBe(false);
    // No check runs once it was shown.
    expect(gh.calls).toEqual([]);
  });

  test("two claims at once in one process: one check, one show", async () => {
    const store = memoryStore();
    const ask = service(store, fakeGh(ok(404), ok(404)));
    const [a, b] = await Promise.all([ask.claim("plan"), ask.claim("plan")]);
    expect([a.show, b.show].filter(Boolean)).toHaveLength(1);
    expect(store.writes).toBe(1);
  });

  test("another surface shows it while gh answers: this one shows nothing", async () => {
    const store = memoryStore();
    let answer!: (result: GhResult) => void;
    const slow: GhRunner = () => new Promise((resolve) => (answer = resolve));
    const pending = service(store, slow).claim("plan");
    await Promise.resolve();
    store.raw = { shownAt: "2026-11-06T12:59:59.000Z", surface: "inbox" };
    answer(ok(404));
    expect(await pending).toEqual({ show: false, canStar: false });
    expect(store.raw).toEqual({ shownAt: "2026-11-06T12:59:59.000Z", surface: "inbox" });
  });

  test("no check at all before every local rule passed: off, answered, a first week, or the surface's gate", async () => {
    const gh = fakeGh(ok(404), ok(404), ok(404), ok(404));
    expect((await service(memoryStore(), gh, { enabled: false }).claim("plan")).show).toBe(false);
    expect((await service(memoryStore({ answer: "not-now" }), gh).claim("plan")).show).toBe(false);
    expect((await service(memoryStore(), gh, { returning: false }).claim("plan")).show).toBe(false);
    expect((await service(memoryStore(), gh).claim("inbox", { gate: () => false })).show).toBe(false);
    expect(gh.calls).toEqual([]);
  });

  test("the surface's gate is asked again after the check (the Inbox's line may have moved on)", async () => {
    let free = true;
    const store = memoryStore();
    const run: GhRunner = async () => {
      free = false;
      return ok(404);
    };
    expect((await service(store, run).claim("inbox", { gate: () => free })).show).toBe(false);
    expect(store.raw).toBeUndefined();
  });

  test("a hand-edited record that is not an object, or names an answer: closed", () => {
    expect(starAskOpen(undefined)).toBe(true);
    expect(starAskOpen(readStarAskRecord({ starAsk: "yes" as never }), "yes")).toBe(false);
    expect(starAskOpen(readStarAskRecord({ starAsk: { answer: "already" } }))).toBe(false);
    expect(starAskOpen(readStarAskRecord({ starAsk: { shownAt: "x" } }))).toBe(false);
  });

  test("a record that could not be written is not shown (it would show on every load)", async () => {
    const store = memoryStore();
    store.failWrites = true;
    expect(await service(store, fakeGh(ok(404))).claim("plan")).toEqual({ show: false, canStar: false });
  });

  test("a custom stamp writes the record (the Inbox's line and the record in one save)", async () => {
    const store = memoryStore();
    const stamped: StarAskRecord[] = [];
    const claim = await service(store, fakeGh(ok(404))).claim("inbox", { stamp: (record) => (stamped.push(record), true) });
    expect(claim.show).toBe(true);
    expect(stamped).toEqual([{ shownAt: NOW.toISOString(), surface: "inbox", canStar: true }]);
  });
});

describe("the click", () => {
  const shown = (canStar: boolean) => memoryStore({ shownAt: "2026-11-06T12:00:00.000Z", surface: "plan", canStar });

  test("stars with gh only on the click, once shown with gh able to; 204 records starred", async () => {
    const store = shown(true);
    const gh = fakeGh(ok(204));
    expect(await service(store, gh).star()).toEqual({ starred: true });
    expect(gh.calls).toEqual([[...STAR_ASK_STAR_ARGS]]);
    expect(store.raw).toMatchObject({ answer: "starred", answeredAt: NOW.toISOString() });
  });

  test("a double click stars once", async () => {
    const store = shown(true);
    const gh = fakeGh(ok(204), ok(204));
    const ask = service(store, gh);
    const [a, b] = await Promise.all([ask.star(), ask.star()]);
    expect(a.starred && b.starred).toBe(true);
    expect(gh.calls).toHaveLength(1);
    expect(await ask.star()).toEqual({ starred: true });
    expect(gh.calls).toHaveLength(1);
  });

  test("GitHub refuses (or gh is silent): not starred, and nothing recorded as starred", async () => {
    for (const answer of [ok(403), "hang" as const]) {
      const store = shown(true);
      expect(await service(store, fakeGh(answer)).star()).toEqual({ starred: false });
      expect((store.raw as StarAskRecord).answer).toBeUndefined();
    }
  });

  test("never without a shown record, after an answer, or when the button is a link", async () => {
    for (const store of [memoryStore(), memoryStore({ shownAt: "x", canStar: true, answer: "not-now" }), shown(false)]) {
      const gh = fakeGh(ok(204));
      expect(await service(store, gh).star()).toEqual({ starred: false });
      expect(gh.calls).toEqual([]);
    }
  });

  test("Not now and the link record once, after it showed", () => {
    const store = shown(false);
    const ask = service(store, fakeGh());
    expect(ask.answer("opened")).toEqual({ ok: true });
    expect(store.raw).toMatchObject({ answer: "opened" });
    expect(ask.answer("not-now")).toEqual({ ok: true });
    expect(store.raw).toMatchObject({ answer: "opened" });
    expect(service(memoryStore(), fakeGh()).answer("not-now")).toEqual({ ok: false });
  });
});

describe("the routes (plan review, code review, annotate)", () => {
  test("claim and answer; no star route (the server stops before the click); POST only; a bad answer is refused", async () => {
    const store = memoryStore();
    const gh = fakeGh(ok(404), ok(204));
    const ask = service(store, gh);
    expect(await starAskRoute(ask, "review", "POST", "/api/star-ask/claim", {})).toEqual({ status: 200, body: { show: true, can_star: true } });
    expect(store.raw).toMatchObject({ surface: "review" });
    expect(await starAskRoute(ask, "review", "POST", "/api/star-ask/star", {})).toBeNull();
    expect(gh.calls).toEqual([[...STAR_ASK_CHECK_ARGS]]);
    expect(await starAskRoute(ask, "review", "GET", "/api/star-ask/claim", undefined)).toMatchObject({ status: 405 });
    expect(await starAskRoute(ask, "review", "POST", "/api/star-ask/answer", { answer: "yes" })).toMatchObject({ status: 400 });
    expect(await starAskRoute(ask, "review", "POST", "/api/star-ask/answer", { answer: "not-now" })).toEqual({ status: 200, body: { ok: true } });
    expect(await starAskRoute(ask, "review", "POST", "/api/other", {})).toBeNull();
  });
});
