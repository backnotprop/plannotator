/**
 * Inbox search's quoted phrases (`parseInboxSearchQuery` in @plannotator/core/inbox-search, the index in search.ts):
 * words in double quotes must stand together, in order, in one field; a quoted word is that whole word; a quote not
 * closed yet is a phrase of what is typed, its last token a prefix; curly quotes count; empty quotes are ignored. A
 * query with no quote mark is unchanged (search-parity.test.ts holds that). The marks a row carries draw a phrase as
 * one run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxSearchRanges, inboxSearchTerms, parseInboxSearchQuery } from "@plannotator/core/inbox-search";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxSearchIndex, type InboxSearchAnswer, type InboxSearchMessageRow, type InboxSearchQuery, type InboxSearchThreadRow } from "./search";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

let clock = Date.parse("2026-10-01T10:00:00Z");
function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-search-quoted-"));
  roots.push(dir);
  return InboxStore.open(dir, { now: () => new Date((clock += 60_000)) });
}

const CLAUDE: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const ASK = (prompt: string, choices: string[]) => ["", ":::question", prompt, "", ...choices.map((c) => `- [ ] ${c}`), ":::"].join("\n");

async function built(store: InboxStore) {
  const index = new InboxSearchIndex(store);
  await index.ensureBuilt();
  return index;
}

const search = (index: InboxSearchIndex, q: string, more: Omit<InboxSearchQuery, "q"> = {}): InboxSearchAnswer => index.search({ q, ...more });
const messageIds = (answer: InboxSearchAnswer) => (answer.groups?.messages ?? []).map((r) => r.id);
const threadIds = (answer: InboxSearchAnswer) => (answer.groups?.threads ?? []).map((r) => r.id);
const sorted = (ids: string[]) => [...ids].sort();
const marked = (text: string, marks: [number, number][]) => marks.map(([a, l]) => text.slice(a, a + l));

/** A store with the phrase, the words far apart, the words the other way round, and near words. */
function world() {
  const store = open();
  const project = store.ensureProject({ name: "harbor", root: "/w/harbor" });
  const send = (thread: string, body: string, subject = "Notes") => store.sendMessage({ project_id: project.id, author: CLAUDE, subject, thread, body }).message;
  const phrase = send("a", "Open the file viewer and the page stays blank.");
  const far = send("b", "The file is large. Later, the viewer is slow and the page goes blank.");
  const reversed = send("c", "The viewer file is cached.");
  const plural = send("d", "Two files viewer side by side.");
  const phraseOnly = send("e", "The file viewer opens fast.");
  return { store, project, send, phrase, far, reversed, plural, phraseOnly };
}

