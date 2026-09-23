import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { submitGhPRReview } from "./pr-github";
import { submitPRReview } from "./pr-provider";
import type { CommandResult, PRReviewFileComment, PRReviewFileLevelComment, PRRuntime } from "./pr-types";

const REF = { platform: "github" as const, host: "github.com", owner: "o", repo: "r", number: 7 };
const REVIEWS = "repos/o/r/pulls/7/reviews";
const LINE: PRReviewFileComment = { path: "src/a.ts", line: 3, side: "RIGHT", body: "Line remark" };
const FILE_A: PRReviewFileLevelComment = { path: "src/a.ts", body: "Split this file." };
const FILE_GONE: PRReviewFileLevelComment = { path: "src/gone.ts", body: "Why is this here?" };

interface Call { args: string[]; input?: any }
type Handler = (call: Call) => CommandResult | undefined;

const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): CommandResult => ({ stdout: "", stderr, exitCode: 1 });

/** Fake gh runtime: records every call and answers through `handle`. */
function ghRuntime(handle: Handler): { runtime: PRRuntime; calls: Call[] } {
  const calls: Call[] = [];
  const answer = (call: Call) => {
    calls.push(call);
    return handle(call) ?? fail(`unexpected: ${call.args.join(" ")}`);
  };
  return {
    calls,
    runtime: {
      async runCommand(_cmd, args) { return answer({ args }); },
      async runCommandWithInput(_cmd, args, input) { return answer({ args, input: JSON.parse(input) }); },
    },
  };
}

const isGraphql = (c: Call) => c.args[1] === "graphql";
const isCreate = (c: Call) => c.args[1] === REVIEWS;
const isSubmit = (c: Call) => c.args[1] === `${REVIEWS}/99/events`;
const isDelete = (c: Call) => c.args[1] === `${REVIEWS}/99` && c.args.includes("DELETE");

const PENDING = ok(JSON.stringify({ id: 99, node_id: "PRR_99" }));
const THREAD_OK = ok(JSON.stringify({ data: { addPullRequestReviewThread: { thread: { id: "PRRT_1" } } } }));

let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => { errorSpy = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errorSpy.mockRestore(); });

describe("submitGhPRReview file-level comments (#1599)", () => {
  test("without file-level comments it is still one atomic create-review call", async () => {
    const { runtime, calls } = ghRuntime((c) => (isCreate(c) ? ok("{}") : undefined));
    await expect(submitGhPRReview(runtime, REF, "sha", "comment", "Body", [LINE])).resolves.toEqual({ status: "complete" });
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ commit_id: "sha", body: "Body", event: "COMMENT", comments: [LINE] });
  });

  test("builds one review: pending with line comments, a FILE thread per comment, then submit", async () => {
    const { runtime, calls } = ghRuntime((c) => {
      if (isCreate(c)) return PENDING;
      if (isGraphql(c)) return THREAD_OK;
      if (isSubmit(c)) return ok("{}");
    });
    await expect(
      submitGhPRReview(runtime, REF, "sha", "approve", "Body", [LINE], [FILE_A, FILE_GONE]),
    ).resolves.toEqual({ status: "complete" });

    const [create, t1, t2, submit] = calls;
    expect(calls).toHaveLength(4);
    expect(create.input).toEqual({ commit_id: "sha", comments: [LINE] }); // no event: pending
    for (const [thread, comment] of [[t1, FILE_A], [t2, FILE_GONE]] as const) {
      expect(thread.input.query).toContain("subjectType: FILE");
      expect(thread.input.variables).toEqual({ reviewId: "PRR_99", path: comment.path, body: comment.body });
    }
    expect(submit.input).toEqual({ event: "APPROVE", body: "Body" });
  });

  test("a file comment GitHub rejects is posted in the review body instead of lost", async () => {
    const { runtime, calls } = ghRuntime((c) => {
      if (isCreate(c)) return PENDING;
      if (isGraphql(c)) {
        return c.input.variables.path === FILE_GONE.path
          ? ok(JSON.stringify({ data: { addPullRequestReviewThread: null }, errors: [{ message: "Path could not be resolved" }] }))
          : THREAD_OK;
      }
      if (isSubmit(c)) return ok("{}");
    });
    await submitGhPRReview(runtime, REF, "sha", "comment", "Body", [], [FILE_A, FILE_GONE]);
    const submit = calls.find(isSubmit)!;
    expect(submit.input.body).toBe("Body\n\n**src/gone.ts:** Why is this here?");
  });

  test("when the pending review cannot be created, it falls back to the single call with comments in the body", async () => {
    const { runtime, calls } = ghRuntime((c) => {
      if (isCreate(c) && c.input.event === undefined) return fail("HTTP 422: User can only have one pending review");
      if (isCreate(c)) return ok("{}");
    });
    await expect(
      submitGhPRReview(runtime, REF, "sha", "comment", "Body", [LINE], [FILE_A]),
    ).resolves.toEqual({ status: "complete" });
    expect(calls).toHaveLength(2);
    expect(calls[1].input).toEqual({
      commit_id: "sha",
      body: "Body\n\n**src/a.ts:** Split this file.",
      event: "COMMENT",
      comments: [LINE],
    });
  });

  test("a failed submit discards the pending review and reports the failure", async () => {
    const { runtime, calls } = ghRuntime((c) => {
      if (isCreate(c)) return PENDING;
      if (isGraphql(c)) return THREAD_OK;
      if (isSubmit(c)) return fail("HTTP 422: Can not approve your own pull request");
      if (isDelete(c)) return ok("{}");
    });
    await expect(
      submitGhPRReview(runtime, REF, "sha", "approve", "", [], [FILE_A]),
    ).rejects.toThrow("Can not approve your own pull request");
    expect(calls.some(isDelete)).toBe(true);
  });

  test("if the pending review cannot be discarded either, the error says so", async () => {
    const { runtime } = ghRuntime((c) => {
      if (isCreate(c)) return PENDING;
      if (isGraphql(c)) return THREAD_OK;
      if (isSubmit(c)) return fail("HTTP 502");
      if (isDelete(c)) return fail("HTTP 502");
    });
    await expect(
      submitGhPRReview(runtime, REF, "sha", "comment", "Body", [], [FILE_A]),
    ).rejects.toThrow("pending review remains");
  });
});

describe("submitPRReview on GitLab", () => {
  test("file-level comments are folded into the MR note", async () => {
    const { runtime, calls } = ghRuntime((c) => (c.args.some((a) => a.endsWith("/notes")) ? ok("{}") : undefined));
    const GL_REF = { platform: "gitlab" as const, host: "gitlab.com", projectPath: "o/r", iid: 7 };
    await submitPRReview(runtime, GL_REF, "sha", "comment", "Body", [], [FILE_A]);
    expect(calls[0].input.body).toBe("Body\n\n**src/a.ts:** Split this file.");
  });
});
