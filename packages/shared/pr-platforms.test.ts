/**
 * The PR provider seam (#1583): URL detection, capabilities and the pure
 * helpers every platform shares. GitHub/GitLab behavior is pinned so adding a
 * third platform cannot change it.
 */
import { describe, expect, test } from "bun:test";
import {
  getCliName,
  getDisplayRepo,
  getForgejoOrigin,
  getMRNumberLabel,
  getPlatformLabel,
  getPRCloneCommand,
  getPRHeadFetchSpec,
  getPRNumber,
  getPRPlatformCapabilities,
  isSameProject,
  parsePRUrl,
  prRefFromMetadata,
  type BitbucketPRMetadata,
  type ForgejoPRMetadata,
  type PRMetadata,
} from "./pr-types";
import { prDraftTargetKey } from "./review-draft";

const bbMeta: BitbucketPRMetadata = {
  platform: "bitbucket",
  host: "bitbucket.org",
  workspace: "ws",
  repo: "repo",
  number: 7,
  title: "t",
  author: "a",
  baseBranch: "main",
  headBranch: "feature/x",
  baseSha: "b".repeat(40),
  headSha: "h".repeat(40),
  url: "https://bitbucket.org/ws/repo/pull-requests/7",
};

describe("parsePRUrl — Bitbucket Cloud", () => {
  test.each([
    "https://bitbucket.org/ws/repo/pull-requests/7",
    "https://bitbucket.org/ws/repo/pull-requests/7/diff",
    "https://bitbucket.org/ws/repo/pull-requests/7/overview?w=1",
    "https://www.bitbucket.org/ws/repo/pull-requests/7#comment-1",
  ])("%s", (url) => {
    expect(parsePRUrl(url)).toEqual({ platform: "bitbucket", host: "bitbucket.org", workspace: "ws", repo: "repo", number: 7 });
  });

  test("rejects non-PR Bitbucket URLs and Bitbucket Data Center's shape", () => {
    expect(parsePRUrl("https://bitbucket.org/ws/repo/src/main/")).toBeNull();
    expect(parsePRUrl("https://bitbucket.org/ws/repo/pull-requests/7abc")).toBeNull();
    // Data Center: a different URL and API, not supported.
    expect(parsePRUrl("https://git.corp.example/projects/P/repos/r/pull-requests/7")).toBeNull();
  });

  test("GitHub and GitLab URLs still parse as before", () => {
    expect(parsePRUrl("https://github.com/o/r/pull/3")?.platform).toBe("github");
    expect(parsePRUrl("https://gitlab.com/g/p/-/merge_requests/3")?.platform).toBe("gitlab");
  });
});

describe("helpers", () => {
  test("labels, number and repo for all three platforms", () => {
    const gh = parsePRUrl("https://github.com/o/r/pull/3")!;
    const gl = parsePRUrl("https://gitlab.com/g/p/-/merge_requests/4")!;
    const bb = parsePRUrl("https://bitbucket.org/ws/repo/pull-requests/5")!;
    expect([gh, gl, bb].map(getMRNumberLabel)).toEqual(["#3", "!4", "#5"]);
    expect([gh, gl, bb].map(getPRNumber)).toEqual([3, 4, 5]);
    expect([gh, gl, bb].map(getDisplayRepo)).toEqual(["o/r", "g/p", "ws/repo"]);
    expect([gh, gl, bb].map(getPlatformLabel)).toEqual(["GitHub", "GitLab", "Bitbucket"]);
    expect([gh, gl, bb].map(getCliName)).toEqual(["gh", "glab", ""]);
    expect(prRefFromMetadata(bbMeta)).toEqual({ platform: "bitbucket", host: "bitbucket.org", workspace: "ws", repo: "repo", number: 7 });
  });

  test("isSameProject treats Bitbucket slugs case-insensitively and never matches across platforms", () => {
    const a = parsePRUrl("https://bitbucket.org/WS/Repo/pull-requests/1")!;
    const b = parsePRUrl("https://bitbucket.org/ws/repo/pull-requests/2")!;
    expect(isSameProject(a, b)).toBe(true);
    expect(isSameProject(a, parsePRUrl("https://github.com/ws/repo/pull/1")!)).toBe(false);
  });

  test("capabilities: what the UI hides or maps per platform", () => {
    const pick = (platform: PRMetadata["platform"]) => {
      const c = getPRPlatformCapabilities({ platform });
      return [c.requestChanges, c.selfReviewBlocked, c.selfRequestChangesBlocked, c.viewedSync, c.fileLevelComments, c.agentCliAccess, c.artifacts];
    };
    expect(pick("github")).toEqual([true, true, true, true, true, true, true]);
    expect(pick("gitlab")).toEqual([true, false, false, false, true, true, true]);
    expect(pick("bitbucket")).toEqual([true, false, false, false, false, false, false]);
    // Forgejo refuses your own approval and request-changes (422), has no viewed sync or file-level comments, no CLI.
    expect(pick("forgejo")).toEqual([true, true, true, false, false, false, true]);
  });
});

