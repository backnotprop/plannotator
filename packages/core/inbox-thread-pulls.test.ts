/**
 * A thread's PRs, the pure part (approval "inbox-pr-binding", 2026-11-08).
 * The failures these guard: a bare `#123` (no repository) that gets coupled
 * to some guessed repo instead of refused with how to write it; a GitLab MR
 * read as a GitHub PR (or the other way); one bad ref in a list that still
 * lets the good ones through; a stack shown out of order or mixed with
 * related PRs; and a row's mark that shows a merged PR while one is still
 * open.
 */
import { describe, expect, test } from "bun:test";
import {
  inboxThreadPullGroups,
  inboxThreadPullHeadline,
  inboxThreadPullRefError,
  inboxThreadPullsSummary,
  inboxThreadPullText,
  parseInboxThreadPullRef,
  parseInboxThreadPullRefs,
  type InboxThreadPull,
  type InboxThreadPullState,
} from "./inbox-thread-pulls";

describe("refs", () => {
  test("owner/repo#n, group/sub/project!n and both forges' URLs read; the key tells GitHub from GitLab", () => {
    const gh = parseInboxThreadPullRef("northwind/billing-svc#412");
    expect("key" in gh && gh.key).toBe("github.com/northwind/billing-svc#412");
    expect("url" in gh && gh.url).toBe("https://github.com/northwind/billing-svc/pull/412");
    const gl = parseInboxThreadPullRef("acme/platform/api!61");
    expect("key" in gl && gl.key).toBe("gitlab.com/acme/platform/api#61:pull");
    expect("url" in gl && gl.url).toBe("https://gitlab.com/acme/platform/api/-/merge_requests/61");
    const ghUrl = parseInboxThreadPullRef("https://github.com/Northwind/Billing-Svc/pull/412/files");
    expect("key" in ghUrl && ghUrl.key).toBe("github.com/northwind/billing-svc#412");
    const glUrl = parseInboxThreadPullRef("https://gitlab.com/acme/platform/api/-/merge_requests/61");
    expect("key" in glUrl && glUrl.key).toBe("gitlab.com/acme/platform/api#61:pull");
  });

  test("a short group/project!n is on the project's own GitLab host; a URL keeps its host, and owner/repo#n stays on github.com", () => {
    const keyOf = (text: string, host?: string | null) => {
      const parsed = parseInboxThreadPullRef(text, host);
      return "key" in parsed ? [parsed.key, parsed.url] : parsed.error;
    };
    for (const host of ["gitlab.acme.dev", "GitLab.Acme.Dev:2222", "code.gitlab.acme.dev"]) {
      const at = host.toLowerCase().replace(/:\d+$/, "");
      expect(keyOf("acme/platform/api!61", host)).toEqual([`${at}/acme/platform/api#61:pull`, `https://${at}/acme/platform/api/-/merge_requests/61`]);
    }
    // gitlab.com's own aliases, a GitHub project, an unknown self-hosted name, no remote: gitlab.com as before.
    for (const host of [undefined, null, "gitlab.com", "altssh.gitlab.com", "github.com", "github.acme.dev", "git.acme.internal", "work-gl"]) {
      expect(keyOf("acme/platform/api!61", host)).toEqual(["gitlab.com/acme/platform/api#61:pull", "https://gitlab.com/acme/platform/api/-/merge_requests/61"]);
    }
    expect(keyOf("https://gitlab.com/acme/platform/api/-/merge_requests/61", "gitlab.acme.dev")).toEqual(["gitlab.com/acme/platform/api#61:pull", "https://gitlab.com/acme/platform/api/-/merge_requests/61"]);
    expect(keyOf("https://gitlab.other.dev/a/b/-/merge_requests/2", "gitlab.acme.dev")).toEqual(["gitlab.other.dev/a/b#2:pull", "https://gitlab.other.dev/a/b/-/merge_requests/2"]);
    expect(keyOf("northwind/billing-svc#412", "gitlab.acme.dev")).toEqual(["github.com/northwind/billing-svc#412", "https://github.com/northwind/billing-svc/pull/412"]);
    const list = parseInboxThreadPullRefs(["acme/api!3", "https://gitlab.acme.dev/acme/api/-/merge_requests/3"], "add", "gitlab.acme.dev");
    expect("refs" in list && list.refs.map((ref) => ref.key)).toEqual(["gitlab.acme.dev/acme/api#3:pull"]);
    // Written back as its URL: the short form would read as gitlab.com in a thread of another project.
    expect(inboxThreadPullText({ pull: "gitlab.acme.dev/acme/api#3:pull", url: "https://gitlab.acme.dev/acme/api/-/merge_requests/3" })).toBe("https://gitlab.acme.dev/acme/api/-/merge_requests/3");
  });

  test("a bare #123, an issue URL or a repo alone is refused with how to write a full ref", () => {
    for (const text of ["#123", "123", "billing-svc#412", "https://github.com/northwind/billing-svc/issues/9", "northwind/billing-svc"]) {
      const parsed = parseInboxThreadPullRef(text);
      expect(parsed).toEqual({ error: inboxThreadPullRefError(text) });
    }
    expect(inboxThreadPullRefError("#123")).toBe("'#123' is not a full PR ref. Write owner/repo#123, group/project!45 or the PR's URL; nothing was changed.");
  });

  test("a list reads each PR once, and one bad ref refuses the whole list, naming its place", () => {
    const ok = parseInboxThreadPullRefs(["o/r#1", "https://github.com/o/r/pull/1", "o/r#2"], "add");
    expect("refs" in ok && ok.refs.map((ref) => ref.key)).toEqual(["github.com/o/r#1", "github.com/o/r#2"]);
    expect(parseInboxThreadPullRefs(["o/r#1", "#2"], "add")).toEqual({ error: inboxThreadPullRefError("#2"), field: "add[1]" });
    expect(parseInboxThreadPullRefs("o/r#1", "pulls")).toMatchObject({ field: "pulls" });
  });

  test("a stored PR is written back as an agent writes it", () => {
    expect(inboxThreadPullText({ pull: "github.com/northwind/billing-svc#412", url: "https://github.com/northwind/billing-svc/pull/412" })).toBe("northwind/billing-svc#412");
    expect(inboxThreadPullText({ pull: "gitlab.com/acme/platform/api#61:pull", url: "https://gitlab.com/acme/platform/api/-/merge_requests/61" })).toBe("acme/platform/api!61");
  });
});

