/**
 * Export decisions (design brief "export-decisions"): the v1 shape over a real store in a temp folder, and the two
 * documents read back by structure (Markdown through `marked`'s lexer, HTML through Bun's HTMLRewriter), never by
 * wording.
 *
 * What regresses: a question card missing, or in the wrong group for its state; the counts drifting from Decision data's
 * on the same store; an unsent pick passing for a sent one; a session id, a local path or a localhost/tailnet address
 * reaching any output; thread
 * text injecting HTML or Markdown structure; the HTML making a request or losing its embedded JSON or its dark look;
 * the v1 JSON's field names (the wire later sharing reads) changing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marked, type Token, type Tokens } from "marked";
import { decisionDataSummary, decisionRowOf } from "./decision-data";
import { buildDecisionExport, decisionExportFileName, scrubDecisionText, type DecisionExportV1 } from "./decision-export";
import { DECISION_EXPORT_HTML_CSP, renderDecisionExportHtml } from "./decision-export-html";
import { renderDecisionExportMarkdown } from "./decision-export-md";
import { InboxStore } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-11-10T12:00:00Z");
const SESSION = "ses-secret-7f3a91";

function world() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-decision-export-")));
  dirs.push(dir);
  let clock = NOW - 86_400_000;
  const store = InboxStore.open(dir, { now: () => new Date((clock += 60_000)) });
  const project = store.ensureProject({ name: "acme-notes", root: join(dir, "acme-notes") });
  const agent = { kind: "agent" as const, host: "claude-code", session: SESSION, name: null };
  let keys = 0;
  const key = () => `k${keys++}`;
  const block = (prompt: string, extra = "", rec = "A") => `:::question\n${prompt}\n${extra}\n- [ ] A\n- [ ] B\n${rec ? `\nRecommended: ${rec}\n` : ""}:::`;
  const send = (body: string, replyTo?: string) =>
    store.sendMessage({ project_id: project.id, author: agent, body, idempotency_key: key(), ...(replyTo ? { reply_to: replyTo } : { thread: `t${keys}` }) }).message;
  const qs = (id: string) => store.questionsOf(id);
  const pick = (id: string, i: number, answer: object) => {
    const q = qs(id)[i]!;
    store.savePicks(id, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [], ...answer } }]);
  };
  const sendPicks = (id: string, indexes: number[]) =>
    store.sendReply(id, { questions: indexes.map((i) => ({ key: qs(id)[i]!.key, revision: qs(id)[i]!.revision })), idempotency_key: key() });
  const exported = (threadId: string, pulls: DecisionExportV1["pulls"] = []) => {
    const input = store.decisionExportInput(threadId)!;
    return buildDecisionExport(input, { now: new Date(NOW), tz: "America/Los_Angeles", generator: "Plannotator test", pulls, home: "/Users/alice" });
  };
  return { dir, store, project, send, qs, pick, sendPicks, block, exported, key };
}

/** One thread holding every fate a question can have while its thread is open. */
function everyFate() {
  const w = world();
  const root = w.send([w.block("Keep the losing version where?"), w.block("Which apps first?"), w.block("Old retry question?")].join("\n\n"));
  w.pick(root.id, 0, { selected: ["A"] });
  w.pick(root.id, 1, { selected: ["B"], note: "B because the storage code is shared." });
  w.sendPicks(root.id, [0, 1]);
  const second = w.send([w.block("Rename Sync?"), w.block("Unsent pick here?"), w.block("Nobody touched this?")].join("\n\n"), root.id);
  w.pick(second.id, 0, { skipped: true });
  w.sendPicks(second.id, [0]);
  w.pick(second.id, 1, { selected: ["A"], note: "UNSENT-NOTE-do-not-export" });
  const old = w.qs(root.id)[2]!;
  const third = w.send(w.block("How should a failed upload retry?", `Replaces: ${root.id}/${old.key}`), root.id);
  w.pick(third.id, 0, { selected: ["A"] });
  w.sendPicks(third.id, [0]);
  w.send(":::action\nRun the migration.\n:::", root.id);
  return { w, threadId: root.thread_id };
}

