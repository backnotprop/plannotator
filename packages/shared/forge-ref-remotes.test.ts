import { describe, expect, test } from "bun:test";
import { forgeRefLinks } from "@plannotator/core/forge-refs";
import { parseRemoteHost, parseRemoteUrl } from "./repo";

function issueLink(remote: string): string | null {
  const display = parseRemoteUrl(remote) ?? undefined;
  const host = parseRemoteHost(remote) ?? undefined;
  return forgeRefLinks({ display, host })?.issue(1) ?? null;
}

describe("remote URL → issue link", () => {
  const cases: Array<[string, string | null]> = [
    ["git@github.com:o/r.git", "https://github.com/o/r/issues/1"],
    ["https://github.com/o/r.git", "https://github.com/o/r/issues/1"],
    ["git@github.com-work:o/r.git", "https://github.com/o/r/issues/1"],
    ["https://user:tok@github.com/o/r", "https://github.com/o/r/issues/1"],
    ["https://x-access-token:abc123@github.com/o/r.git", "https://github.com/o/r/issues/1"],
    ["https://user@github.com/o/r", "https://github.com/o/r/issues/1"],
    ["git@work-gh:o/r", "https://github.com/o/r/issues/1"],
    ["ssh://git@ssh.github.com:443/o/r.git", "https://github.com/o/r/issues/1"],
    ["https://www.github.com/o/r", "https://github.com/o/r/issues/1"],
    ["git@GITHUB.COM:o/r.git", "https://github.com/o/r/issues/1"],
    ["https://GitHub.com/o/r", "https://github.com/o/r/issues/1"],
    ["git@[::1]:o/r", "https://github.com/o/r/issues/1"],
    ["git@github.acme.com:team/app.git", "https://github.acme.com/team/app/issues/1"],
    ["https://github.acme.com:8443/team/app", "https://github.acme.com/team/app/issues/1"],
    ["git@gitlab.com:group/sub/proj.git", "https://gitlab.com/group/sub/proj/-/issues/1"],
    ["ssh://git@altssh.gitlab.com:443/group/proj.git", "https://gitlab.com/group/proj/-/issues/1"],
    ["https://oauth2:tok@gitlab.example.com/group/proj.git", "https://gitlab.example.com/group/proj/-/issues/1"],
    ["git@git.internal.example:o/r.git", null],
    ["https://github.x@evil.com/o/r", null],
  ];

  for (const [remote, expected] of cases) {
    test(remote, () => {
      expect(issueLink(remote)).toBe(expected);
    });
  }
});

describe("parseRemoteHost", () => {
  test("never reports URL userinfo as the host", () => {
    expect(parseRemoteHost("https://user:tok@github.com/o/r")).toBe("github.com");
    expect(parseRemoteHost("https://user@github.com/o/r")).toBe("github.com");
    expect(parseRemoteHost("ssh://git@ssh.github.com:443/o/r.git")).toBe("ssh.github.com");
  });
});