describe("quoted phrases in the index", () => {
  test("a phrase: only where its words stand together, in order; without quotes every one of them", async () => {
    const { store, phrase, far, reversed, plural, phraseOnly } = world();
    const index = await built(store);
    expect(sorted(messageIds(search(index, "file viewer")))).toEqual(sorted([phrase.id, far.id, reversed.id, phraseOnly.id]));
    expect(sorted(messageIds(search(index, '"file viewer"')))).toEqual(sorted([phrase.id, phraseOnly.id]));
    expect(messageIds(search(index, '"viewer file"'))).toEqual([reversed.id]);
    // A quoted phrase holds whole words: "files viewer" is not "file viewer".
    expect(messageIds(search(index, '"files viewer"'))).toEqual([plural.id]);
  });

  test("a phrase never spans two fields: a subject and a thread name, a body and a question", async () => {
    const store = open();
    const project = store.ensureProject({ name: "fern-api", root: "/w/fern-api" });
    const named = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Fix the file", thread: "viewer polish", body: "Nothing here." }).message;
    const asked = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Ask", thread: "q", body: `Read the file${ASK("viewer or editor?", ["Viewer", "Editor"])}` }).message;
    const index = await built(store);
    expect(threadIds(search(index, "file viewer"))).toContain(named.id);
    expect(messageIds(search(index, "file viewer"))).toContain(asked.id);
    const quoted = search(index, '"file viewer"');
    expect(threadIds(quoted)).toEqual([]);
    expect(messageIds(quoted)).toEqual([]);
    // The same words inside one field do match.
    expect(threadIds(search(index, '"viewer polish"'))).toEqual([named.id]);
  });

  test("a phrase and a word: the phrase, and the word anywhere (the last word still a prefix)", async () => {
    const { store, phrase, phraseOnly, far } = world();
    const index = await built(store);
    expect(messageIds(search(index, '"file viewer" blank'))).toEqual([phrase.id]);
    expect(messageIds(search(index, '"file viewer" bla'))).toEqual([phrase.id]);
    expect(messageIds(search(index, 'blank "file viewer"'))).toEqual([phrase.id]);
    // Without quotes the far one is found too.
    expect(sorted(messageIds(search(index, "file viewer blank")))).toEqual(sorted([phrase.id, far.id]));
    expect(messageIds(search(index, '"file viewer" fast'))).toEqual([phraseOnly.id]);
  });

  test("two phrases: both must stand", async () => {
    const { store, send, phrase } = world();
    const both = send("f", "In the file viewer the blank page shows.");
    const index = await built(store);
    expect(messageIds(search(index, '"file viewer" "blank page"'))).toEqual([both.id]);
    expect(sorted(messageIds(search(index, '"file viewer" "page"')))).toEqual(sorted([phrase.id, both.id]));
    expect(messageIds(search(index, '"file viewer" "page blank"'))).toEqual([]);
  });

  test("a quoted word is that whole word, never a prefix", async () => {
    const { store, phrase, far, reversed, plural, phraseOnly } = world();
    const index = await built(store);
    expect(messageIds(search(index, "file"))).toContain(plural.id);
    expect(sorted(messageIds(search(index, '"file"')))).toEqual(sorted([phrase.id, far.id, reversed.id, phraseOnly.id]));
    expect(messageIds(search(index, '"fil"'))).toEqual([]);
    expect(messageIds(search(index, '"files"'))).toEqual([plural.id]);
  });

  test("a quote not closed yet: the phrase typed so far, its last token a prefix", async () => {
    const { store, phrase, far, plural, phraseOnly } = world();
    const index = await built(store);
    expect(sorted(messageIds(search(index, '"file view')))).toEqual(sorted([phrase.id, phraseOnly.id]));
    expect(sorted(messageIds(search(index, '"file viewer')))).toEqual(sorted([phrase.id, phraseOnly.id]));
    // One open word is a prefix, as an unquoted last word is.
    expect(messageIds(search(index, '"fil'))).toContain(plural.id);
    expect(messageIds(search(index, '"file viewer" "bla'))).toEqual([phrase.id]);
    expect(messageIds(search(index, '"file view'))).not.toContain(far.id);
  });

  test("curly quotes count as quotes; empty quotes are ignored", async () => {
    const { store, phrase, phraseOnly } = world();
    const index = await built(store);
    const want = sorted([phrase.id, phraseOnly.id]);
    expect(sorted(messageIds(search(index, "“file viewer”")))).toEqual(want);
    expect(sorted(messageIds(search(index, "“file viewer\"")))).toEqual(want);
    expect(messageIds(search(index, '"" files'))).toEqual(messageIds(search(index, "files")));
    expect(search(index, '""').recent).not.toBeNull();
  });

  test("both orders: best match and newest find the same phrase rows", async () => {
    const { store, phrase, phraseOnly } = world();
    const index = await built(store);
    expect(sorted(messageIds(search(index, '"file viewer"', { sort: "best" })))).toEqual(sorted([phrase.id, phraseOnly.id]));
    // Newest: the later message first.
    expect(messageIds(search(index, '"file viewer"', { sort: "newest" }))).toEqual([phraseOnly.id, phrase.id]);
  });

  test("a filter with a phrase: From me, a project, Archived", async () => {
    const { store, phrase, phraseOnly, send } = world();
    const other = store.ensureProject({ name: "quill-docs", root: "/w/quill-docs" });
    const elsewhere = store.sendMessage({ project_id: other.id, author: CLAUDE, subject: "Docs", thread: "z", body: "The file viewer in docs." }).message;
    store.sendMessage({ project_id: other.id, author: CLAUDE, subject: "Docs", thread: "y", body: "A file, and a viewer, in docs." });
    const reply = store.sendReply(phrase.thread_id, { idempotency_key: "k1", words: "The file viewer is fine by me." }).reply;
    store.sendReply(phraseOnly.thread_id, { idempotency_key: "k2", words: "That file? The viewer? Fine." });
    const archived = send("g", "Old file viewer notes.");
    store.resolveThread(archived.id, true);
    const archivedFar = send("h", "Old file, old viewer.");
    store.resolveThread(archivedFar.id, true);
    const index = await built(store);
    expect(messageIds(search(index, '"file viewer"', { from: "me" }))).toEqual([reply.id]);
    expect(messageIds(search(index, '"file viewer"', { project: other.id }))).toEqual([elsewhere.id]);
    expect(messageIds(search(index, '"file viewer"', { status: "archived" }))).toEqual([archived.id]);
    expect(messageIds(search(index, '"file viewer"', { from: "agent" }))).not.toContain(reply.id);
    expect(messageIds(search(index, '"file viewer"', { from: "agent" }))).toEqual(expect.arrayContaining([phrase.id, phraseOnly.id]));
  });

  test("ids and hashes inside quotes: whole, next to the words", async () => {
    const store = open();
    const project = store.ensureProject({ name: "ledger", root: "/w/ledger" });
    const send = (thread: string, body: string) => store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Deploy", thread, body }).message;
    const full = "9fceb02d0ae598e95dc970b74767f19372d61af8";
    const next = send("a", `We deployed ${full} today.`);
    const apart = send("b", `We deployed today, then tagged ${full}.`);
    const short = send("c", "Tagged 9fceb02d0ae5 by hand.");
    const index = await built(store);
    expect(sorted(messageIds(search(index, `deployed ${full}`)))).toEqual(sorted([next.id, apart.id]));
    expect(messageIds(search(index, `"deployed ${full}"`))).toEqual([next.id]);
    expect(messageIds(search(index, '"tagged 9fceb02d0ae5"'))).toEqual([short.id]);
    // A quoted start of an id is not the id: a quoted word is whole.
    expect(messageIds(search(index, '"tagged 9fceb02d"'))).toEqual([]);
    // Open, the last token is a start: of the short id and of the long one.
    expect(sorted(messageIds(search(index, '"tagged 9fceb02d')))).toEqual(sorted([short.id, apart.id]));
  });

  test("a word repeated in a phrase; the 8-term cap", async () => {
    const { store, send } = world();
    const twice = send("h", "It is very very slow.");
    const once = send("i", "It is very slow, very.");
    const index = await built(store);
    expect(messageIds(search(index, '"very very"'))).toEqual([twice.id]);
    expect(sorted(messageIds(search(index, "very very")))).toEqual(sorted([twice.id, once.id]));
    expect(parseInboxSearchQuery('"one two three four five six seven eight nine"').terms).toHaveLength(8);
  });
});