describe("which question goes where", () => {
  test("every question card is listed with its state: decisions first, then each group in the order asked; action items are not; the counts are Decision data's", async () => {
    const { w, threadId } = everyFate();
    const { doc } = w.exported(threadId);
    expect(doc.decisions.map((d) => [d.n, d.prompt, d.state])).toEqual([
      [1, "Keep the losing version where?", "decided"],
      [2, "Which apps first?", "decided"],
      [3, "How should a failed upload retry?", "decided"],
    ]);
    expect(doc.others.map((d) => [d.n, d.prompt, d.state])).toEqual([
      [4, "Nobody touched this?", "open"],
      [5, "Unsent pick here?", "picked_unsent"],
      [6, "Rename Sync?", "skipped"],
      [7, "Old retry question?", "replaced"],
    ]);
    // The owner's choice: an unsent pick is shown, marked as not sent.
    expect(doc.others[1]!.answer).toMatchObject({ selected: ["A"], sent: false, note: "UNSENT-NOTE-do-not-export" });
    expect(doc.others[0]!.answer).toBeNull();
    expect(doc.others[3]!.replaced_by).toEqual({ id: expect.stringContaining("/q-"), prompt: "How should a failed upload retry?" });
    expect(doc.decisions[2]!.replaces!.map((r) => r.prompt)).toEqual(["Old retry question?"]);
    expect(doc.decisions.every((d) => d.answer?.sent === true)).toBe(true);
    expect([...doc.decisions, ...doc.others].some((d) => d.prompt.includes("migration"))).toBe(false);
    expect(doc.decisions.map((d) => d.recommendation.taken)).toEqual([true, false, true]);
    expect(doc.decisions[0]!.choices.map((c) => c.chosen)).toEqual([true, false]);

    // The same store through Decision data: its fates for this thread, and its page's counts.
    const input = w.store.decisionDataInput();
    const fates = input.questions
      .map((q) => decisionRowOf(q, input.byId, input.headOf, input.closedByArchive))
      .filter((row) => row?.thread_id === threadId)
      .map((row) => row!.fate);
    const n = (name: string) => fates.filter((f) => f === name).length;
    expect([doc.counts.decided, doc.counts.picked_unsent, doc.counts.open, doc.counts.skipped, doc.counts.replaced]).toEqual([n("answered"), n("picked_unsent"), n("open"), n("skipped"), n("replaced")]);
    expect(doc.decisions.length + doc.others.length).toBe(fates.length);
    const summary = await decisionDataSummary(input, { since: null, until: NOW + 86_400_000, tz_offset_min: 0, now: NOW });
    expect(doc.counts.decided).toBe(summary.counts.answered);
    expect(doc.counts.skipped).toBe(summary.counts.skipped);
    expect(doc.counts.replaced).toBe(summary.counts.replaced);
  });

  test("a question the person answered with a plain reply is 'answered in words', as Decision data counts it", async () => {
    const w = world();
    const m = w.send([w.block("Words instead?"), w.block("Also words?")].join("\n\n"));
    w.store.sendReply(m.id, { words: "Go with the simpler one for both.", idempotency_key: w.key() });
    const later = w.send(w.block("Asked after the words?"), m.id);
    void later;
    const { doc } = w.exported(m.thread_id);
    expect(doc.others.map((d) => [d.prompt, d.state])).toEqual([
      ["Asked after the words?", "open"],
      ["Words instead?", "answered_in_words"],
      ["Also words?", "answered_in_words"],
    ]);
    const input = w.store.decisionDataInput();
    const summary = await decisionDataSummary(input, { since: null, until: NOW + 86_400_000, tz_offset_min: 0, now: NOW });
    expect(doc.counts.answered_in_words).toBe(summary.settled_in_words);
  });

  test("Mark read and the archive: set aside shows no answer (the Inbox's own skip), an archived pick shows as not sent", () => {
    const w = world();
    const read = w.send([w.block("Closed by Mark read?"), w.block("Answered before?")].join("\n\n"));
    w.pick(read.id, 1, { selected: ["A"] });
    w.sendPicks(read.id, [1]);
    w.pick(read.id, 0, { selected: ["B"] });
    w.store.markRead(read.thread_id, true);
    const a = w.exported(read.thread_id).doc;
    expect(a.others.map((d) => [d.state, d.answer])).toEqual([["set_aside", null]]);
    expect(a.decisions.map((d) => d.prompt)).toEqual(["Answered before?"]);

    const archived = w.send(w.block("Archived while open?"));
    w.pick(archived.id, 0, { selected: ["A"] });
    w.store.resolveThread(archived.id, true, "person");
    const b = w.exported(archived.thread_id).doc;
    expect(b.others.map((d) => d.state)).toEqual(["archived"]);
    expect(b.others[0]!.answer).toMatchObject({ selected: ["A"], sent: false });
  });

  test("a thread whose questions are all waiting has no decisions and no index table", () => {
    const w = world();
    const m = w.send(w.block("Waiting?"));
    const { doc } = w.exported(m.thread_id);
    expect(doc.decisions).toEqual([]);
    expect(doc.others.map((d) => d.state)).toEqual(["open"]);
    const tokens = marked.lexer(renderDecisionExportMarkdown(doc));
    expect(tokens.some((t) => t.type === "table")).toBe(false);
  });
});

