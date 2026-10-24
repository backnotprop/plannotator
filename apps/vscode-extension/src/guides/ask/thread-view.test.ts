import { describe, expect, it } from "bun:test";
import type { AnswerRecord, AskAbout } from "./answers";
import type { AskRunState } from "./session";
import { marked } from "marked";
import { THREAD_LINK_COMMANDS, answerLabel, avatarDataUri, initials, commandLink, doneMarkdown, filesRead, introMarkdown, introSentence, modelEffort, pendingMarkdown, threadLabel, threadWhere, workingMarkdown } from "./thread-view";

const lines: AskAbout = { kind: "selection", chapter: 1, chapterTitle: "Delivery loop", path: "src/webhooks/deliver.ts", side: "head", lines: { start: 25, end: 31 } };
const file: AskAbout = { kind: "file", chapter: 1, chapterTitle: "Delivery loop", path: "src/webhooks/deliver.ts", side: "head" };

/** The command and arguments of every `command:` link in a markdown body. */
function links(md: string): Array<{ text: string; command: string; args: unknown[] }> {
  return [...md.matchAll(/\[((?:\\.|[^\]\\])*)\]\(command:([^?\s]+)\?([^\s)]+)(?: "[^"]*")?\)/g)].map((m) => ({
    text: m[1].replace(/\\(.)/g, "$1"),
    command: m[2],
    args: JSON.parse(decodeURIComponent(m[3])),
  }));
}

function state(over: Partial<AskRunState> = {}): AskRunState {
  return { answerId: "ans-1", status: "working", startedAt: 1_000, activity: [], stream: "", pendingPermissions: [], autoApprove: false, offerAutoApprove: false, ...over };
}

function record(over: Partial<AnswerRecord> = {}): AnswerRecord {
  return { v: 1, id: "ans-1", guideId: "g", repoKey: "r", question: "Why?", about: lines, askedAt: 1_000, answeredAt: 7_000, status: "answered", title: "It returns a value", agent: { id: "claude", label: "Claude Code" }, seen: true, ...over } as AnswerRecord;
}

describe("the question box's words", () => {
  it("names the lines, the file or the chapter, and what goes with the question", () => {
    expect(threadLabel("Claude Code", lines, false)).toBe("Ask Claude Code · deliver.ts 25–31");
    expect(threadLabel("Claude Code", lines, true)).toBe("Claude Code · deliver.ts 25–31");
    expect(threadWhere({ ...lines, side: "base" })).toBe("deliver.ts 25–31 (old)");
    expect(threadWhere(file)).toBe("deliver.ts");
    expect(introSentence(lines)).toBe("Ask about **lines 25–31**. The lines, the file's diff, Chapter 2 and the guide go with it.");
    expect(introSentence({ ...lines, lines: { start: 9, end: 9 } })).toContain("**line 9**. The line,");
    expect(introSentence(file)).toContain("The file and its diff, Chapter 2 and the guide go with it.");
    expect(modelEffort({ model: { id: "s", label: "Sonnet" }, effort: { id: "low", label: "Low" } })).toBe("Sonnet · low");
  });

  it("offers each suggestion and earlier question as a link to its own command", () => {
    const md = introMarkdown({ threadId: "t1", about: lines, past: [{ id: "ans-9", question: "Does the worker count attempts twice?", when: "yesterday" }] });
    const found = links(md);
    expect(found.slice(0, 5).map((l) => [l.command, l.args])).toEqual([0, 1, 2, 3, 4].map((i) => [THREAD_LINK_COMMANDS.pick, ["t1", i]]));
    expect(found[0].text).toBe("Why did this change?");
    expect(found[5]).toEqual({ text: "Does the worker count attempts twice?", command: THREAD_LINK_COMMANDS.open, args: ["ans-9"] });
    // The label, then one question per line.
    expect(md).toContain("Asked before:  \n[Does the worker");
    expect(md).toContain("· yesterday");
  });

  it("keeps a question's own brackets and quotes inside its link", () => {
    const md = commandLink('What does `f(x)` do? [see "a"]', THREAD_LINK_COMMANDS.open, ["ans-1"], 'Open "it"');
    const [l] = links(md);
    expect(l.text).toBe('What does `f(x)` do? [see "a"]');
    expect(l.args).toEqual(["ans-1"]);
    expect(md).toContain('"Open  it "');
  });

  it("says a question was not asked, with a link to ask it now", () => {
    const md = introMarkdown({ threadId: "t1", about: lines, past: [], notAsked: { question: "Why?", reason: "Claude Code was answering “x”." } });
    expect(md).toContain("Not asked: “Why?”");
    expect(links(md).at(-1)).toEqual({ text: "Ask it now", command: THREAD_LINK_COMMANDS.again, args: ["t1"] });
  });

  it("shows the clock, the cost, the files read and Stop while the agent answers", () => {
    const s = state({
      cost: { amount: 0.012, currency: "USD" },
      activity: [
        { id: 1, at: 0, kind: "tool", title: "Read", locations: [{ path: "src/worker.ts" }] },
        { id: 2, at: 0, kind: "message", title: "x" },
        { id: 3, at: 0, kind: "tool", title: "Read", locations: [{ path: "src/webhooks/retryPolicy.ts" }, { path: "src/worker.ts" }] },
      ],
    });
    expect(filesRead(s)).toEqual(["retryPolicy.ts", "worker.ts"]);
    const md = workingMarkdown({ agentLabel: "Claude Code", answerId: "ans-1", state: s, now: 7_400 });
    expect(md.startsWith("$(loading~spin) **Asking Claude Code…** 0:06 · $0.01 · read retryPolicy.ts, worker.ts · ")).toBe(true);
    expect(links(md)).toEqual([{ text: "Stop", command: THREAD_LINK_COMMANDS.stop, args: ["ans-1"] }]);
    expect(workingMarkdown({ agentLabel: "Claude Code", answerId: "ans-1", state: state({ status: "starting" }), now: 1_000 })).toContain("**Starting Claude Code…** 0:00");
  });

  it("asks for the reader's OK when the agent waits on a permission", () => {
    const md = workingMarkdown({ agentLabel: "Codex", answerId: "ans-1", state: state({ pendingPermissions: [{ id: 3, title: "Run npm test", options: [] } as unknown as AskRunState["pendingPermissions"][number]] }), now: 2_000 });
    expect(md).toContain("**Codex needs your OK** · Run npm test");
    expect(links(md).map((l) => l.text)).toEqual(["Review", "Stop"]);
  });

  it("points to the answer once it ended, or says why there is none", () => {
    expect(doneMarkdown({ record: record(), opened: true })).toStartWith("$(check) **Answer opened beside the diff** · [Open](");
    expect(doneMarkdown({ record: record({ status: "text", title: undefined }), opened: false })).toStartWith("$(check) **Answer ready** · ");
    expect(doneMarkdown({ record: record({ status: "stopped" }), opened: true })).toContain("**Stopped.**");
    expect(doneMarkdown({ record: record({ status: "failed", statusMessage: "Out of credits" }), opened: true })).toContain("**No answer.** Out of credits");
    expect(links(doneMarkdown({ record: record(), opened: true }))).toEqual([{ text: "Open", command: THREAD_LINK_COMMANDS.open, args: ["ans-1"] }]);
    // An agent-written title (only in the link's tooltip) cannot add a link of its own.
    const evil = doneMarkdown({ record: record({ title: '[x](command:workbench.action.terminal.new) "' }), opened: true });
    expect(links(evil).map((l) => l.command)).toEqual([THREAD_LINK_COMMANDS.open]);
  });
});

