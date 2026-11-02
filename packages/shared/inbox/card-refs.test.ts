/**
 * Jira issue links on a Board card (user feedback #9): a link only, read by
 * the card refs registry. What regresses: a Jira URL refused again, a key or
 * URL stored in a form that differs by how it was pasted (so the same issue
 * links twice), an ordinary link on any host read as a Jira issue, a forge
 * link captured by the Jira match, or a Jira link taking a lane card's mark.
 * An ordinary page is now a plain web link (user feedback #10), so "not
 * Jira" means read as `web`, or refused when it is no web link at all.
 *
 * YouTrack issues and any other web link (user feedback #10). What regresses:
 * a YouTrack URL refused or read as a plain link, a forge link read as
 * YouTrack, a `javascript:` / `data:` / `file:` link accepted, the same page
 * stored twice, the same key on two sites stored once, or the person's links
 * no longer told apart from an agent's (only theirs get a favicon).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_CARD_LINK_LABEL_MAX, inboxCardLinkLabel, inboxCardMarkRef, type InboxAuthor } from "@plannotator/core/inbox-types";
import { parseInboxCardRef } from "./card-refs";
import { InboxStore } from "./store";

const jira = (ref: string, url: string) => ({ kind: "issue", source: "jira", ref, url });
/** What a URL that is not a Jira issue reads as: a plain web link. */
const sourceOf = (text: string) => parseInboxCardRef(text)?.source ?? null;

