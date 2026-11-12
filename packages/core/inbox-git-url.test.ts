import { describe, expect, test } from "bun:test";
import { inboxGitRemoteKey, parseInboxGitUrl } from "./inbox-git-url";

describe("parseInboxGitUrl", () => {
  test("C1: https, with or without .git or a trailing slash", () => {
    for (const text of ["https://github.com/acme/billing-api", "https://github.com/acme/billing-api.git", "https://github.com/acme/billing-api/", " https://www.github.com/acme/billing-api "]) {
      expect(parseInboxGitUrl(text)).toEqual({ kind: "repo", host: "github.com", slug: "acme/billing-api", repo: "billing-api", url: "https://github.com/acme/billing-api.git", transport: "https" });
    }
  });

  test("C2: ssh in scp form keeps its user and the machine's own keys", () => {
    expect(parseInboxGitUrl("git@github.com:acme/billing-api.git")).toEqual({ kind: "repo", host: "github.com", slug: "acme/billing-api", repo: "billing-api", url: "git@github.com:acme/billing-api.git", transport: "ssh" });
  });

  test("C3: a known forge without a scheme reads as https; a bare owner/repo stays words", () => {
    expect(parseInboxGitUrl("github.com/acme/billing-api")).toMatchObject({ kind: "repo", url: "https://github.com/acme/billing-api.git" });
    expect(parseInboxGitUrl("acme/billing-api")).toBeNull();
    expect(parseInboxGitUrl("billing")).toBeNull();
  });

  test("C4: a branch from …/tree/<branch>/…; the repo's top folder, not the subfolder", () => {
    expect(parseInboxGitUrl("https://github.com/acme/billing-api/tree/release-2.1/packages/core")).toMatchObject({ slug: "acme/billing-api", branch: "release-2.1", url: "https://github.com/acme/billing-api.git" });
    expect(parseInboxGitUrl("https://github.com/acme/billing-api/pull/12")).not.toHaveProperty("branch");
  });

  test("C5: a GitLab subgroup over ssh://", () => {
    expect(parseInboxGitUrl("ssh://git@gitlab.com/acme/tools/cli.git")).toEqual({ kind: "repo", host: "gitlab.com", slug: "acme/tools/cli", repo: "cli", url: "ssh://git@gitlab.com/acme/tools/cli.git", transport: "ssh" });
    expect(parseInboxGitUrl("https://gitlab.com/acme/tools/cli/-/tree/main")).toMatchObject({ slug: "acme/tools/cli", branch: "main" });
  });

  test("C6, C7, C8: an account, an unknown host's page, a self-hosted forge to check", () => {
    expect(parseInboxGitUrl("github.com/acme")).toEqual({ kind: "account", host: "github.com", owner: "acme" });
    expect(parseInboxGitUrl("https://acme.com/pricing")).toEqual({ kind: "notrepo", host: "acme.com", text: "https://acme.com/pricing" });
    expect(parseInboxGitUrl("https://acme.com/pricing/plans")).toMatchObject({ kind: "repo", unchecked: true, slug: "pricing/plans" });
    expect(parseInboxGitUrl("https://git.acme.dev/team/tool")).toMatchObject({ kind: "repo", unchecked: true, repo: "tool", url: "https://git.acme.dev/team/tool.git" });
  });

  test("never a credential, an option, a path trick, or a protocol beyond https and ssh", () => {
    expect(parseInboxGitUrl("https://me:ghp_secret@github.com/acme/billing-api")).toMatchObject({ url: "https://github.com/acme/billing-api.git" });
    for (const text of [
      "-uhttps://github.com/acme/x",
      "--upload-pack=touch /tmp/x",
      "git@github.com:-oProxyCommand=x/y",
      "ssh://-oProxyCommand=x/y",
      "https://github.com/acme/../x",
      "https://github.com/acme/-x",
      "http://github.com/acme/x",
      "git://github.com/acme/x",
      "file:///tmp/x.git",
      "ext::sh -c touch% /tmp/x",
      "https://github.com/acme/x y",
      "https://github.com/acme/x;rm",
    ]) {
      const read = parseInboxGitUrl(text);
      expect([text, read === null || read.kind !== "repo" || !read.url.includes("-o") ? "safe" : read]).toEqual([text, "safe"]);
      if (read?.kind === "repo") expect(read.url.startsWith("https://") || /^[\w.-]+@/.test(read.url) || read.url.startsWith("ssh://")).toBe(true);
    }
    expect(parseInboxGitUrl("https://github.com/acme/x/tree/--upload-pack=y")).not.toHaveProperty("branch");
  });

  test("C9: the same repo, however its remote is written", () => {
    expect(inboxGitRemoteKey("git@github.com:Acme/Billing-API.git")).toBe("github.com/acme/billing-api");
    expect(inboxGitRemoteKey("https://github.com/acme/billing-api")).toBe("github.com/acme/billing-api");
    expect(inboxGitRemoteKey("/some/local/path")).toBeNull();
  });
});