describe("local checkout specs", () => {
  test("GitHub/GitLab fetch their PR head ref from origin, unchanged", () => {
    const gh = { ...bbMeta, platform: "github", owner: "o", repo: "r", number: 3 } as unknown as PRMetadata;
    const gl = { ...bbMeta, platform: "gitlab", projectPath: "g/p", iid: 4 } as unknown as PRMetadata;
    expect(getPRHeadFetchSpec(gh)).toEqual({ remote: null, ref: "refs/pull/3/head" });
    expect(getPRHeadFetchSpec(gl)).toEqual({ remote: null, ref: "refs/merge-requests/4/head" });
    expect(getPRCloneCommand(gh, "/d").argv).toEqual(["gh", "repo", "clone", "o/r", "/d", "--", "--depth=1", "--no-checkout"]);
  });

  test("Bitbucket fetches the source branch, from the fork when there is one", () => {
    expect(getPRHeadFetchSpec(bbMeta)).toEqual({ remote: null, ref: "refs/heads/feature/x" });
    expect(getPRHeadFetchSpec({ ...bbMeta, sourceRepo: "someone/repo-fork" })).toEqual({
      remote: "https://bitbucket.org/someone/repo-fork.git",
      ref: "refs/heads/feature/x",
    });
    // A branch name shaped like a flag is refused before it reaches git.
    expect(() => getPRHeadFetchSpec({ ...bbMeta, headBranch: "--upload-pack=x" })).toThrow("Invalid source branch");
  });

  test("the Bitbucket clone is plain git over https that never prompts", () => {
    const { argv, env } = getPRCloneCommand(bbMeta, "/tmp/x");
    expect(argv).toEqual(["git", "clone", "--depth=1", "--no-checkout", "--", "https://bitbucket.org/ws/repo.git", "/tmp/x"]);
    expect(env).toEqual({ GIT_TERMINAL_PROMPT: "0" });
  });
});

describe("prDraftTargetKey", () => {
  test("GitHub and GitLab keys are pinned: a changed key would orphan every saved PR draft", () => {
    const gh = { platform: "github", host: "github.com", owner: "Acme", repo: "Widgets", number: 42 } as PRMetadata;
    const gl = { platform: "gitlab", host: "gitlab.example.com", projectPath: "Group/Sub/Project", iid: 7 } as PRMetadata;
    // Values computed with the pre-Bitbucket implementation on main.
    expect(prDraftTargetKey(gh, "layer")).toBe("pr-89a0481ca8626ebf");
    expect(prDraftTargetKey(gh, "full-stack")).toBe("pr-5bafee1d6456631b");
    expect(prDraftTargetKey(gl, "layer")).toBe("pr-a2c74c0e94f2901e");
    expect(prDraftTargetKey(gl, "full-stack")).toBe("pr-bb259c21fae448bc");
  });

  test("Bitbucket keys are case-insensitive and never collide with a same-named GitHub PR", () => {
    const key = prDraftTargetKey(bbMeta, "layer");
    expect(prDraftTargetKey({ ...bbMeta, workspace: "WS", repo: "Repo" }, "layer")).toBe(key);
    const gh = { ...bbMeta, platform: "github", owner: "ws", repo: "repo", number: 7 } as unknown as PRMetadata;
    expect(prDraftTargetKey(gh, "layer")).not.toBe(key);
  });
});

const fjMeta: ForgejoPRMetadata = {
  platform: "forgejo",
  host: "forgejo.example.com",
  owner: "acme",
  repo: "widgets",
  number: 5,
  title: "t",
  author: "a",
  baseBranch: "main",
  headBranch: "feature/x",
  baseSha: "b".repeat(40),
  headSha: "h".repeat(40),
  url: "https://forgejo.example.com/acme/widgets/pulls/5",
};