describe("marks for a quoted query", () => {
  test("a row marks the phrase as one run, and the word as before", async () => {
    const { store, phrase } = world();
    const index = await built(store);
    const answer = search(index, '"file viewer" blank');
    expect(answer.terms).toEqual(['"file viewer"', "blank"]);
    const row = answer.groups!.messages!.find((r) => r.id === phrase.id) as InboxSearchMessageRow;
    expect(marked(row.snippet.text, row.snippet.marks)).toEqual(["file viewer", "blank"]);
  });

  test("a thread title marks the phrase where it stands, not each word everywhere", async () => {
    const store = open();
    const project = store.ensureProject({ name: "harbor", root: "/w/harbor" });
    const root = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "The viewer: a file viewer for a file", thread: "t", body: "x" }).message;
    const index = await built(store);
    const row = search(index, '"file viewer"').groups!.threads!.find((r) => r.id === root.id) as InboxSearchThreadRow;
    expect(marked(row.title, row.title_marks)).toEqual(["file viewer"]);
    const loose = search(index, "file viewer").groups!.threads!.find((r) => r.id === root.id) as InboxSearchThreadRow;
    expect(marked(loose.title, loose.title_marks)).toEqual(["viewer", "file", "viewer", "file"]);
  });

  test("a long body's row is drawn around the phrase, not an earlier lone word", async () => {
    const { store, project } = world();
    const body = ["The file comes first.", ...Array.from({ length: 3000 }, (_, i) => `Line ${i} of filler words.`), "Then the file viewer, at the end."].join("\n");
    const message = store.sendMessage({ project_id: project.id, author: CLAUDE, subject: "Long", thread: "long", body }).message;
    const index = await built(store);
    const row = search(index, '"file viewer"').groups!.messages!.find((r) => r.id === message.id) as InboxSearchMessageRow;
    expect(marked(row.snippet.text, row.snippet.marks)).toEqual(["file viewer"]);
  });

  test("inboxSearchRanges: a phrase as one run, an open one with its typed part, a quoted word whole", () => {
    const text = "The file is a file viewer; files viewer too.";
    const ranges = (marks: string[], options = {}) => inboxSearchRanges(text, marks, options).map(([a, b]) => text.slice(a, b));
    expect(ranges(['"file viewer"'])).toEqual(["file viewer"]);
    expect(ranges(['"file view'])).toEqual(["file view"]);
    expect(ranges(['"file"'])).toEqual(["file", "file"]);
    expect(ranges(['"fil'])).toEqual(["fil", "fil", "fil"]);
    expect(ranges(['"file viewer"', "too"])).toEqual(["file viewer", "too"]);
    // A word inside a phrase run is one run, never two overlapping.
    expect(ranges(["file", '"file viewer"'])).toEqual(["file", "file viewer"]);
    // The landing marks every word as a prefix; a phrase stays a phrase.
    expect(ranges(['"file viewer"', "to"], { prefixAll: true })).toEqual(["file viewer", "to"]);
  });
});

