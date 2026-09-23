/**
 * Regression guards for #1596: the full path a real `origin` URL takes to an
 * inline `#1` link (parseRemoteHost + parseRemoteUrl on the server, then
 * forgeRefLinks in the UI). Before #1596 every remote with a slash in its
 * path linked to github.com, so any github.com remote shape that stops
 * linking there is a regression.
 */
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
    // github.com in every common spelling keeps linking to github.com
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
    // GitHub Enterprise links to its own host
    ["git@github.acme.com:team/app.git", "https://github.acme.com/team/app/issues/1"],
    ["https://github.acme.com:8443/team/app", "https://github.acme.com/team/app/issues/1"],
    // GitLab links to /-/issues
    ["git@gitlab.com:group/sub/proj.git", "https://gitlab.com/group/sub/proj/-/issues/1"],
    ["ssh://git@altssh.gitlab.com:443/group/proj.git", "https://gitlab.com/group/proj/-/issues/1"],
    ["https://oauth2:tok@gitlab.example.com/group/proj.git", "https://gitlab.example.com/group/proj/-/issues/1"],
    // An unrecognized forge renders unlinked rather than linking to the wrong one
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