describe("parsePRUrl — Forgejo / Gitea", () => {
  test.each([
    ["https://git.example.org/acme/widgets/pulls/5", { host: "git.example.org" }],
    ["https://forgejo.example.com/acme/widgets/pulls/5/files", { host: "forgejo.example.com" }],
    ["https://forgejo.example.com/acme/widgets/pulls/5/commits/abc123", { host: "forgejo.example.com" }],
    ["https://forgejo.example.com/acme/widgets/pulls/5?style=unified", { host: "forgejo.example.com" }],
    ["https://forgejo.example.com/acme/widgets/pulls/5#issuecomment-9", { host: "forgejo.example.com" }],
    // A port belongs to the host, not to a field of its own.
    ["https://forgejo.example.com:8443/acme/widgets/pulls/5", { host: "forgejo.example.com:8443" }],
    // A plain-http instance keeps its scheme; https never carries the field.
    ["http://forgejo.lan:3000/acme/widgets/pulls/5", { host: "forgejo.lan:3000", scheme: "http" }],
    ["http://192.168.1.5:3000/acme/widgets/pulls/5", { host: "192.168.1.5:3000", scheme: "http" }],
  ])("%s", (url, expected) => {
    expect(parsePRUrl(url)).toEqual({ platform: "forgejo", owner: "acme", repo: "widgets", number: 5, ...expected });
  });

  test("an https ref has no scheme key at all, so equality with a stored ref is unchanged", () => {
    expect("scheme" in parsePRUrl("https://forgejo.example.com/acme/widgets/pulls/5")!).toBe(false);
  });

  test("rejects what is not a Forgejo PR URL", () => {
    for (const url of [
      "https://forgejo.example.com/acme/widgets/pulls",
      "https://forgejo.example.com/acme/widgets/pulls/",
      "https://forgejo.example.com/acme/widgets/pulls/5abc",
      "https://forgejo.example.com/acme/widgets/issues/5",
      "https://forgejo.example.com/acme/pulls/5",
      "https://forgejo.example.com/a/b/c/pulls/5",
      "ftp://forgejo.example.com/acme/widgets/pulls/5",
      "forgejo.example.com/acme/widgets/pulls/5",
    ]) {
      expect(parsePRUrl(url)).toBeNull();
    }
  });

  test("a URL carrying credentials is not a Forgejo PR: the host must never hold a login", () => {
    expect(parsePRUrl("https://user:pass@forgejo.example.com/acme/widgets/pulls/5")).toBeNull();
    expect(parsePRUrl("https://user@forgejo.example.com/acme/widgets/pulls/5")).toBeNull();
  });

  test("GitHub's /pull/ and GitLab's merge-request URLs are not taken for Forgejo", () => {
    expect(parsePRUrl("https://github.com/acme/widgets/pull/5")?.platform).toBe("github");
    expect(parsePRUrl("https://gitlab.example.com/acme/widgets/-/merge_requests/5")?.platform).toBe("gitlab");
  });
});

/**
 * Every host's URL forms, real shapes, with what each parses to. The rows for
 * GitHub, GitLab and Bitbucket are what parsePRUrl answered before Forgejo was
 * added: a Forgejo change that alters any of them fails here. Ambiguous rows
 * pin how one host name reads under each platform's path shape.
 */
