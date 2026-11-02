/**
 * Jira issue links on a Board card (user feedback #9): a link only, read by
 * the card refs registry. What regresses: a Jira URL refused again, a key or
 * URL stored in a form that differs by how it was pasted (so the same issue
 * links twice), an ordinary link on any host read as a Jira issue, a forge
 * link captured by the Jira match, or a Jira link taking a lane card's mark.
 */
import { describe, expect, test } from "bun:test";
import { inboxCardMarkRef } from "@plannotator/core/inbox-types";
import { parseInboxCardRef } from "./card-refs";

const jira = (ref: string, url: string) => ({ kind: "issue", source: "jira", ref, url });

describe("parseInboxCardRef: Jira", () => {
  test("Jira Cloud browse links, normalized to the key and its canonical URL", () => {
    expect(parseInboxCardRef("https://example.atlassian.net/browse/DEMO-123")).toEqual(jira("DEMO-123", "https://example.atlassian.net/browse/DEMO-123"));
    // Query, fragment and case are how it was pasted, not which issue it is.
    expect(parseInboxCardRef("https://Example.atlassian.net/browse/demo-123?atlOrigin=abc#comment-1")).toEqual(jira("DEMO-123", "https://example.atlassian.net/browse/DEMO-123"));
    expect(parseInboxCardRef("  https://acme-eng.atlassian.net/browse/AB_2-7  ")).toEqual(jira("AB_2-7", "https://acme-eng.atlassian.net/browse/AB_2-7"));
  });

  test("a Jira Cloud board or list link with selectedIssue names that issue", () => {
    expect(parseInboxCardRef("https://example.atlassian.net/jira/software/projects/DEMO/boards/1?selectedIssue=DEMO-123")).toEqual(
      jira("DEMO-123", "https://example.atlassian.net/browse/DEMO-123"),
    );
    expect(parseInboxCardRef("https://example.atlassian.net/jira/software/c/projects/DEMO/list?selectedIssue=demo-9")).toEqual(jira("DEMO-9", "https://example.atlassian.net/browse/DEMO-9"));
    // A board link with no issue selected is not an issue.
    expect(parseInboxCardRef("https://example.atlassian.net/jira/software/projects/DEMO/boards/1")).toBeNull();
  });

  test("a self-hosted Jira, only when the path is exactly /browse/KEY-123", () => {
    expect(parseInboxCardRef("https://jira.acme.corp/browse/OPS-42")).toEqual(jira("OPS-42", "https://jira.acme.corp/browse/OPS-42"));
    expect(parseInboxCardRef("http://jira.internal:8080/browse/OPS-42?focusedCommentId=9")).toEqual(jira("OPS-42", "http://jira.internal:8080/browse/OPS-42"));
    for (const ordinary of [
      "https://jira.acme.corp/jira/browse/OPS-42", // a context path
      "https://jira.acme.corp/browse/OPS-42/", // not exactly
      "https://blog.example.com/browse/ops-42", // a lowercase slug on an ordinary site
      "https://docs.example.com/browse/HTTP-2-guide",
      "https://example.com/browse/A-1", // a one-letter project key
      "https://example.com/browse/OPS-0",
      "https://example.com/issues/OPS-42",
      "https://example.com/?selectedIssue=OPS-42", // selectedIssue is Jira Cloud's only
    ]) {
      expect(parseInboxCardRef(ordinary)).toBeNull();
    }
  });

  test("lookalikes are refused", () => {
    for (const lookalike of [
      "https://example.atlassian.net.evil.example/jira/software/projects/DEMO/boards/1?selectedIssue=DEMO-1",
      "https://github.com/browse/DEMO-1",
      "https://gitlab.com/browse/DEMO-1",
      "https://user:pass@example.atlassian.net/browse/DEMO-1",
      "http://example.atlassian.net/browse/DEMO-1", // Jira Cloud is https only
      "ftp://jira.acme.corp/browse/OPS-42",
      "example.atlassian.net/browse/DEMO-1",
      "DEMO-123",
    ]) {
      expect(parseInboxCardRef(lookalike)).toBeNull();
    }
  });

  test("a Jira issue is never a PR, and forge links still read as forge links", () => {
    expect(parseInboxCardRef("https://example.atlassian.net/browse/DEMO-123", "pr")).toBeNull();
    expect(parseInboxCardRef("https://github.com/acme/widgets/issues/4")).toMatchObject({ source: "github", ref: "acme/widgets#4" });
    expect(parseInboxCardRef("https://gitlab.com/g/p/-/issues/4")).toMatchObject({ source: "gitlab", ref: "g/p#4" });
  });
});

describe("inboxCardMarkRef: a link-only Jira issue", () => {
  const github = { kind: "issue", source: "github", ref: "acme/widgets#4", url: "https://github.com/acme/widgets/issues/4" };
  const issue = jira("DEMO-1", "https://example.atlassian.net/browse/DEMO-1");

  test("never takes a lane card's mark from a forge link, and is not marked alone", () => {
    expect(inboxCardMarkRef({ refs: [github, issue], prs: [] })).toEqual(github);
    expect(inboxCardMarkRef({ refs: [issue], prs: [] })).toBeNull();
  });
});
