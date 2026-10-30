import { describe, expect, test } from "bun:test";
import { derivePersonThreadSubject, PERSON_THREAD_SUBJECT_COLUMNS } from "./inbox-questions";
import { deriveInboxSubject } from "./inbox-questions";

/** Display columns as the rule counts them (CJK and emoji two). */
function columns(text: string): number {
  let n = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const cp = segment.codePointAt(0)!;
    n += (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff) ? 2 : 1;
  }
  return n;
}

describe("derivePersonThreadSubject: a thread the person starts gets a short name", () => {
  test("the owner's dictated paragraph is named by its first sentence, not cut at 120", () => {
    const body =
      "I want to explore what adding a board would look like. Kanban specifically. And the kanban needs to be well thought out, with a column for every state a thread can be in, and drag and drop between them so I can move things along.";
    expect(derivePersonThreadSubject(body)).toBe("I want to explore what adding a board would look like");
    // Agents' subjects keep today's rule: the whole first line, cut at 120.
    expect(deriveInboxSubject(body, [])!.length).toBe(120);
  });

  test("a first sentence that fits is whole, with no ellipsis; a question keeps its mark", () => {
    expect(derivePersonThreadSubject("Can you summarize what changed in v2.0.1 vs v2.0.0? I lost track.")).toBe("Can you summarize what changed in v2.0.1 vs v2.0.0?");
    expect(derivePersonThreadSubject("Ship it!")).toBe("Ship it!");
    expect(derivePersonThreadSubject("Fix the e.g. case in the parser. Then the rest.")).toBe("Fix the e.g. case in the parser");
  });

  test("dictation with no punctuation is cut after a whole word near 60 columns", () => {
    const body = "the inbox needs a way to see every thread by state and maybe drag them around between columns like a real board would let you do";
    const subject = derivePersonThreadSubject(body)!;
    expect(subject).toBe("the inbox needs a way to see every thread by state…");
    expect(columns(subject)).toBeLessThanOrEqual(PERSON_THREAD_SUBJECT_COLUMNS);
    // Never ends on a dangling small word before the ellipsis.
    expect(derivePersonThreadSubject("please look at the way the list sorts rows when two threads have the same time and the")).not.toMatch(/\s(the|and|a)…$/);
  });

  test("a long sentence keeps its first clause when that names something", () => {
    expect(
      derivePersonThreadSubject("I've been thinking about the inbox lately, and I want a way to see every thread by state and drag them between columns."),
    ).toBe("I've been thinking about the inbox lately…");
  });

  test("greetings and fillers at the start are dropped, and the next letter capitalized", () => {
    expect(derivePersonThreadSubject("Hey Claude, can you look at why the build is failing on main? It started this morning.")).toBe(
      "Can you look at why the build is failing on main?",
    );
    expect(derivePersonThreadSubject("So, I want a board view for the inbox.")).toBe("I want a board view for the inbox");
    expect(derivePersonThreadSubject("okay so um the toolbar covers the first line of the file.")).toBe("The toolbar covers the first line of the file");
    expect(derivePersonThreadSubject("hey can you rerun the e2e suite")).toBe("Can you rerun the e2e suite");
    // An agent's name needs no comma after it (Qwen Code is one the Inbox connects).
    expect(derivePersonThreadSubject("Hey Qwen can you rerun the e2e suite")).toBe("Can you rerun the e2e suite");
    // "So" is kept where it is part of what the person says.
    expect(derivePersonThreadSubject("So many tests fail on CI today.")).toBe("So many tests fail on CI today");
    // A greeting alone is still a name.
    expect(derivePersonThreadSubject("Hey")).toBe("Hey");
  });

  test("a URL in the first words is its host and last part; a long path its last two parts", () => {
    expect(derivePersonThreadSubject("Hey can you check https://github.com/backnotprop/plannotator/pull/1934#issuecomment-123 and tell me what you think")).toBe(
      "Can you check github.com/…/1934 and tell me what you think",
    );
    expect(derivePersonThreadSubject("https://example.com is down")).toBe("example.com is down");
    const path = derivePersonThreadSubject("/Users/ramos/src/plannotator/packages/inbox/compose/ComposeDialog.tsx throws when I paste an image")!;
    expect(path.startsWith("…/compose/ComposeDialog.tsx throws")).toBe(true);
    expect(columns(path)).toBeLessThanOrEqual(PERSON_THREAD_SUBJECT_COLUMNS);
  });

  test("CJK and other text without spaces: a sentence end, else a cut between characters", () => {
    expect(derivePersonThreadSubject("看板ボードを追加したらどうなるか検討したいです。特にカンバン方式で、スレッドの状態ごとに列を作りたい")).toBe(
      "看板ボードを追加したらどうなるか検討したいです",
    );
    const long = derivePersonThreadSubject("カンバン方式でスレッドの状態ごとに列を作りドラッグで移動できるようにしたいのですがどう思いますかちょっと考えてみてください")!;
    expect(long.endsWith("…")).toBe(true);
    expect(columns(long)).toBeLessThanOrEqual(PERSON_THREAD_SUBJECT_COLUMNS);
    // Never inside a character: a long run of emoji (each one cluster) is cut between clusters.
    const emoji = derivePersonThreadSubject("👨‍👩‍👧‍👦".repeat(40))!;
    expect(emoji.replace("…", "").length % "👨‍👩‍👧‍👦".length).toBe(0);
    expect(derivePersonThreadSubject("한국어로 된 긴 문장도 단어 경계에서 잘라야 합니다 칸반 보드를 추가하면 어떻게 될지 살펴보고 싶어요")!.endsWith("…")).toBe(true);
  });

  test("markdown: headings, emphasis, links, list and quote marks are dropped", () => {
    expect(derivePersonThreadSubject("# Kanban board\n\nSome details here.")).toBe("Kanban board");
    expect(derivePersonThreadSubject("**Board view:** a column per state.")).toBe("Board view: a column per state");
    expect(derivePersonThreadSubject("See [the spec](./docs/board.md) for the board.")).toBe("See the spec for the board");
    expect(derivePersonThreadSubject("- [ ] add a board view")).toBe("add a board view");
    expect(derivePersonThreadSubject("> Quote me on this.")).toBe("Quote me on this");
    expect(derivePersonThreadSubject("```ts\nconst x = 1\n```\n\nWhy does this compile?")).toBe("Why does this compile?");
    // snake_case and inline code survive.
    expect(derivePersonThreadSubject("Rename `read_thread` to read_threads.")).toBe("Rename read_thread to read_threads");
  });

  test("a body that is only an image or code, or names only files, still gets a name", () => {
    expect(derivePersonThreadSubject("![](./design/board-mock.png)")).toBe("board-mock.png");
    expect(derivePersonThreadSubject("![kanban sketch](./design/board-mock.png)")).toBe("kanban sketch");
    expect(derivePersonThreadSubject("![image](https://x.test/a/b/shot%201.png?w=2)")).toBe("shot 1.png");
    expect(derivePersonThreadSubject('<img src="" alt="">')).toBe("Image");
    expect(derivePersonThreadSubject("![](./a.png)", { files: ["spec.md"] })).toBe("a.png");
    expect(derivePersonThreadSubject("<br>", { files: ["spec.md", "mock.html", "notes.md"] })).toBe("spec.md and 2 more files");
    expect(derivePersonThreadSubject("```\nconst x = 1\n```")).toBe("const x = 1");
    expect(derivePersonThreadSubject("")).toBeNull();
  });

  test("a hyphenated first word is a word, not a filler and a dash", () => {
    expect(derivePersonThreadSubject("Right-click menu is missing on threads.")).toBe("Right-click menu is missing on threads");
    expect(derivePersonThreadSubject("Hi-DPI screenshots look blurry in the viewer.")).toBe("Hi-DPI screenshots look blurry in the viewer");
    expect(derivePersonThreadSubject("Well-known paths should resolve from the root.")).toBe("Well-known paths should resolve from the root");
    expect(derivePersonThreadSubject("So-called drafts never sync to the phone.")).toBe("So-called drafts never sync to the phone");
    // A dash with spaces around it still ends a filler.
    expect(derivePersonThreadSubject("So — I want a board view.")).toBe("I want a board view");
  });

  test("abbreviations, greetings that are words, and greetings alone", () => {
    expect(derivePersonThreadSubject("U.S. users see the wrong date format. Fix it.")).toBe("U.S. users see the wrong date format");
    expect(derivePersonThreadSubject("Hey there is a bug in the list sorting.")).toBe("There is a bug in the list sorting");
    expect(derivePersonThreadSubject("Hey there, can you look at the sorting?")).toBe("Can you look at the sorting?");
    expect(derivePersonThreadSubject("Hey Claude")).toBe("Hey Claude");
    expect(derivePersonThreadSubject("Hey Claude!")).toBe("Hey Claude!");
    expect(derivePersonThreadSubject("Hi")).toBe("Hi");
  });

  test("a body that is only a question block or an unclosed directive still gets a name", () => {
    expect(derivePersonThreadSubject(":::question\nShould archived threads count in the badge?\n\n- [ ] Yes\n- [ ] No\n:::")).toBe(
      "Should archived threads count in the badge?",
    );
    expect(derivePersonThreadSubject(":::note\nThe relay drops pushes after midnight.")).toBe("The relay drops pushes after midnight");
    expect(derivePersonThreadSubject(":::note")).toBe(":::note");
  });

  test("bidi controls never reach the subject", () => {
    expect(derivePersonThreadSubject("Fix ‮evil‬ name in the list.")).toBe("Fix evil name in the list");
    expect(derivePersonThreadSubject("<br>", { files: ["⁧spec.md⁩"] })).toBe("spec.md");
  });

  test("never wider than the limit, whatever the text", () => {
    const samples = [
      "a".repeat(300),
      `${"word ".repeat(80)}end`,
      "x, ".repeat(100),
      "https://example.com/" + "segment/".repeat(40),
      "日本語".repeat(80),
      "🎉 ".repeat(80),
    ];
    for (const sample of samples) {
      const subject = derivePersonThreadSubject(sample)!;
      expect(columns(subject)).toBeLessThanOrEqual(PERSON_THREAD_SUBJECT_COLUMNS);
      expect(subject.length).toBeGreaterThan(0);
    }
  });
});