describe("parsePRUrl — a Forgejo host and names the API URL and checkout folder are built from", () => {
  test.each([
    ["https://codeberg.org/acme/widgets/pulls/1", { host: "codeberg.org" }],
    ["http://codeberg.org/acme/widgets/pulls/1", { host: "codeberg.org", scheme: "http" }],
    ["https://git.example.com:3000/acme/widgets/pulls/1", { host: "git.example.com:3000" }],
    ["http://git.example.com:3000/acme/widgets/pulls/1", { host: "git.example.com:3000", scheme: "http" }],
    ["http://192.168.1.5:3000/acme/widgets/pulls/1", { host: "192.168.1.5:3000", scheme: "http" }],
    ["https://192.168.1.5:3000/acme/widgets/pulls/1", { host: "192.168.1.5:3000" }],
    ["http://[::1]:3000/acme/widgets/pulls/1", { host: "[::1]:3000", scheme: "http" }],
    ["https://[::1]:3000/acme/widgets/pulls/1", { host: "[::1]:3000" }],
    ["https://localhost/acme/widgets/pulls/1", { host: "localhost" }],
    ["https://codeberg.org/a.b_c-d/w.e_b-1/pulls/1", { owner: "a.b_c-d", repo: "w.e_b-1" }],
  ])("%s still parses", (url, expected) => {
    expect(parsePRUrl(url)).toMatchObject({ platform: "forgejo", number: 1, ...expected });
  });

  test("a backslash, a trailing dot, an IP shorthand, a default port or a `..` name is no Forgejo PR", () => {
    for (const url of [
      // A backslash is read as `/` by the URL parser: the request would go to another path.
      "http://169.254.169.254\\latest\\meta-data/a/b/pulls/1",
      "https://good.com\\evil\\x/o/r/pulls/1",
      "https://github.com\\x/o/r/pulls/1",
      // The other platforms' hosts, however written.
      "https://github.com./o/r/pulls/1",
      "https://GITHUB.COM/o/r/pulls/1",
      "https://www.gitlab.com./o/r/pulls/1",
      "https://bitbucket.org:8443/o/r/pulls/1",
      "https://codeberg.org./acme/widgets/pulls/1",
      // A host the URL parser would rewrite: the origin would not be the one written.
      "http://0x7f.1/acme/widgets/pulls/1",
      "http://2130706433/acme/widgets/pulls/1",
      "https://codeberg.org:443/acme/widgets/pulls/1",
      "http://codeberg.org:80/acme/widgets/pulls/1",
      "https://codeberg.org:99999/acme/widgets/pulls/1",
      "https://[::1/acme/widgets/pulls/1",
      "https://user@codeberg.org/acme/widgets/pulls/1",
      "https://code%62erg.org/acme/widgets/pulls/1",
      // Names that climb out of the repository path or the checkout folder.
      "https://h/../../pulls/1",
      "https://h/acme/../pulls/1",
      "https://h/./widgets/pulls/1",
      "https://h/acme/%2e%2e/pulls/1",
      "https://h/ac\\me/widgets/pulls/1",
      "https://h/acme/wid%2Fgets/pulls/1",
      "https://h/acme/wid gets/pulls/1",
    ]) {
      expect([url, parsePRUrl(url)]).toEqual([url, null]);
    }
  });
});

