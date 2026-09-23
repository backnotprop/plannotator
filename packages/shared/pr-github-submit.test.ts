import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { githubErrorDetail, submitGhPRReview } from "./pr-github";
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
const isGet = (c: Call) => c.args[1] === `${REVIEWS}/99` && c.args.length === 2;

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

describe("submitGhPRReview file-level edge cases", () => {
  test("an unreadable pending-review reply is reported as a possibly remaining pending review", async () => {
    const { runtime, calls } = ghRuntime((c) => (isCreate(c) ? ok("not json") : undefined));
    await expect(
      submitGhPRReview(runtime, REF, "sha", "comment", "Body", [LINE], [FILE_A]),
    ).rejects.toThrow("A pending review remains on the pull request; submit or discard it on GitHub");
    expect(calls).toHaveLength(1); // no second review posted on top of it
  });

  test("a COMMENT with an empty body gets the placeholder body GitHub requires", async () => {
    const { runtime, calls } = ghRuntime((c) => {
      if (isCreate(c)) return PENDING;
      if (isGraphql(c)) return THREAD_OK;
      if (isSubmit(c)) return ok("{}");
    });
    await submitGhPRReview(runtime, REF, "sha", "comment", "  ", [], [FILE_A]);
    expect(calls.find(isSubmit)!.input).toEqual({ event: "COMMENT", body: "See inline comments." });
  });

  test("a submit whose response was lost but which GitHub shows as submitted is a success", async () => {
    const { runtime, calls } = ghRuntime((c) => {
      if (isCreate(c)) return PENDING;
      if (isGraphql(c)) return THREAD_OK;
      if (isSubmit(c)) return fail("connection reset");
      if (isGet(c)) return ok(JSON.stringify({ id: 99, state: "COMMENTED" }));
    });
    await expect(
      submitGhPRReview(runtime, REF, "sha", "comment", "Body", [], [FILE_A]),
    ).resolves.toEqual({ status: "complete" });
    expect(calls.some(isDelete)).toBe(false);
  });

  test("when the fallback single call also fails, it reports that failure and claims no body fallback", async () => {
    const { runtime } = ghRuntime((c) => (isCreate(c) ? fail("HTTP 422: line must be part of the diff") : undefined));
    await expect(
      submitGhPRReview(runtime, REF, "sha", "comment", "Body", [LINE], [FILE_A]),
    ).rejects.toThrow("Failed to submit PR review: HTTP 422: line must be part of the diff");
    const logged = errorSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).not.toContain("review body");
  });
});

// The exact shapes `gh api` produces on a GitHub 422: the generic status line
// on stderr, GitHub's JSON body (with the actual reason) on stdout.
const DOCS = "https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request";
const gh422 = (errors: unknown[], message = "Unprocessable Entity"): CommandResult => ({
  stdout: JSON.stringify({ message, errors, documentation_url: DOCS, status: "422" }),
  stderr: message === "Validation Failed" ? "gh: Validation Failed (HTTP 422)" : "gh: Unprocessable Entity (HTTP 422)",
  exitCode: 1,
});
const SELF_APPROVE = gh422(["Can not approve your own pull request"]);
const ONE_PENDING = gh422(["User can only have one pending review per pull request"]);

describe("GitHub refusal reasons reach the error", () => {
  test("single-call path: the reason follows gh's status line, with no raw JSON", async () => {
    const { runtime } = ghRuntime((c) => (isCreate(c) ? SELF_APPROVE : undefined));
    const error = await submitGhPRReview(runtime, REF, "sha", "approve", "", [LINE]).catch((e: Error) => e);
    expect((error as Error).message).toBe(
      "Failed to submit PR review: gh: Unprocessable Entity (HTTP 422): Can not approve your own pull request",
    );
  });

  test("pending create refused and fallback refused: the fallback's reason is reported", async () => {
    const { runtime } = ghRuntime((c) => (isCreate(c) ? ONE_PENDING : undefined));
    await expect(
      submitGhPRReview(runtime, REF, "sha", "comment", "Body", [LINE], [FILE_A]),
    ).rejects.toThrow("User can only have one pending review per pull request");
  });

  test("a refused final submit reports GitHub's reason", async () => {
    const { runtime } = ghRuntime((c) => {
      if (isCreate(c)) return PENDING;
      if (isGraphql(c)) return THREAD_OK;
      if (isSubmit(c)) return SELF_APPROVE;
      if (isGet(c)) return ok(JSON.stringify({ id: 99, state: "PENDING" }));
      if (isDelete(c)) return ok("{}");
    });
    const error = await submitGhPRReview(runtime, REF, "sha", "approve", "", [], [FILE_A]).catch((e: Error) => e);
    expect((error as Error).message).toContain("Can not approve your own pull request");
    expect((error as Error).message).not.toContain("documentation_url");
  });

  test("Validation Failed with object errors surfaces each message", async () => {
    const { runtime } = ghRuntime((c) => (isCreate(c)
      ? gh422([{ resource: "PullRequestReview", code: "custom", message: "Line could not be resolved" }], "Validation Failed")
      : undefined));
    await expect(submitGhPRReview(runtime, REF, "sha", "comment", "Body", [LINE])).rejects.toThrow(
      "gh: Validation Failed (HTTP 422): Line could not be resolved",
    );
  });

  test("a GraphQL error on a file thread is logged by its message, not as JSON", async () => {
    const { runtime } = ghRuntime((c) => {
      if (isCreate(c)) return PENDING;
      if (isGraphql(c)) {
        return ok(JSON.stringify({
          data: { addPullRequestReviewThread: null },
          errors: [{ type: "UNPROCESSABLE", path: ["addPullRequestReviewThread"], message: "Path could not be resolved" }],
        }));
      }
      if (isSubmit(c)) return ok("{}");
    });
    await submitGhPRReview(runtime, REF, "sha", "comment", "Body", [], [FILE_GONE]);
    const logged = errorSpy.mock.calls.map((args) => String(args[0])).find((line) => line.includes(FILE_GONE.path))!;
    expect(logged).toContain("(Path could not be resolved)");
    expect(logged).not.toContain("{");
  });

  test("githubErrorDetail ignores non-JSON output and caps long reasons", () => {
    expect(githubErrorDetail("gh: not found")).toBeUndefined();
    expect(githubErrorDetail(JSON.stringify({ id: 1 }))).toBeUndefined();
    expect(githubErrorDetail(JSON.stringify({ errors: ["x".repeat(1000)] }))!.length).toBeLessThanOrEqual(300);
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
