import { describe, expect, test } from "bun:test";
import { BARE_MR_REF, classifyForgeHost, CROSS_REPO_REF_PATTERN, findCrossRepoRef, forgeRefLinks, gitlabHostsSnapshot, learnGitlabHosts, matchCrossRepoRef, normalizeForgeHost, readGitlabShortMr } from "./forge-refs";

describe("forgeRefLinks", () => {
  const cases: Array<{
    name: string;
    repo: { display?: string; host?: string };
    issue: string | null;
    user: string | null;
  }> = [
    {
      name: "github.com",
      repo: { display: "owner/repo", host: "github.com" },
      issue: "https://github.com/owner/repo/issues/123",
      user: "https://github.com/octocat",
    },
    {
      name: "GitHub Enterprise links to its own host",
      repo: { display: "team/app", host: "github.acme.com" },
      issue: "https://github.acme.com/team/app/issues/123",
      user: "https://github.acme.com/octocat",
    },
    {
      name: "gitlab.com with a subgroup path uses /-/issues",
      repo: { display: "group/subgroup/project", host: "gitlab.com" },
      issue: "https://gitlab.com/group/subgroup/project/-/issues/123",
      user: "https://gitlab.com/octocat",
    },
    {
      name: "self-hosted GitLab",
      repo: { display: "group/project", host: "gitlab.example.com" },
      issue: "https://gitlab.example.com/group/project/-/issues/123",
      user: "https://gitlab.example.com/octocat",
    },
    {
      name: "opaque host renders unlinked",
      repo: { display: "owner/repo", host: "git.internal.example" },
      issue: null,
      user: null,
    },
    {
      name: "missing host keeps the legacy github.com links",
      repo: { display: "owner/repo" },
      issue: "https://github.com/owner/repo/issues/123",
      user: "https://github.com/octocat",
    },
    {
      name: "directory-only display renders unlinked",
      repo: { display: "my-project", host: "github.com" },
      issue: null,
      user: null,
    },
    {
      name: "no repo renders unlinked",
      repo: {},
      issue: null,
      user: null,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const links = forgeRefLinks(c.repo);
      expect(links?.issue(123) ?? null).toBe(c.issue);
      expect(links?.user("octocat") ?? null).toBe(c.user);
    });
  }
});

describe("normalizeForgeHost", () => {
  const cases: Array<[string | undefined, string | null]> = [
    ["GitHub.com", "github.com"],
    ["github.com:22", "github.com"],
    ["www.github.com", "github.com"],
    ["ssh.github.com", "github.com"],
    ["github.com-work", "github.com"],
    ["altssh.gitlab.com", "gitlab.com"],
    ["github.acme.com", "github.acme.com"],
    // not a plausible DNS name → treated as absent (legacy github.com link)
    ["work-gh", null],
    ["[::1]", null],
    ["github.x@evil.com", null],
    ["", null],
    [undefined, null],
  ];
  for (const [input, expected] of cases) {
    test(String(input), () => {
      expect(normalizeForgeHost(input)).toBe(expected);
    });
  }

  test("an implausible host falls back to the legacy github.com link", () => {
    expect(forgeRefLinks({ display: "o/r", host: "work-gh" })?.issue(1)).toBe(
      "https://github.com/o/r/issues/1",
    );
  });
});