describe("parsePRUrl — every host's URL forms", () => {
  const gh = (host: string, owner: string, repo: string, number: number) => ({ platform: "github", host, owner, repo, number });
  const gl = (host: string, projectPath: string, iid: number) => ({ platform: "gitlab", host, projectPath, iid });
  const bb = (workspace: string, repo: string, number: number) => ({ platform: "bitbucket", host: "bitbucket.org", workspace, repo, number });
  const fj = (host: string, owner: string, repo: string, number: number, scheme?: "http") => ({ platform: "forgejo", host, owner, repo, number, ...(scheme ? { scheme } : {}) });

  test.each([
    // GitHub and GitHub Enterprise
    ["https://github.com/acme/widgets/pull/12", gh("github.com", "acme", "widgets", 12)],
    ["https://github.com/acme/widgets/pull/12/files", gh("github.com", "acme", "widgets", 12)],
    ["https://github.com/acme/widgets/pull/12/commits/0a1b2c3", gh("github.com", "acme", "widgets", 12)],
    ["https://github.com/acme/widgets/pull/12#discussion_r99", gh("github.com", "acme", "widgets", 12)],
    ["https://github.com/acme/widgets/pull/12?diff=split", gh("github.com", "acme", "widgets", 12)],
    ["https://www.github.com/acme/widgets/pull/12", gh("www.github.com", "acme", "widgets", 12)],
    ["http://github.com/acme/widgets/pull/12", gh("github.com", "acme", "widgets", 12)],
    ["https://ghe.acme.corp/acme/widgets/pull/12", gh("ghe.acme.corp", "acme", "widgets", 12)],
    ["https://ghe.acme.corp:8443/acme/widgets/pull/12", gh("ghe.acme.corp:8443", "acme", "widgets", 12)],
    // GitLab and self-hosted GitLab
    ["https://gitlab.com/acme/widgets/-/merge_requests/42", gl("gitlab.com", "acme/widgets", 42)],
    ["https://gitlab.com/acme/sub/widgets/-/merge_requests/42/diffs", gl("gitlab.com", "acme/sub/widgets", 42)],
    ["https://gitlab.acme.corp/acme/widgets/-/merge_requests/42", gl("gitlab.acme.corp", "acme/widgets", 42)],
    ["http://gitlab.lan:8080/acme/widgets/-/merge_requests/42", gl("gitlab.lan:8080", "acme/widgets", 42)],
    // Bitbucket Cloud
    ["https://bitbucket.org/acme/widgets/pull-requests/7", bb("acme", "widgets", 7)],
    ["https://bitbucket.org/acme/widgets/pull-requests/7/diff", bb("acme", "widgets", 7)],
    ["https://www.bitbucket.org/acme/widgets/pull-requests/7/overview", bb("acme", "widgets", 7)],
    // Forgejo / Gitea: Codeberg, a self-hosted instance, a LAN one over http
    ["https://codeberg.org/acme/widgets/pulls/3", fj("codeberg.org", "acme", "widgets", 3)],
    ["https://codeberg.org/acme/widgets/pulls/3/files", fj("codeberg.org", "acme", "widgets", 3)],
    ["https://git.acme.corp/acme/widgets/pulls/3", fj("git.acme.corp", "acme", "widgets", 3)],
    ["http://forgejo.lan:3000/acme/widgets/pulls/3", fj("forgejo.lan:3000", "acme", "widgets", 3, "http")],
    // One self-hosted name under each shape: GitLab's, GitHub Enterprise's, Forgejo's.
    ["https://git.acme.corp/acme/widgets/-/merge_requests/3", gl("git.acme.corp", "acme/widgets", 3)],
    ["https://git.acme.corp/acme/widgets/pull/3", gh("git.acme.corp", "acme", "widgets", 3)],
    // A merge-request path wins over anything after it, as before.
    ["https://git.acme.corp/acme/widgets/-/merge_requests/3/pulls/4", gl("git.acme.corp", "acme/widgets", 3)],
  ])("%s", (url, expected) => {
    expect(parsePRUrl(url)).toEqual(expected as ReturnType<typeof parsePRUrl>);
  });

  test("what was no PR before stays none, on the other platforms' own hosts too", () => {
    for (const url of [
      // `/pulls/N` on GitHub, GitLab and Bitbucket is no Forgejo instance.
      "https://github.com/acme/widgets/pulls/12",
      "https://www.github.com/acme/widgets/pulls/12",
      "https://GitHub.com/acme/widgets/pulls/12",
      "https://github.com:443/acme/widgets/pulls/12",
      "https://gitlab.com/acme/widgets/pulls/12",
      "https://bitbucket.org/acme/widgets/pulls/12",
      // List pages, issues, Bitbucket Data Center, no scheme.
      "https://github.com/acme/widgets/pulls",
      "https://github.com/acme/widgets/issues/12",
      "https://gitlab.com/acme/widgets/-/issues/42",
      "https://bitbucket.org/acme/widgets/src/main/",
      "https://git.acme.corp/projects/P/repos/widgets/pull-requests/7",
      "github.com/acme/widgets/pull/12",
      "",
    ]) {
      expect(parsePRUrl(url)).toBeNull();
    }
  });
});

