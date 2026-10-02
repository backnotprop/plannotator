/**
 * Parity between core's `findQuestionBlocks` (what a server uses to locate and
 * verify a question without the UI) and the blocks this package renders
 * (`parseMarkdownToBlocks` + `indexQuestionBlocks`). Both split the document
 * with the shared `@plannotator/core/markdown-structure` helpers; this test is
 * what fails if the two scans ever disagree about which `:::question` lines
 * open a block, where it ends, or which key (including the `-2` suffix) it
 * gets — the failure that would make a server reject an answer the UI sent.
 */
import { describe, expect, test } from "bun:test";
import { findQuestionBlocks, indexQuestionBlocks } from "@plannotator/core/question-block";
import { parseMarkdownToBlocks } from "./parser";

const Q = (prompt: string, extra = "- [ ] A\n- [ ] B") => `:::question\n${prompt}\n\n${extra}\n:::`;

const FIXTURES: Record<string, string> = {
  plain: `# Plan\n\n${Q("Which store?")}\n\nProse.\n\n${Q("Which cache?")}\n`,
  repeated: `${Q("Same?")}\n\n${Q("Same?")}\n\n:::question-text\nSame?\n:::\n\n${Q("Same?")}`,
  "backtick fence": `Intro\n\n\`\`\`markdown\n${Q("Inside a fence?")}\n\`\`\`\n\n${Q("Outside?")}`,
  "longer fence wrapping a short one": `\`\`\`\`md\n\`\`\`\n${Q("Hidden?")}\n\`\`\`\n\`\`\`\`\n\n${Q("Shown?")}`,
  "indented fence": `- item\n\n    \`\`\`\n${Q("Indented fence?")}\n    \`\`\`\n\n${Q("After?")}`,
  "unclosed fence": `${Q("Before?")}\n\n\`\`\`\n${Q("Swallowed?")}\n`,
  "nested in another directive": `:::note\nA note\n${Q("Nested?")}\n:::\n\n${Q("Top level?")}`,
  "blockquote marker": `> :::question\n> Quoted?\n> :::\n\n${Q("Real?")}`,
  "html block spanning blank lines": `<details>\n<summary>More</summary>\n\n${Q("In details?")}\n\n</details>\n\n${Q("After details?")}`,
  "display math": `$$\na = b\n:::question\nInside math?\n$$\n\n${Q("After math?")}`,
  "unclosed math does not swallow": `$$100k for infra\n\n${Q("Budget?")}`,
  frontmatter: `---\ntitle: Plan\ntags: [a, b]\n---\n\n${Q("After frontmatter?")}`,
  "reference link in the prompt": `${Q("Use [the store][s]?")}\n\n[s]: https://example.com/store\n`,
  "unclosed question at the end": `Intro\n\n:::question\nNever closed?\n\n- [ ] A\n`,
  crlf: `${Q("Windows?")}\r\n\r\n${Q("Again?")}`.replace(/\n/g, "\r\n"),
  "indented opener": `   :::question\nIndented opener?\n:::\n`,
  "no prompt is not a question": `:::question\n- [ ] Only a choice\n:::\n\n${Q("Counted?")}\n\n${Q("Counted?")}`,
  "decision lines": `${Q("Flagged?", "Decision: when answered\n\n- [ ] A")}\n\n${Q("Linked?", "- [ ] A\n\nDecision: [Do A](https://x.test/d/1)")}`,
};

const uiView = (markdown: string, frontmatter?: boolean) => {
  const blocks = parseMarkdownToBlocks(markdown, frontmatter === false ? { frontmatter: false } : undefined);
  const total = markdown.split("\n").length;
  const byId = new Map(blocks.map((b) => [b.id, b]));
  return indexQuestionBlocks(blocks).map(({ blockId, question }) => {
    const block = byId.get(blockId)!;
    const bodyLines = block.content.split("\n").length;
    return {
      key: question.key,
      directiveKind: question.directiveKind,
      startLine: block.startLine,
      // A closed block ends on the `:::` after its body; an unclosed one ran to
      // the last line.
      endLine: Math.min(block.startLine + bodyLines + 1, total),
    };
  });
};

const coreView = (markdown: string, frontmatter?: boolean) =>
  findQuestionBlocks(markdown, frontmatter === false ? { frontmatter: false } : {}).map(
    ({ key, directiveKind, startLine, endLine }) => ({ key, directiveKind, startLine, endLine }),
  );

describe("findQuestionBlocks agrees with the rendered question index", () => {
  for (const [name, markdown] of Object.entries(FIXTURES)) {
    test(name, () => {
      const ui = uiView(markdown);
      expect(coreView(markdown)).toEqual(ui);
      expect(ui.length).toBeGreaterThan(0);
    });
  }

  test("with frontmatter stripping off", () => {
    const markdown = FIXTURES.frontmatter;
    expect(coreView(markdown, false)).toEqual(uiView(markdown, false));
  });

  test("the cases above exercise exclusion, not just inclusion", () => {
    // Pins that the fixtures still contain blocks the scan must SKIP, so a
    // scanner that found every `:::question` line could not pass by accident.
    const allOpeners = (md: string) => md.split("\n").filter((l) => /^\s*(?:>\s*)?:::question/.test(l)).length;
    for (const name of ["backtick fence", "nested in another directive", "blockquote marker", "html block spanning blank lines", "display math", "unclosed fence"]) {
      const md = FIXTURES[name];
      expect(coreView(md).length).toBeLessThan(allOpeners(md));
    }
  });
});
