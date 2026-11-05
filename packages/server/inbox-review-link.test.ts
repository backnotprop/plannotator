/**
 * A pull request link's one read: what a forge's answer may claim, and whose PR it is. No Inbox here: the read alone,
 * on a fake CLI.
 */
import { describe, expect, test } from "bun:test";
import { inboxReviewLinkOf } from "@plannotator/core/inbox-types";
import type { RefRunner } from "@plannotator/shared/ref-cards";
import { readInboxReviewLink } from "./inbox-reviews";

const linkOf = (text: string) => inboxReviewLinkOf(text) as Extract<ReturnType<typeof inboxReviewLinkOf>, { url: string }>;
const github = linkOf("https://github.com/o/app/pull/8");
const answer = (over: Record<string, unknown> = {}) => ({ state: "open", title: "T", html_url: "https://github.com/o/app/pull/8", head: { ref: "b", sha: "abc" }, base: { ref: "main" }, user: { login: "dana" }, ...over });
const forge = (pr: unknown, user: unknown = { login: "dana" }) => {
  const calls: string[] = [];
  const run: RefRunner = async (_cli, args) => {
    calls.push(args.at(-1)!);
    const body = args.at(-1) === "user" ? user : pr;
    return body === null ? { stdout: "", stderr: "no", exitCode: 1 } : { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
  };
  return { run, calls };
};

describe("a host speaks only for itself", () => {
  test("an answer whose address is on another host is no answer", async () => {
    for (const html_url of ["https://evil.example/o/app/pull/8", "https://github.com.evil.example/o/app/pull/8", "not a url"]) {
      expect(await readInboxReviewLink(forge(answer({ html_url })).run, github, "dana")).toBeNull();
    }
  });

  test("its own address, in any capitals, is read", async () => {
    expect(await readInboxReviewLink(forge(answer({ html_url: "https://GitHub.com/o/app/pull/8" })).run, github, "dana")).toMatchObject({ number: 8, head_sha: "abc" });
  });
});

test("a fork keeps its repository, for the words about pushing", async () => {
  const fork = answer({ head: { ref: "b", sha: "abc", repo: { full_name: "dana/app" } } });
  expect((await readInboxReviewLink(forge(fork).run, github, "dana"))?.head_repo).toBe("dana/app");
  expect((await readInboxReviewLink(forge(answer()).run, github, "dana"))?.head_repo).toBeNull();
});

describe("whose PR it is", () => {
  test("with no list read yet, the CLI says who the person is", async () => {
    const { run, calls } = forge(answer());
    expect((await readInboxReviewLink(run, github, null))?.mine).toBe(true);
    expect(calls).toContain("user");
  });

  test("a list's login is used without asking again", async () => {
    const { run, calls } = forge(answer());
    expect((await readInboxReviewLink(run, github, "dana"))?.mine).toBe(true);
    expect(calls).not.toContain("user");
  });

  test("someone else's stays theirs, GitLab's username counts, and a CLI that won't say isn't a claim of yours", async () => {
    expect((await readInboxReviewLink(forge(answer({ user: { login: "tomas" } })).run, github, "dana"))?.mine).toBe(false);
    const gitlab = linkOf("https://gitlab.com/o/app/-/merge_requests/8");
    const mr = { state: "opened", title: "T", web_url: "https://gitlab.com/o/app/-/merge_requests/8", sha: "def", author: { username: "dana" } };
    expect(await readInboxReviewLink(forge(mr, { username: "dana" }).run, gitlab, null)).toMatchObject({ mine: true, head_sha: "def" });
    expect((await readInboxReviewLink(forge(answer(), null).run, github, null))?.mine).toBe(false);
  });
});
