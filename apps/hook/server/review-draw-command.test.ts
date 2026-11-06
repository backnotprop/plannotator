/**
 * `plannotator review draw` / `drawings` (approval "shape-in-code-review",
 * ac2). What regresses: a malformed call reaching the Inbox, the drawing sent
 * without the token or under other field names, a refusal the agent cannot
 * act on, and (through the entrypoint) anything of it, help included, while
 * Code review is off. The Inbox here is a fake on Bun.serve: the route itself
 * is packages/server/inbox-review-drawings.test.ts's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_REVIEW_CODE_REVIEW_OFF, INBOX_REVIEW_DRAW_HELP, INBOX_REVIEW_DRAW_SENT } from "@plannotator/core/inbox-review";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { isReviewDrawCommand, parseReviewDrawCommand, runReviewDrawCommand } from "./review-draw-command";
import { formatSubcommandHelp } from "./cli";

const roots: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-draw-cli-")));
  roots.push(root);
  return root;
}

const REVIEW = "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F";

describe("parse", () => {
  test("only `review draw` and `review drawings` of their own shape are ours; `review <DIRECTORY>` stays a review", () => {
    for (const argv of [["review", "draw", "--help"], ["review", "draw", "--file", "a.json"], ["review", "draw", "--turn=t"], ["review", "drawings", REVIEW], ["review", "drawings", "-h"]]) {
      expect(isReviewDrawCommand(argv, () => true)).toBe(true);
    }
    // A folder named draw or drawings, a PR URL, a plain review: the review parse's, as before Show me.
    for (const argv of [["review"], ["review", "origin/main"], ["review", "draw"], ["review", "drawings"], ["review", "drawings", "./drawings"], ["review", "draw", "src"], ["review", "drawings", "https://example.com/o/r/pull/1"]]) {
      expect(isReviewDrawCommand(argv, () => true)).toBe(false);
    }
  });

  test("draw needs all three flags, once each; drawings one id", () => {
    expect(parseReviewDrawCommand(["draw", "--file", "a.json", "--review", REVIEW, "--turn", "turn-0001"])).toEqual({ ok: true, op: "draw", file: "a.json", review: REVIEW, turn: "turn-0001" });
    expect(parseReviewDrawCommand(["draw", "--file=a.json", "--review=m", "--turn=t"])).toMatchObject({ ok: true, file: "a.json" });
    expect(parseReviewDrawCommand(["draw", "--file", "a.json"])).toMatchObject({ ok: false });
    expect(parseReviewDrawCommand(["draw", "--file", "a", "--file", "b", "--review", "m", "--turn", "t"])).toMatchObject({ ok: false });
    expect(parseReviewDrawCommand(["draw", "--file", "a", "--review", "m", "--turn", "t", "--json"])).toMatchObject({ ok: false });
    expect(parseReviewDrawCommand(["drawings"])).toMatchObject({ ok: false });
    expect(parseReviewDrawCommand(["drawings", REVIEW, "extra"])).toMatchObject({ ok: false });
    expect(parseReviewDrawCommand(["draw", "--help"])).toEqual({ ok: true, op: "help" });
  });
});

/** A fake Inbox: records what reached it and answers `answer`. */
function fakeInbox(answer: (req: Request, body: unknown) => Response) {
  const seen: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = req.method === "POST" ? await req.json() : undefined;
      seen.push({ method: req.method, path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body });
      return answer(req, body);
    },
  });
  stops.push(() => server.stop(true));
  const entry = { v: 1, pid: process.pid, port: server.port, url: `http://127.0.0.1:${server.port}`, version: "test", token: "tok-123", serverSession: "s", startedAt: new Date().toISOString() } as InboxRegistryEntry;
  return { seen, ensureRunning: async () => entry };
}