describe("parseInboxCardRef: Jira", () => {
  test("Jira Cloud browse links, normalized to the key and its canonical URL", () => {
    expect(parseInboxCardRef("https://example.atlassian.net/browse/DEMO-123")).toEqual(jira("DEMO-123", "https://example.atlassian.net/browse/DEMO-123"));
    // Query, fragment and case are how it was pasted, not which issue it is.
    expect(parseInboxCardRef("https://Example.atlassian.net/browse/demo-123?atlOrigin=abc#comment-1")).toEqual(jira("DEMO-123", "https://example.atlassian.net/browse/DEMO-123"));
    expect(parseInboxCardRef("https://example.atlassian.net:443/browse/DEMO-123")).toEqual(jira("DEMO-123", "https://example.atlassian.net/browse/DEMO-123"));
    expect(parseInboxCardRef("  https://acme-eng.atlassian.net/browse/AB_2-7  ")).toEqual(jira("AB_2-7", "https://acme-eng.atlassian.net/browse/AB_2-7"));
  });

  test("a Jira Cloud board or list link with selectedIssue names that issue", () => {
    expect(parseInboxCardRef("https://example.atlassian.net/jira/software/projects/DEMO/boards/1?selectedIssue=DEMO-123")).toEqual(
      jira("DEMO-123", "https://example.atlassian.net/browse/DEMO-123"),
    );
    expect(parseInboxCardRef("https://example.atlassian.net/jira/software/c/projects/DEMO/list?selectedIssue=demo-9")).toEqual(jira("DEMO-9", "https://example.atlassian.net/browse/DEMO-9"));
    // A board link with no issue selected is not an issue: a plain link.
    expect(sourceOf("https://example.atlassian.net/jira/software/projects/DEMO/boards/1")).toBe("web");
  });

  test("a self-hosted Jira, only when the path is exactly /browse/KEY-123 (a trailing slash allowed)", () => {
    expect(parseInboxCardRef("https://jira.acme.corp/browse/OPS-42")).toEqual(jira("OPS-42", "https://jira.acme.corp/browse/OPS-42"));
    expect(parseInboxCardRef("http://jira.internal:8080/browse/OPS-42?focusedCommentId=9")).toEqual(jira("OPS-42", "http://jira.internal:8080/browse/OPS-42"));
    // A trailing slash is how a link is sometimes copied: the same issue, one link (review of #2540, P3-5).
    expect(parseInboxCardRef("https://jira.acme.corp/browse/OPS-42/")).toEqual(jira("OPS-42", "https://jira.acme.corp/browse/OPS-42"));
    expect(parseInboxCardRef("https://example.atlassian.net/browse/DEMO-1/")).toEqual(jira("DEMO-1", "https://example.atlassian.net/browse/DEMO-1"));
    for (const ordinary of [
      "https://jira.acme.corp/jira/browse/OPS-42", // a context path
      "https://jira.acme.corp/browse/OPS-42//", // not exactly
      "https://blog.example.com/browse/ops-42", // a lowercase slug on an ordinary site
      "https://docs.example.com/browse/HTTP-2-guide",
      "https://example.com/browse/A-1", // a one-letter project key
      "https://example.com/browse/OPS-0",
      "https://example.com/issues/OPS-42",
      "https://example.com/?selectedIssue=OPS-42", // selectedIssue is Jira Cloud's only
    ]) {
      expect(sourceOf(ordinary)).toBe("web");
    }
  });

  test("lookalikes are never Jira issues: plain links, or refused", () => {
    for (const lookalike of [
      "https://example.atlassian.net.evil.example/jira/software/projects/DEMO/boards/1?selectedIssue=DEMO-1",
      "https://github.com/browse/DEMO-1",
      "https://gitlab.com/browse/DEMO-1",
      "http://example.atlassian.net/browse/DEMO-1", // Jira Cloud is https only
      "https://example.atlassian.net:8443/browse/DEMO-1", // and never on another port
      "https://jira.acme.corp/browse/ops-42", // a self-hosted key in lowercase
    ]) {
      expect(sourceOf(lookalike)).toBe("web");
    }
    for (const refused of ["https://user:pass@example.atlassian.net/browse/DEMO-1", "ftp://jira.acme.corp/browse/OPS-42", "example.atlassian.net/browse/DEMO-1", "DEMO-123"]) {
      expect(parseInboxCardRef(refused)).toBeNull();
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

  test("a YouTrack issue or a web link never takes the mark either", () => {
    const yt = { kind: "issue", source: "youtrack", ref: "PROJ-1", url: "https://acme.youtrack.cloud/issue/PROJ-1" };
    const web = { kind: "link", source: "web", ref: "notion.so/x", url: "https://www.notion.so/x" };
    expect(inboxCardMarkRef({ refs: [github, yt, web], prs: [] })).toEqual(github);
    expect(inboxCardMarkRef({ refs: [yt, web], prs: [] })).toBeNull();
  });
});

const youtrack = (ref: string, url: string) => ({ kind: "issue", source: "youtrack", ref, url });

describe("parseInboxCardRef: YouTrack (user feedback #10)", () => {
  test("YouTrack Cloud, with or without the summary slug, normalized to the key and its canonical URL", () => {
    expect(parseInboxCardRef("https://acme.youtrack.cloud/issue/PROJ-123")).toEqual(youtrack("PROJ-123", "https://acme.youtrack.cloud/issue/PROJ-123"));
    // The slug, query, fragment and the key's case are how it was pasted, not which issue it is.
    expect(parseInboxCardRef("https://Acme.youtrack.cloud/issue/proj-123/Crash-on-save?tab=comments#focus=Comments-4-1")).toEqual(
      youtrack("PROJ-123", "https://acme.youtrack.cloud/issue/PROJ-123"),
    );
    // A one-letter project ID is a real YouTrack ID (JetBrains' own `R`), and `_` and digits are allowed.
    expect(parseInboxCardRef("https://acme.youtrack.cloud/issue/R-1625")).toEqual(youtrack("R-1625", "https://acme.youtrack.cloud/issue/R-1625"));
    expect(parseInboxCardRef("https://acme.youtrack.cloud/issue/PRJ_ROAD-7")).toEqual(youtrack("PRJ_ROAD-7", "https://acme.youtrack.cloud/issue/PRJ_ROAD-7"));
  });

  test("an older Cloud site under myjetbrains.com/youtrack", () => {
    expect(parseInboxCardRef("https://acme.myjetbrains.com/youtrack/issue/ops-42/Slow-builds")).toEqual(youtrack("OPS-42", "https://acme.myjetbrains.com/youtrack/issue/OPS-42"));
    // The rest of myjetbrains.com is not YouTrack.
    expect(sourceOf("https://acme.myjetbrains.com/issue/OPS-42")).toBe("web");
  });

  test("a self-hosted YouTrack, only when the path is exactly [/youtrack]/issue/KEY-123[/slug] with the key in capitals", () => {
    expect(parseInboxCardRef("https://youtrack.jetbrains.com/issue/KT-55555/Some-summary")).toEqual(youtrack("KT-55555", "https://youtrack.jetbrains.com/issue/KT-55555"));
    expect(parseInboxCardRef("http://tracker.internal:8080/youtrack/issue/OPS-42")).toEqual(youtrack("OPS-42", "http://tracker.internal:8080/youtrack/issue/OPS-42"));
    // A trailing slash, after the key or the slug, is the same issue (review of #2540, P3-5).
    expect(parseInboxCardRef("https://acme.youtrack.cloud/issue/PROJ-1/")).toEqual(youtrack("PROJ-1", "https://acme.youtrack.cloud/issue/PROJ-1"));
    expect(parseInboxCardRef("https://youtrack.jetbrains.com/issue/KT-55555/Some-summary/")).toEqual(youtrack("KT-55555", "https://youtrack.jetbrains.com/issue/KT-55555"));
    for (const ordinary of [
      "https://blog.example.com/issue/ops-42", // a lowercase key on an ordinary site
      "https://example.com/issue/OPS-42/comments/7", // more than the slug
      "https://example.com/issue/OPS-42//", // not exactly
      "https://example.com/issues/OPS-42",
      "https://example.com/docs/issue/OPS-42",
      "https://example.com/issue/OPS-0",
    ]) {
      expect(sourceOf(ordinary)).toBe("web");
    }
  });

  test("never on a forge's host: a GitHub issue URL stays GitHub's, a /issue/ path on github.com is a plain link", () => {
    expect(parseInboxCardRef("https://github.com/issue/PROJ-1/issues/5")).toMatchObject({ source: "github", ref: "issue/PROJ-1#5" });
    expect(sourceOf("https://github.com/issue/PROJ-1")).toBe("web");
    expect(sourceOf("https://gitlab.com/issue/PROJ-1/slug")).toBe("web");
    expect(sourceOf("https://bitbucket.org/issue/PROJ-1")).toBe("web");
    // Atlassian's own hosts serve Jira Cloud, never a YouTrack.
    expect(sourceOf("https://acme.atlassian.net/issue/ABC-1")).toBe("web");
    expect(sourceOf("https://atlassian.net/issue/ABC-1")).toBe("web");
  });

  test("Cloud is https on its default port only, and a YouTrack issue is never a PR", () => {
    expect(sourceOf("http://acme.youtrack.cloud/issue/PROJ-1")).toBe("web");
    expect(sourceOf("https://acme.youtrack.cloud:8443/issue/PROJ-1")).toBe("web");
    expect(sourceOf("https://acme.youtrack.cloud.evil.example/issue/proj-1")).toBe("web");
    expect(parseInboxCardRef("https://acme.youtrack.cloud/issue/PROJ-1", "pr")).toBeNull();
  });
});

describe("parseInboxCardRef: any other web link (user feedback #10)", () => {
  test("an http(s) URL no source reads: a plain link, its URL as the browser writes it, its ref the short label", () => {
    expect(parseInboxCardRef("https://www.notion.so/acme/Roadmap-2026-1a2b3c4d")).toEqual({
      kind: "link",
      source: "web",
      ref: "notion.so/acme/Roadmap-2026-1a2b3c4d",
      url: "https://www.notion.so/acme/Roadmap-2026-1a2b3c4d",
    });
    expect(parseInboxCardRef("HTTPS://Linear.app:443/acme/issue/ENG-12/fix")).toMatchObject({ source: "web", url: "https://linear.app/acme/issue/ENG-12/fix" });
    // The query and fragment stay in the URL (they can be the page), and are left out of the label.
    expect(parseInboxCardRef("https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=42")).toMatchObject({ ref: "youtube.com/watch", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=42" });
    expect(parseInboxCardRef("http://intranet.acme.corp/wiki")).toMatchObject({ source: "web", url: "http://intranet.acme.corp/wiki" });
  });

  test("forge, Jira and YouTrack links are still read by their own source first", () => {
    expect(sourceOf("https://github.com/acme/widgets/pull/12")).toBe("github");
    expect(sourceOf("https://gitlab.com/g/p/-/merge_requests/3")).toBe("gitlab");
    expect(sourceOf("https://bitbucket.org/acme/widgets/pull-requests/2")).toBe("bitbucket");
    expect(sourceOf("https://example.atlassian.net/browse/DEMO-1")).toBe("jira");
    expect(sourceOf("https://acme.youtrack.cloud/issue/PROJ-1")).toBe("youtrack");
    // A web link is never a PR.
    expect(parseInboxCardRef("https://www.notion.so/acme/Roadmap", "pr")).toBeNull();
  });

  test("other schemes, credentials, whitespace and no scheme are refused", () => {
    for (const refused of [
      "javascript:alert(1)",
      "JavaScript:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://example.com/file",
      "https://github.com@evil.example/",
      "https://user:pass@example.com/",
      "https://example.com/a b",
      "https://example.com/‮gnp.exe",
      "www.example.com/page",
      "https://",
    ]) {
      expect(parseInboxCardRef(refused)).toBeNull();
    }
  });

  test("an IDN host is kept in its xn-- form; a URL past 2048 characters is refused", () => {
    expect(parseInboxCardRef("https://bücher.example/katalog")).toMatchObject({ source: "web", ref: "xn--bcher-kva.example/katalog", url: "https://xn--bcher-kva.example/katalog" });
    expect(parseInboxCardRef(`https://example.com/${"a".repeat(2100)}`)).toBeNull();
    // Written out longer than typed (each é escaped to six characters), past the cap: refused too.
    expect(parseInboxCardRef(`https://example.com/${"é".repeat(400)}`)).toBeNull();
    expect(parseInboxCardRef(`https://example.com/${"a".repeat(1900)}`)).toMatchObject({ source: "web" });
  });
});

describe("inboxCardLinkLabel", () => {
  test("host without www, the path decoded, cut in the middle when long", () => {
    expect(inboxCardLinkLabel("https://www.example.com/")).toBe("example.com");
    expect(inboxCardLinkLabel("https://example.com/docs/Caf%C3%A9/")).toBe("example.com/docs/Café");
    expect(inboxCardLinkLabel("http://localhost:3000/app")).toBe("localhost:3000/app");
    const label = inboxCardLinkLabel(`https://www.notion.so/acme/${"Roadmap-".repeat(10)}1a2b3c4d`);
    expect(Array.from(label)).toHaveLength(INBOX_CARD_LINK_LABEL_MAX);
    expect(label).toStartWith("notion.so/acme/Road");
    expect(label).toEndWith("1a2b3c4d");
    expect(label).toContain("…");
    // A decoded control or bidi character is kept escaped, so it cannot disguise the label.
    expect(inboxCardLinkLabel("https://example.com/%E2%80%AEgnp.exe")).toBe("example.com/%E2%80%AEgnp.exe");
  });
});

describe("card links in the store", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const open = () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-card-refs-"));
    roots.push(root);
    const store = InboxStore.open(root);
    return { root, store, project: store.ensureProject({ name: "app", root: "/work/app" }) };
  };
  const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" };

  test("the same web link twice is one; the same YouTrack key on two sites is two", () => {
    const { store, project } = open();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Links" });
    store.updateCard(card.id, { by: AGENT, refs: ["https://www.notion.so/acme/Roadmap", "https://WWW.notion.so/acme/Roadmap", "https://www.notion.so:443/acme/Roadmap"] });
    store.updateCard(card.id, { by: AGENT, refs: ["https://acme.youtrack.cloud/issue/PROJ-1/Slug", "https://acme.youtrack.cloud/issue/proj-1", "https://youtrack.other.example/issue/PROJ-1"] });
    expect(store.card(card.id)!.refs!.map((ref) => [ref.source, ref.ref, ref.url])).toEqual([
      ["web", "notion.so/acme/Roadmap", "https://www.notion.so/acme/Roadmap"],
      ["youtrack", "PROJ-1", "https://acme.youtrack.cloud/issue/PROJ-1"],
      ["youtrack", "PROJ-1", "https://youtrack.other.example/issue/PROJ-1"],
    ]);
  });

  test("who linked it: the person's link is marked, an agent's is not, and the person re-linking an agent's link makes it theirs", () => {
    const { root, store, project } = open();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Links", refs: ["https://linear.app/acme/issue/ENG-1"] });
    store.updateCard(card.id, { by: { kind: "person" }, refs: ["https://www.notion.so/acme/Roadmap"] });
    const by = () => store.card(card.id)!.refs!.map((ref) => [ref.url, ref.by ?? null]);
    expect(by()).toEqual([
      ["https://linear.app/acme/issue/ENG-1", null],
      ["https://www.notion.so/acme/Roadmap", "person"],
    ]);
    // An agent linking the person's link again leaves it theirs.
    store.updateCard(card.id, { by: AGENT, refs: ["https://www.notion.so/acme/Roadmap"] });
    expect(by()[1]).toEqual(["https://www.notion.so/acme/Roadmap", "person"]);
    store.updateCard(card.id, { by: { kind: "person" }, refs: ["https://linear.app/acme/issue/ENG-1"] });
    expect(by()[0]).toEqual(["https://linear.app/acme/issue/ENG-1", "person"]);
    // Read back from disk, it is still told apart.
    expect(InboxStore.open(root).card(card.id)!.refs!.map((ref) => ref.by ?? null)).toEqual(["person", "person"]);
  });
});