describe("privacy", () => {
  test("no session id, home path, local address or store path in any output, an unsent pick's words included", () => {
    const w = world();
    const leaky = [
      "Context: See /Users/alice/work/plan.md and C:\\Users\\bob\\x.txt and /home/carol/notes, open http://localhost:5173/proto or https://my-mac.tail1234.ts.net:8443/x or 127.0.0.1:4000/a.",
      "Prototype: http://localhost:3000/settings",
      "Shows: [plan](/Users/alice/work/plan.html)",
    ].join("\n");
    const root = w.send(w.block("Which layout at http://192.168.1.20:8080/a?", leaky));
    w.pick(root.id, 0, { selected: ["A"], note: "Saw it at http://100.101.102.103:9000/p, file /Users/alice/x" });
    w.sendPicks(root.id, [0]);
    const later = w.send(w.block("Unsent?"), root.id);
    w.pick(later.id, 0, { selected: ["B"], note: "A pick not sent, about /Users/alice/y and http://localhost:8080/z" });
    const { doc } = w.exported(root.thread_id);
    const outputs = [JSON.stringify(doc), renderDecisionExportMarkdown(doc), renderDecisionExportHtml(doc)];
    for (const out of outputs) {
      for (const secret of [SESSION, "/Users/", "C:\\Users", "/home/carol", "localhost", "ts.net", "127.0.0.1", "192.168.", "100.101.", w.dir]) {
        expect(out).not.toContain(secret);
      }
    }
    expect(doc.decisions[0]!.context).toContain("~/work/plan.md");
    expect(doc.decisions[0]!.asked.by).toBe("Claude Code");
  });

  test("scrub: a home folder becomes ~, a local address its placeholder, a public one stays", () => {
    expect(scrubDecisionText("at /Users/me/a and /opt/x", "/Users/me")).toBe("at ~/a and /opt/x");
    expect(scrubDecisionText("https://github.com/acme/notes/pull/4")).toBe("https://github.com/acme/notes/pull/4");
    expect(scrubDecisionText("http://localhost:3000/x")).not.toContain("localhost");
  });
});