describe("Forgejo helpers", () => {
  test("label, number, repo and CLI for a Forgejo PR", () => {
    const fj = parsePRUrl("https://forgejo.example.com/acme/widgets/pulls/5")!;
    expect(getMRNumberLabel(fj)).toBe("#5");
    expect(getPRNumber(fj)).toBe(5);
    expect(getDisplayRepo(fj)).toBe("acme/widgets");
    expect(getPlatformLabel(fj)).toBe("Forgejo");
    expect(getCliName(fj)).toBe("");
  });

  test("getForgejoOrigin is https unless the ref says http, and keeps the port", () => {
    expect(getForgejoOrigin(fjMeta)).toBe("https://forgejo.example.com");
    expect(getForgejoOrigin({ ...fjMeta, host: "forgejo.lan:3000", scheme: "http" })).toBe("http://forgejo.lan:3000");
  });

  test("prRefFromMetadata round-trips, carrying scheme only when it is http", () => {
    expect(prRefFromMetadata(fjMeta)).toEqual({ platform: "forgejo", host: "forgejo.example.com", owner: "acme", repo: "widgets", number: 5 });
    expect("scheme" in prRefFromMetadata(fjMeta)).toBe(false);
    const lan: ForgejoPRMetadata = { ...fjMeta, host: "forgejo.lan:3000", scheme: "http" };
    expect(prRefFromMetadata(lan)).toEqual({ platform: "forgejo", host: "forgejo.lan:3000", scheme: "http", owner: "acme", repo: "widgets", number: 5 });
    // And parsing the URL gives back the same ref.
    expect(parsePRUrl("http://forgejo.lan:3000/acme/widgets/pulls/5")).toEqual(prRefFromMetadata(lan));
  });

  test("isSameProject: owner, repo and host are case-insensitive; scheme and port tell instances apart", () => {
    const a = parsePRUrl("https://Forgejo.Example.com/ACME/Widgets/pulls/1")!;
    const b = parsePRUrl("https://forgejo.example.com/acme/widgets/pulls/2")!;
    expect(isSameProject(a, b)).toBe(true);
    expect(isSameProject(b, parsePRUrl("http://forgejo.example.com/acme/widgets/pulls/2")!)).toBe(false);
    expect(isSameProject(b, parsePRUrl("https://forgejo.example.com:8443/acme/widgets/pulls/2")!)).toBe(false);
    expect(isSameProject(b, parsePRUrl("https://forgejo.example.com/acme/other/pulls/2")!)).toBe(false);
    // Never the same project as a GitHub repository of the same name.
    expect(isSameProject(b, parsePRUrl("https://github.com/acme/widgets/pull/2")!)).toBe(false);
  });
});

describe("Forgejo local checkout specs", () => {
  test("the head is fetched from refs/pull/N/head on the base repository, forks included", () => {
    expect(getPRHeadFetchSpec(fjMeta)).toEqual({ remote: null, ref: "refs/pull/5/head" });
    // sourceRepo, when present, does not redirect the fetch: Forgejo publishes a fork PR's head on the base repo.
    expect(getPRHeadFetchSpec({ ...fjMeta, sourceRepo: "someone/widgets-fork" })).toEqual({ remote: null, ref: "refs/pull/5/head" });
  });

  test("the clone is plain git over the instance's own scheme and port, and never prompts", () => {
    expect(getPRCloneCommand(fjMeta, "/tmp/x")).toEqual({
      argv: ["git", "clone", "--depth=1", "--no-checkout", "--", "https://forgejo.example.com/acme/widgets.git", "/tmp/x"],
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    expect(getPRCloneCommand({ ...fjMeta, host: "forgejo.lan:3000", scheme: "http" }, "/tmp/x").argv).toContain(
      "http://forgejo.lan:3000/acme/widgets.git",
    );
  });
});

describe("prDraftTargetKey — Forgejo", () => {
  test("the Forgejo key is pinned: a changed key would orphan every saved Forgejo PR draft", () => {
    const fj = { platform: "forgejo", host: "forgejo.example.com", owner: "Acme", repo: "Widgets", number: 42 } as PRMetadata;
    expect(prDraftTargetKey(fj, "layer")).toBe("pr-f371a18547987780");
    expect(prDraftTargetKey(fj, "full-stack")).toBe("pr-e4bea01b8c94629e");
  });

  test("case-insensitive in host, owner and repo; not changed by a push or a rename of the title", () => {
    const key = prDraftTargetKey(fjMeta, "layer");
    expect(prDraftTargetKey({ ...fjMeta, host: "Forgejo.Example.COM", owner: "ACME", repo: "Widgets" }, "layer")).toBe(key);
    expect(prDraftTargetKey({ ...fjMeta, headSha: "new", title: "renamed" }, "layer")).toBe(key);
  });

  test("another PR, instance, scheme or repository gets another key, and never a GitHub PR's", () => {
    const key = prDraftTargetKey(fjMeta, "layer");
    for (const other of [
      { ...fjMeta, number: 6 },
      { ...fjMeta, repo: "gadgets" },
      { ...fjMeta, host: "other.example.com" },
      { ...fjMeta, host: "forgejo.example.com:8443" },
      { ...fjMeta, scheme: "http" as const },
    ]) {
      expect(prDraftTargetKey(other, "layer")).not.toBe(key);
    }
    const gh = { platform: "github", host: "forgejo.example.com", owner: "acme", repo: "widgets", number: 5 } as PRMetadata;
    expect(prDraftTargetKey(gh, "layer")).not.toBe(key);
  });
});