describe("classifyForgeHost", () => {
  test("matches gitlab structurally, not by substring", () => {
    expect(classifyForgeHost("sub.gitlab.example.io")).toBe("gitlab");
    expect(classifyForgeHost("mygitlabproxy.example.com")).toBeNull();
    expect(classifyForgeHost("notgithub.com")).toBeNull();
  });

  test("a label that is gitlab or starts gitlab- names a GitLab; a look-alike or a gitlab inside a word does not", () => {
    for (const host of ["gitlab-master.example.com", "gitlab-ce.corp.net", "code.gitlab-prod.example.org", "gitlab.acme.dev", "gitlab.com", "gitlab-acme.example.com:8443"]) {
      expect(classifyForgeHost(host)).toBe("gitlab");
    }
    for (const host of ["mygitlabproxy.example.com", "corp-gitlab.example.com", "notgitlab.example.com", "example.gitlab", "gitlab"]) {
      expect(classifyForgeHost(host)).toBeNull();
    }
    expect(classifyForgeHost("github-enterprise.corp.net")).toBeNull();
    // A look-alike of gitlab.com is a host of its own: never gitlab.com, and its links go to it, not to gitlab.com.
    for (const host of ["gitlab.com-evil.example", "gitlab.com.evil.example"]) {
      expect(normalizeForgeHost(host)).toBe(host);
      expect(forgeRefLinks({ display: "g/p", host })?.issue(1)).toBe(`https://${host}/g/p/-/issues/1`);
    }
  });

  test("bitbucket.org is Bitbucket Cloud, and its bare #N refs stay unlinked as before", () => {
    expect(classifyForgeHost("bitbucket.org")).toBe("bitbucket");
    // Bitbucket Data Center has another API: an opaque self-hosted name, not Bitbucket.
    expect(classifyForgeHost("bitbucket.example.com")).toBeNull();
    // A Bitbucket repository's #N may be a pull request or an issue (numbered apart): no guessed link.
    expect(forgeRefLinks({ display: "ws/repo", host: "bitbucket.org" })).toBeNull();
    expect(matchCrossRepoRef("ws/repo#3", "", { host: "bitbucket.org" })?.href ?? null).toBeNull();
  });
});

describe("matchCrossRepoRef", () => {
  test("links on the project's forge host: GitHub Enterprise keeps its host", () => {
    expect(matchCrossRepoRef("team/app#9 done", "", { host: "github.acme.com" })).toEqual({
      label: "team/app#9",
      path: "team/app",
      href: "https://github.acme.com/team/app/issues/9",
    });
  });

  test("never continues a word, path or URL", () => {
    for (const prev of ["a", "/", ".", "-", "_"]) {
      expect(matchCrossRepoRef("owner/repo#1", prev, {})).toBeNull();
    }
    expect(matchCrossRepoRef("owner/repo#1", "(", {})?.href).toBe("https://github.com/owner/repo/issues/1");
  });

  test("findCrossRepoRef skips a ref that starts inside a path", () => {
    expect(findCrossRepoRef("see a/owner/repo#1", 18, {})).toBe(-1);
    expect(findCrossRepoRef("see owner/repo#1", 14, {})).toBe(4);
  });
});

describe("a self-managed GitLab at any address", () => {
  test("#12 and owner/repo#12 link on the project's host once it is known as a GitLab, and stay plain before", () => {
    const before = [...gitlabHostsSnapshot()];
    try {
      expect(forgeRefLinks({ display: "acme/api", host: "git.acme.com" })).toBeNull();
      expect(matchCrossRepoRef("acme/web#4", "", { host: "git.acme.com" })?.href ?? null).toBeNull();
      learnGitlabHosts(["Git.Acme.com"]);
      expect(forgeRefLinks({ display: "acme/api", host: "git.acme.com" })?.issue(12)).toBe("https://git.acme.com/acme/api/-/issues/12");
      expect(matchCrossRepoRef("acme/web#4", "", { host: "git.acme.com" })?.href).toBe("https://git.acme.com/acme/web/-/issues/4");
      expect(forgeRefLinks({ display: "acme/api", host: "source.acme.io" })).toBeNull();
      expect(forgeRefLinks({ display: "acme/api", host: "github.com" })?.issue(12)).toBe("https://github.com/acme/api/issues/12");
      expect(forgeRefLinks({ display: "acme/api", host: "gitlab.com" })?.issue(12)).toBe("https://gitlab.com/acme/api/-/issues/12");
      expect(forgeRefLinks({ display: "ws/repo", host: "bitbucket.org" })).toBeNull();
    } finally {
      learnGitlabHosts(before);
    }
  });
});