describe("agent text in the box's trusted body", () => {
  // What an agent (or a page title, a tool call, an error message) could put in the box.
  const HOSTILE = "$(terminal) [run](command:workbench.action.terminal.new) <img src=x onerror=alert(1)> https://evil.example/x www.evil.example ops@evil.example `code` **bold** #1 \\$(check)";
  const ALLOWED = Object.values(THREAD_LINK_COMMANDS);

  /** Every link a GFM markdown renderer (VS Code's comment bodies) would make, and whether HTML or an icon got through. */
  function rendered(md: string) {
    const html = marked.parse(md, { gfm: true, async: false }) as string;
    const hrefs = [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);
    // Theme icons are $(name) in the markdown source; an escaped one is \$(name).
    const icons = [...md.matchAll(/(^|[^\\])\$\(([a-z-~]+)\)/g)].map((m) => m[2]);
    return { html, hrefs, icons };
  }

  function check(md: string, ownIcons: string[]) {
    const r = rendered(md);
    for (const href of r.hrefs) expect(ALLOWED.some((c) => href.startsWith(`command:${c}?`))).toBe(true);
    expect(r.html).not.toContain("<img");
    expect(r.html).not.toContain("<code>");
    expect(r.html).not.toContain("<strong>bold");
    expect(r.icons).toEqual(ownIcons);
  }

  it("stays text: no link, autolink, HTML, code or theme icon of its own", () => {
    check(workingMarkdown({ agentLabel: HOSTILE, answerId: "ans-1", state: state({ activity: [{ id: 1, at: 0, kind: "tool", title: "x", locations: [{ path: `src/${HOSTILE}` }] }] }), now: 2_000 }), ["loading~spin"]);
    check(workingMarkdown({ agentLabel: "Codex", answerId: "ans-1", state: state({ pendingPermissions: [{ id: 1, title: HOSTILE, options: [] } as unknown as AskRunState["pendingPermissions"][number]] }), now: 2_000 }), ["shield"]);
    check(doneMarkdown({ record: record({ status: "failed", statusMessage: HOSTILE, title: HOSTILE }), opened: true }), ["error"]);
    check(doneMarkdown({ record: record({ title: HOSTILE }), opened: true }), ["check"]);
    check(introMarkdown({ threadId: "t1", about: { ...file, path: `src/${HOSTILE}.ts` }, past: [{ id: "ans-2", question: HOSTILE, when: HOSTILE }], notAsked: { question: HOSTILE, reason: HOSTILE } }), []);
    check(pendingMarkdown(HOSTILE), ["loading~spin"]);
    // A bare address is still readable, just not a link.
    expect(rendered(doneMarkdown({ record: record({ status: "failed", statusMessage: "see https://evil.example/x" }), opened: true })).html).toContain("https://evil.example/x");
  });

  it("puts the time and cost beside the agent's name once it answered", () => {
    expect(answerLabel(record({ agent: { id: "claude", label: "Claude Code", model: { id: "s", label: "Sonnet" }, effort: { id: "low", label: "Low" } }, askedAt: 1_000, answeredAt: 10_200, cost: { amount: 0.031, currency: "USD" } }))).toBe("Sonnet · low · 9s · $0.03");
  });
});

describe("the person's avatar", () => {
  it("shows two initials for two words or more, one for one", () => {
    expect(initials("Michael Ramos")).toBe("MR");
    expect(initials("Ana María de la Cruz")).toBe("AC");
    expect(initials("ramos")).toBe("R");
    expect(initials("  ")).toBe("?");
    const svg = Buffer.from(avatarDataUri("Michael Ramos", "person").split(",")[1], "base64").toString("utf8");
    expect(svg).toContain(">MR</text>");
    expect(Buffer.from(avatarDataUri("<script>", "person").split(",")[1], "base64").toString("utf8")).not.toContain("<script");
  });
});
