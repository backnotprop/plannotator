import { describe, expect, test } from "bun:test";
import { classifyForgeHost, forgeRefLinks, normalizeForgeHost } from "./forge-refs";

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
});