describe("GitLab merge requests: !123 and group/sub/project!45", () => {
  const selfHosted = { host: "gitlab.harbor.dev" };

  test("a GitLab project's !N links to its merge request on its own host; GitHub and Bitbucket have none", () => {
    expect(forgeRefLinks({ display: "harbor-group/harbor", host: "gitlab.harbor.dev" })?.mergeRequest?.(123)).toBe(
      "https://gitlab.harbor.dev/harbor-group/harbor/-/merge_requests/123",
    );
    expect(forgeRefLinks({ display: "harbor-group/infra/harbor", host: "gitlab.com" })?.mergeRequest?.(7)).toBe(
      "https://gitlab.com/harbor-group/infra/harbor/-/merge_requests/7",
    );
    expect(forgeRefLinks({ display: "fern/fern-api", host: "github.com" })?.mergeRequest).toBeNull();
    expect(forgeRefLinks({ display: "fern/fern-api" })?.mergeRequest).toBeNull();
    expect(forgeRefLinks({ display: "fern/fern-api", host: "github.acme.com" })?.mergeRequest).toBeNull();
    expect(forgeRefLinks({ display: "ws/ledger", host: "bitbucket.org" })).toBeNull();
  });

  test("bare !N: digits after the mark, then no word character", () => {
    expect(BARE_MR_REF.exec("!123")?.[1]).toBe("123");
    for (const after of [".", ",", ")", " ", ":", "!"]) expect(BARE_MR_REF.exec(`!123${after}`)?.[0]).toBe("!123");
    for (const text of ["!123abc", "!123_x", "!important", "!0", "!012", "![alt](a.png)", "! 12", "!"]) expect(BARE_MR_REF.exec(text)).toBeNull();
  });

  test("group/project!45 and any depth of subgroups link on the GitLab project's host, self-hosted kept", () => {
    expect(matchCrossRepoRef("harbor-group/harbor!45 is ready", "", selfHosted)).toEqual({
      label: "harbor-group/harbor!45",
      path: "harbor-group/harbor",
      href: "https://gitlab.harbor.dev/harbor-group/harbor/-/merge_requests/45",
    });
    expect(matchCrossRepoRef("harbor-group/sub/deeper/quill-docs!9.", "(", selfHosted)?.href).toBe(
      "https://gitlab.harbor.dev/harbor-group/sub/deeper/quill-docs/-/merge_requests/9",
    );
    expect(matchCrossRepoRef("harbor-group/harbor!45", "", { host: "gitlab.com" })?.href).toBe("https://gitlab.com/harbor-group/harbor/-/merge_requests/45");
    const deep = `g/${Array.from({ length: 19 }, (_, i) => `s${i}`).join("/")}/p!3`;
    expect(matchCrossRepoRef(deep, "", selfHosted)?.label).toBe(deep);
  });

  test("on a GitHub project, with no host, or on an unknown host, group/project!45 is no ref at all", () => {
    for (const project of [{ host: "github.com" }, {}, { host: "github.acme.com" }, { host: "bitbucket.org" }, { host: "git.ledger.example" }]) {
      expect(matchCrossRepoRef("harbor-group/harbor!45", "", project)).toBeNull();
      expect(findCrossRepoRef("see harbor-group/harbor!45", 24, project)).toBe(-1);
    }
  });

  test("a self-managed GitLab at any address links !N once it is known as one", () => {
    const before = [...gitlabHostsSnapshot()];
    try {
      expect(forgeRefLinks({ display: "ledger/ledger", host: "code.ledger.example" })).toBeNull();
      learnGitlabHosts(["code.ledger.example"]);
      expect(forgeRefLinks({ display: "ledger/ledger", host: "code.ledger.example" })?.mergeRequest?.(5)).toBe("https://code.ledger.example/ledger/ledger/-/merge_requests/5");
      expect(matchCrossRepoRef("ledger/core/ledger!6", "", { host: "code.ledger.example" })?.href).toBe("https://code.ledger.example/ledger/core/ledger/-/merge_requests/6");
    } finally {
      learnGitlabHosts(before);
    }
  });

  test("no false refs: inside a word, path, URL or address, a file, a dot-only part, a word after the number", () => {
    for (const prev of ["a", "1", "/", ".", "-", "_", "@"]) expect(matchCrossRepoRef("harbor-group/harbor!45", prev, selfHosted)).toBeNull();
    for (const text of ["harbor-group/harbor!45abc", "harbor-group/harbor!0", "docs/guide.md!2", "and/or!1", "2024/05!3", "g/../p!4", "g/.../p!4", "-flag/x!1", "example.com/page!1", "_g/p!1"]) {
      expect(matchCrossRepoRef(text, "", selfHosted)).toBeNull();
    }
    expect(findCrossRepoRef("see ./harbor-group/harbor!45", 28, selfHosted)).toBe(-1);
    expect(findCrossRepoRef("see x@harbor-group/harbor!45", 28, selfHosted)).toBe(-1);
    expect(findCrossRepoRef("see https://x.dev/harbor-group/harbor!45", 40, selfHosted)).toBe(-1);
    expect(findCrossRepoRef("see harbor-group/sub/harbor!45", 30, selfHosted)).toBe(4);
  });

  test("#N keeps two parts only: a subgroup issue ref is still plain", () => {
    expect(matchCrossRepoRef("harbor-group/sub/harbor#45", "", selfHosted)).toBeNull();
    expect(matchCrossRepoRef("harbor-group/harbor#45", "", selfHosted)?.href).toBe("https://gitlab.harbor.dev/harbor-group/harbor/-/issues/45");
    expect(findCrossRepoRef("see harbor-group/sub/harbor#45", 31, selfHosted)).toBe(-1);
  });

  test("the prose form and the thread PRs' form are one grammar: every prose MR reads back as the same parts", () => {
    const re = new RegExp(CROSS_REPO_REF_PATTERN.source, "g");
    const text = "harbor-group/harbor!45 and harbor-group/sub/quill-docs!7, fern/fern-api#3";
    const mrs = [...text.matchAll(re)].filter((m) => m[3] === "!").map((m) => readGitlabShortMr(m[0]));
    expect(mrs).toEqual([
      { namespace: "harbor-group", project: "harbor", number: 45 },
      { namespace: "harbor-group/sub", project: "quill-docs", number: 7 },
    ]);
    expect(readGitlabShortMr("harbor-group/harbor#45")).toBeNull();
    expect(readGitlabShortMr("harbor!45")).toBeNull();
  });

  test("with no repo, a guessed GitLab host links owner/repo#N but never group/project!N", () => {
    const guessed = { host: "gitlab.harbor.dev", withoutRepo: true };
    expect(matchCrossRepoRef("harbor-group/harbor!45", "", guessed)).toBeNull();
    expect(matchCrossRepoRef("harbor-group/sub/harbor!45", "", guessed)).toBeNull();
    expect(findCrossRepoRef("see harbor-group/harbor!45", 24, guessed)).toBe(-1);
    expect(matchCrossRepoRef("harbor-group/harbor#7", "", guessed)?.href).toBe("https://gitlab.harbor.dev/harbor-group/harbor/-/issues/7");
    expect(findCrossRepoRef("see harbor-group/harbor#7", 24, guessed)).toBe(4);
  });

  test("a 50 kB message of slashes, bangs and deep paths is scanned in linear time", () => {
    const deepNoMark = ` ${`${"x".repeat(99)}/`.repeat(22)}!`;
    const shapes = ["a/", "a/b!", "a!1/", "/!1", " g/s/p!1x", ` ${"a/".repeat(30)}!1`, deepNoMark, " a/b!0123", "a/b/c!".repeat(3) + " "];
    for (const project of [{ host: "gitlab.harbor.dev" }, { host: "github.com" }, { host: "gitlab.harbor.dev", withoutRepo: true }]) {
      for (const shape of shapes) {
        const text = `x${shape.repeat(Math.ceil(50_000 / shape.length))}`.slice(0, 50_000);
        const start = performance.now();
        findCrossRepoRef(text, text.length, project, () => false);
        matchCrossRepoRef(text, "", project);
        expect(performance.now() - start).toBeLessThan(250);
      }
    }
  });
});
