import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxReviewLinkOf } from "@plannotator/core/inbox-types";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import type { RefRunner } from "@plannotator/shared/ref-cards";
import { createInboxPullLinks } from "./inbox-pull-links";
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

  test("an address on its host but not on the web isn't one either", async () => {
    expect(await readInboxReviewLink(forge(answer({ html_url: "javascript://github.com/o/app/pull/8" })).run, github, "dana")).toBeNull();
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

test("a GitLab fork, which its answer can't name, still reads as another repository", async () => {
  const gitlab = linkOf("https://gitlab.com/o/app/-/merge_requests/8");
  const mr = (source: number, target: number) => ({ state: "opened", title: "T", web_url: "https://gitlab.com/o/app/-/merge_requests/8", author: { username: "dana" }, source_project_id: source, target_project_id: target });
  expect((await readInboxReviewLink(forge(mr(2, 1)).run, gitlab, "dana"))?.head_repo).not.toBeNull();
  expect((await readInboxReviewLink(forge(mr(1, 1)).run, gitlab, "dana"))?.head_repo).toBeNull();
});

test("a landing written before a key was the list's own still matches the PR", () => {
  const dir = mkdtempSync(join(tmpdir(), "inbox-links-"));
  const of = (key: string, platform: string, thread_id: string) => ({ key, platform, thread_id, state: "merged", url: "https://x/y", number: 8, at: "2026-11-01T00:00:00Z" });
  const old = [of("gitlab.com/o/app#8", "gitlab", "t1"), of("github.com/Acme/Caps#8", "github", "t2"), of("github.com/o/app#8", "github", "t3")];
  mkdirSync(inboxDir(dir), { recursive: true });
  writeFileSync(join(inboxDir(dir), "pull-links.json"), JSON.stringify({ v: 1, links: {}, landed: Object.fromEntries(old.map((landing) => [`${landing.thread_id}\u0000${landing.key}`, landing])) }));
  expect(createInboxPullLinks(dir).landings().map((landing) => landing.key).sort()).toEqual(["github.com/acme/caps#8", "github.com/o/app#8", "gitlab.com/o/app#8:pull"]);
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