describe("parseInboxSearchQuery", () => {
  test("no quote mark: the terms as before, the same array as the marks", () => {
    for (const q of ["file viewer", "file viewer file", "rate lim", "  résumé  ", "日本語のテキスト", ""]) {
      const parsed = parseInboxSearchQuery(q);
      expect(parsed.terms).toEqual(inboxSearchTerms(q));
      expect(parsed.prefixLast).toBe(true);
      expect(parsed.quoted).toBe(false);
      expect(parsed.marks).toBe(parsed.terms);
    }
  });

  test("phrases, words and the one prefix", () => {
    expect(parseInboxSearchQuery('"file viewer" blank')).toEqual({ terms: ["file", "viewer", "blank"], prefixLast: true, phrases: [[0, 1]], marks: ['"file viewer"', "blank"], quoted: true });
    expect(parseInboxSearchQuery('blank "file viewer"')).toMatchObject({ terms: ["blank", "file", "viewer"], prefixLast: false, phrases: [[1, 2]] });
    expect(parseInboxSearchQuery('"file view')).toMatchObject({ terms: ["file", "view"], prefixLast: true, phrases: [[0, 1]], marks: ['"file view'] });
    expect(parseInboxSearchQuery('"file"')).toMatchObject({ terms: ["file"], prefixLast: false, phrases: [], marks: ['"file"'] });
    // An open phrase ending on a word it already holds: the prefix keeps a term of its own.
    expect(parseInboxSearchQuery('"file viewer file')).toMatchObject({ terms: ["file", "viewer", "file"], prefixLast: true, phrases: [[0, 1, 2]] });
    expect(parseInboxSearchQuery("“file viewer”")).toMatchObject({ terms: ["file", "viewer"], prefixLast: false, phrases: [[0, 1]] });
    expect(parseInboxSearchQuery('"" file')).toMatchObject({ terms: ["file"], prefixLast: true, phrases: [], marks: ["file"] });
  });
});