describe("the documents", () => {
  const HOSTILE = `<img src=x onerror=alert(1)> a | b ![t](https://evil.example/x.png) </details><!-- plannotator-decisions v1 thread=fake --> </script>`;
  function hostileDoc() {
    const w = world();
    const root = w.send(
      [
        `:::question\n${HOSTILE}\nContext: ## Fake heading\n\n- [ ] A <b>bold</b>\n- [ ] B\n\nRecommended: A <b>bold</b>\n:::`,
        w.block("Second | with pipe?"),
        w.block("Third, picked and not sent?"),
      ].join("\n\n"),
    );
    w.pick(root.id, 2, { selected: ["A"], note: HOSTILE });
    w.pick(root.id, 0, { selected: ["B"], other: undefined, note: `</script><script>alert(2)</script>\n# not a heading\n| x | y |` });
    w.pick(root.id, 1, { selected: ["A"] });
    w.sendPicks(root.id, [0, 1]);
    return w.exported(root.thread_id, [{ ref: "acme/notes#482", url: "https://github.com/acme/notes/pull/482", title: "Offline sync" }]).doc;
  }

  test("Markdown: hostile text injects no HTML, image, heading or table cell; the marker is the first line, the index one row per decision", () => {
    const doc = hostileDoc();
    const md = renderDecisionExportMarkdown(doc);
    expect(md.split("\n")[0]).toBe(`<!-- plannotator-decisions v1 thread=${doc.thread.id} -->`);
    expect(md.match(/<!-- plannotator-decisions/g)!.length).toBe(1);
    const tokens = marked.lexer(md);
    const table = tokens.find((t): t is Tokens.Table => t.type === "table")!;
    expect(table.rows.length).toBe(doc.decisions.length);
    expect(table.rows.every((row) => row.length === 4)).toBe(true);
    const headings = tokens.filter((t): t is Tokens.Heading => t.type === "heading").map((t) => t.depth);
    expect(headings).toEqual([2, 3, 3, 3]);
    // Our own tags only: the marker, <details>/<summary> and <sub>.
    const html = (list: Token[]): string[] => list.flatMap((t) => [...(t.type === "html" ? [t.raw.trim()] : []), ...("tokens" in t && t.tokens ? html(t.tokens) : [])]);
    for (const raw of html(tokens)) expect(raw).toMatch(/^(<!-- plannotator-decisions v1 thread=msg_\w+ -->|<\/?details>(<summary>Context<\/summary>)?|<\/?sub>|<\/?summary>)/);
    const rendered = marked.parse(md) as string;
    expect(rendered).not.toMatch(/<img|<script|<b>/i);
    // The chosen choice is the checked box.
    const lists = tokens.filter((t): t is Tokens.List => t.type === "list" && t.items.some((i) => i.task));
    expect(lists[0]!.items.map((i) => i.checked)).toEqual([false, true]);
  });

  async function walk(html: string) {
    const found = { tags: [] as string[], attrs: [] as [string, string, string][], scripts: [] as string[], jsonText: "", text: "" };
    let inJson = false;
    let inScript = false;
    let scriptText = "";
    await new HTMLRewriter()
      .on("*", {
        element(el) {
          found.tags.push(el.tagName);
          for (const [name, value] of el.attributes) found.attrs.push([el.tagName, name, value]);
          if (el.tagName === "script") {
            inJson = el.getAttribute("type") === "application/json";
            inScript = !inJson;
            scriptText = "";
            el.onEndTag(() => {
              if (inScript) found.scripts.push(scriptText);
              inJson = inScript = false;
            });
          }
        },
        text(chunk) {
          if (inJson) found.jsonText += chunk.text;
          else if (inScript) scriptText += chunk.text;
          else found.text += chunk.text;
        },
      })
      .transform(new Response(html))
      .text();
    return found;
  }

  test("HTML: one self-contained file that makes no request, with its JSON, light and dark, and hostile text as text", async () => {
    const doc = hostileDoc();
    const html = renderDecisionExportHtml(doc);
    const page = await walk(html);
    expect(page.tags.filter((t) => ["link", "iframe", "object", "embed", "form", "base", "img", "audio", "video", "source"].includes(t))).toEqual([]);
    for (const [tag, name, value] of page.attrs) {
      expect(name.startsWith("on")).toBe(false);
      if (name === "src") throw new Error(`${tag} has src ${value}`);
      if (name === "href") expect(value.startsWith("#") || value === "https://github.com/acme/notes/pull/482").toBe(true);
    }
    expect(html).not.toMatch(/url\(|@import/i);
    expect(page.attrs).toContainEqual(["meta", "content", DECISION_EXPORT_HTML_CSP]);
    expect(DECISION_EXPORT_HTML_CSP).toContain("default-src 'none'");
    expect(DECISION_EXPORT_HTML_CSP).toContain("img-src data:");
    // One script of our own, allowed by its hash; the hostile </script> never opened another.
    expect(page.scripts.length).toBe(1);
    expect(DECISION_EXPORT_HTML_CSP).toContain(`'sha256-${new Bun.CryptoHasher("sha256").update(page.scripts[0]!).digest("base64")}'`);
    const embedded = JSON.parse(page.jsonText) as DecisionExportV1;
    expect(embedded).toEqual({ ...doc, images: {} });
    // HTMLRewriter hands text over as written: escaped.
    expect(page.text).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain("@media print");
  });

  test("HTML pictures: only a data: picture is drawn; anything else shows its alt text", async () => {
    const w = world();
    const m = w.send(":::question\nWhich look?\n\n- [ ] Banner — ![Yellow bar](mock/banner.png)\n- [ ] Panel — ![Side panel](https://evil.example/p.png)\n:::");
    w.pick(m.id, 0, { selected: ["Banner"] });
    w.sendPicks(m.id, [0]);
    const { doc, pictures } = w.exported(m.thread_id);
    expect(pictures.map((p) => p.src)).toEqual(["mock/banner.png", "https://evil.example/p.png"]);
    const [a, b] = doc.decisions[0]!.choices.map((c) => c.image!.ref);
    doc.images[a!] = "data:image/png;base64,iVBORw0KGgo=";
    doc.images[b!] = "https://evil.example/p.png";
    const page = await walk(renderDecisionExportHtml(doc));
    expect(page.attrs.filter(([, name]) => name === "src").map(([, , v]) => v)).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
    // The Markdown never embeds a picture.
    expect(renderDecisionExportMarkdown(doc)).not.toContain("](");
  });

  test("the v1 JSON's field names stay what later readers expect", () => {
    const { w, threadId } = everyFate();
    const { doc } = w.exported(threadId, [{ ref: "acme/notes#482", url: "https://github.com/acme/notes/pull/482", title: null }]);
    expect(Object.keys(doc).sort()).toEqual(["counts", "decisions", "exported_at", "format", "generator", "images", "others", "pulls", "thread", "tz", "v"]);
    expect([doc.format, doc.v, doc.tz]).toEqual(["plannotator.decisions", 1, "America/Los_Angeles"]);
    expect(Object.keys(doc.thread).sort()).toEqual(["id", "last_at", "project", "started_at", "subject"]);
    expect(Object.keys(doc.counts).sort()).toEqual(["answered_in_words", "archived", "decided", "open", "picked_unsent", "replaced", "set_aside", "skipped"]);
    const d = doc.decisions[1]!;
    expect(Object.keys(d).sort()).toEqual(["answer", "answered", "asked", "choices", "id", "kind", "n", "prompt", "recommendation", "replaces", "state"]);
    expect(Object.keys(d.answer!).sort()).toEqual(["note", "other", "selected", "sent", "skipped", "text"]);
    expect(Object.keys(doc.others.find((o) => o.state === "replaced")!).sort()).toContain("replaced_by");
    expect(Object.keys(d.recommendation).sort()).toEqual(["labels", "taken", "text"]);
    expect(Object.keys(d.asked).sort()).toEqual(["at", "by", "message_id"]);
    expect(Object.keys(d.choices[0]!).sort()).toEqual(["chosen", "label", "recommended"]);
    expect(d.asked.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  test("file names: decisions-<slug at most 50>-<the reader's date>", () => {
    const base = { thread: { subject: "Offline sync: what happens when two edits collide — and then some more words here" }, exported_at: "2026-11-11T03:00:00Z" } as DecisionExportV1;
    const la = decisionExportFileName({ ...base, tz: "America/Los_Angeles" }, "md");
    expect(la).toMatch(/^decisions-[a-z0-9-]{1,50}-2026-11-10\.md$/);
    expect(decisionExportFileName({ ...base, tz: "UTC" }, "html")).toMatch(/-2026-11-11\.html$/);
    expect(decisionExportFileName({ ...base, thread: { subject: "???" }, tz: "UTC" } as DecisionExportV1, "md")).toBe("decisions-thread-2026-11-11.md");
  });
});