async function run(argv: string[], deps: { cwd: string; ensureRunning: () => Promise<InboxRegistryEntry>; env?: Record<string, string | undefined> }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runReviewDrawCommand(argv, { ...deps, stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("run", () => {
  test("draw reads the file, posts it with the token, and says Sent", async () => {
    const root = scratch();
    const drawing = { kind: "html", source: "<div/>", css: ".a{}" };
    writeFileSync(join(root, "show-me.json"), JSON.stringify(drawing));
    const inbox = fakeInbox(() => Response.json({ ok: true, drawing: { id: "drw_1" } }));
    const r = await run(["draw", "--file", "show-me.json", "--review", REVIEW, "--turn", "turn-0001"], { cwd: root, ensureRunning: inbox.ensureRunning });
    expect(r).toEqual({ code: 0, stdout: INBOX_REVIEW_DRAW_SENT, stderr: "" });
    expect(inbox.seen).toEqual([{ method: "POST", path: `/api/inbox/reviews/${REVIEW}/drawings`, auth: "Bearer tok-123", body: { turn: "turn-0001", drawing } }]);
  });

  test("inside an agent host session, the drawing names that session (the Inbox draws only the turn's own)", async () => {
    const root = scratch();
    writeFileSync(join(root, "d.json"), JSON.stringify({ kind: "html", source: "<div/>" }));
    const inbox = fakeInbox(() => Response.json({ ok: true, drawing: { id: "drw_1" } }));
    const r = await run(["draw", "--file", "d.json", "--review", REVIEW, "--turn", "turn-0001"], { cwd: root, ensureRunning: inbox.ensureRunning, env: { PI_SESSION_ID: "pi-session-0001" } });
    expect(r.code).toBe(0);
    expect(inbox.seen[0]!.body).toMatchObject({ turn: "turn-0001", session: "pi-session-0001" });
  });

  test("a file that is not JSON is refused before the Inbox is reached; bad usage exits 2 with the help", async () => {
    const root = scratch();
    writeFileSync(join(root, "bad.json"), "{ nope");
    const inbox = fakeInbox(() => Response.json({}));
    const bad = await run(["draw", "--file", "bad.json", "--review", REVIEW, "--turn", "turn-0001"], { cwd: root, ensureRunning: inbox.ensureRunning });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toStartWith(`invalid: could not read ${join(root, "bad.json")}`);
    const usage = await run(["draw", "--file", "bad.json"], { cwd: root, ensureRunning: inbox.ensureRunning });
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain(INBOX_REVIEW_DRAW_HELP);
    expect(inbox.seen).toEqual([]);
  });

  test("refusals: `<code>: <message>` on stderr, every problem listed, exit 1", async () => {
    const root = scratch();
    writeFileSync(join(root, "d.json"), "{}");
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [409, { code: "code_review_off" }, INBOX_REVIEW_CODE_REVIEW_OFF],
      [404, { code: "not_found" }, `not_found: No review ${REVIEW} here.`],
      [409, { code: "not_a_review" }, `not_a_review: ${REVIEW} is not a review you sent.`],
      [409, { code: "turn_unknown" }, "turn_unknown: turn-0001 is not a Show me in this review's thread."],
      [409, { code: "turn_stopped" }, "turn_stopped: The reviewer stopped turn-0001; it takes no drawing."],
      [409, { code: "drawing_exists" }, "drawing_exists: turn-0001 already has its drawing; a Show me takes one."],
      [422, { code: "invalid", problems: ["source: no scripts", "width: must be a whole number from 200 to 4000"] }, "invalid: the drawing has problems:\n  - source: no scripts\n  - width: must be a whole number from 200 to 4000"],
    ];
    for (const [status, body, line] of cases) {
      const one = fakeInbox(() => Response.json(body, { status }));
      const r = await run(["draw", "--file", "d.json", "--review", REVIEW, "--turn", "turn-0001"], { cwd: root, ensureRunning: one.ensureRunning });
      expect(r).toEqual({ code: 1, stdout: "", stderr: line });
      expect(one.seen).toHaveLength(1);
    }
  });

  test("drawings: one line per drawing, the overview's first", async () => {
    const inbox = fakeInbox(() =>
      Response.json({
        serverSession: "s",
        title: "T",
        round: 1,
        overview: { round: 1, codes: ["src/charges/schedule.ts#L6-L10", "src/jobs/retry-worker.ts#L9-L18"] },
        drawings: [{ id: "drw_1", turn: "t", file: "src/jobs/retry-worker.ts", lines: [16, 18], round: 1, view: { html: '<i data-code="src/jobs/retry-worker.ts#L16-L18"></i><i data-code="src/email/dunning.ts#L4-L9"></i>' }, at: "x" }],
      }),
    );
    const r = await run(["drawings", REVIEW], { cwd: scratch(), ensureRunning: inbox.ensureRunning });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      [
        "overview · round 1 · with the guide · src/charges/schedule.ts#L6-L10, src/jobs/retry-worker.ts#L9-L18",
        "show me · round 1 · retry-worker.ts lines 16–18 · src/jobs/retry-worker.ts#L16-L18, src/email/dunning.ts#L4-L9",
      ].join("\n"),
    );
    expect(inbox.seen).toEqual([{ method: "GET", path: `/api/inbox/reviews/${REVIEW}/drawings`, auth: "Bearer tok-123", body: undefined }]);
  });
});

describe("the Code review switch, through the entrypoint", () => {
  // Guards the gate in apps/hook/server/index.ts: off (config.json `inboxCodeReview` unset or false), `plannotator
  // review draw|drawings --help` is `plannotator review --help`, as before Show me (the other forms are the review
  // parse's too: show-me-off.test.ts pins the dispatch). On, help is the command's.
  test("off: `review draw --help` is the review's help; on: --help prints the format", async () => {
    const { removeStubbedHtml, stubHookDistHtml } = await import("../../../tests/helpers/hook-dist-stub");
    const { NO_BROWSER } = await import("../../../tests/helpers/no-browser");
    const root = scratch();
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(root, "d.json"), "{}");
    const stubbed = stubHookDistHtml();
    const entry = join(import.meta.dir, "index.ts");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME!,
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      NO_BROWSER: "1",
      NO_ANON_PING: "1",
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_TEST_SANDBOX: "1",
    };
    const cli = async (...argv: string[]) => {
      const proc = Bun.spawn(["bun", "run", entry, "review", ...argv], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    try {
      for (const config of [null, { inboxCodeReview: false }]) {
        if (config) writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
        for (const argv of [["draw", "--help"], ["drawings", "--help"]]) {
          const r = await cli(...argv);
          expect(r).toEqual({ code: 0, stdout: `${formatSubcommandHelp("review")}\n`, stderr: "" });
        }
      }
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxCodeReview: true }));
      const help = await cli("draw", "--help");
      expect(help.code, help.stderr).toBe(0);
      expect(help.stdout).toBe(`${INBOX_REVIEW_DRAW_HELP}\n`);
    } finally {
      removeStubbedHtml(stubbed);
    }
  }, 60_000);
});