let n = 0;
function pull(ref: string, state: InboxThreadPullState, base: string | null = "main", head: string | null = null): InboxThreadPull {
  const parsed = parseInboxThreadPullRef(ref);
  if (!("key" in parsed)) throw new Error(ref);
  n += 1;
  return {
    id: `msg_t:${parsed.key}`,
    project_id: "prj_a",
    thread_id: "msg_t",
    pull: parsed.key,
    url: parsed.url,
    added_by: { kind: "person" },
    added_at: new Date(Date.UTC(2026, 10, 8, 10, n)).toISOString(),
    state,
    title: null,
    base,
    head: head ?? `branch-${n}`,
    read_at: null,
  };
}

describe("stacks, related and the headline", () => {
  test("a chain in one repository is one stack, base first, whatever order it was added in; the rest are related in added order", () => {
    const top = pull("o/r#3", "draft", "worker", "writers");
    const other = pull("o/web#9", "open");
    const base = pull("o/r#1", "merged", "main", "schema");
    const middle = pull("o/r#2", "open", "schema", "worker");
    const lone = pull("o/r#5", "open", "main", "lone");
    const groups = inboxThreadPullGroups([top, other, base, middle, lone]);
    expect(groups).toEqual([
      { kind: "stack", pulls: [base.pull, middle.pull, top.pull] },
      { kind: "related", pulls: [other.pull, lone.pull] },
    ]);
  });

  test("with no base or head known, every PR is related", () => {
    const a = pull("o/r#1", "unknown", null);
    const b = pull("o/r#2", "unknown", null);
    expect(inboxThreadPullGroups([a, b])).toEqual([{ kind: "related", pulls: [a.pull, b.pull] }]);
  });

  test("the mark shows the first PR still open or a draft, stacks first; with all done, the last", () => {
    const merged = pull("o/r#1", "merged", "main", "a");
    const open = pull("o/r#2", "open", "a", "b");
    const related = pull("o/x#4", "open");
    expect(inboxThreadPullsSummary([related, merged, open])).toEqual({ count: 3, headline: { key: open.pull, state: "open" } });
    const closed = pull("o/r#7", "closed");
    const done = pull("o/r#8", "merged");
    expect(inboxThreadPullHeadline([closed, done], inboxThreadPullGroups([closed, done]))?.pull).toBe(done.pull);
    expect(inboxThreadPullsSummary([])).toBeUndefined();
  });
});
