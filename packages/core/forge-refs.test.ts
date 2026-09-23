import { describe, expect, test } from "bun:test";
import { classifyForgeHost, forgeRefLinks } from "./forge-refs";

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

describe("classifyForgeHost", () => {
  test("matches gitlab structurally, not by substring", () => {
    expect(classifyForgeHost("sub.gitlab.example.io")).toBe("gitlab");
    expect(classifyForgeHost("mygitlabproxy.example.com")).toBeNull();
    expect(classifyForgeHost("notgithub.com")).toBeNull();
  });
});
