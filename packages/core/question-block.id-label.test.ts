/**
 * An asker's own label before a question's prompt (`id: sd-approach`), as
 * agents write it (a session whose history was compacted guessed the block's
 * shape and put one first; the person then saw "id: sd-approach" as the
 * question). The parser drops it and reads the next line as the prompt.
 *
 * What regresses if this fails: the person's card shows the label as the
 * question again; or a real question that starts with a word and a colon
 * ("Deploy: should we…?") loses its first line; or the label changes the
 * question's key, so answers, `Replaces:` and supersedes stop matching.
 */
import { expect, test } from "bun:test";
import { findQuestionBlocks, parseQuestionBlock } from "./question-block";

const CHOICES = ["", "- [ ] Rewrite", "- [ ] Patch", "", "Recommended: Patch"];
const parse = (kind: string, ...lines: string[]) => parseQuestionBlock(kind, lines.join("\n"))!;

test("an id or key label before the question is dropped: the next line is the question, with the same key", () => {
  const plain = parse("question", "Which approach do we take?", ...CHOICES);
  for (const label of ["id: sd-approach", "key: approach-1", "question_id: q7", "decision-key:db", "  id: #42"]) {
    for (const lead of [[], [""]]) {
      const parsed = parse("question", ...lead, label, "Which approach do we take?", ...CHOICES);
      expect(parsed.prompt).toBe("Which approach do we take?");
      expect(parsed.key).toBe(plain.key);
      expect(parsed.context).not.toContain(label.trim());
      expect(parsed.choices.map((c) => c.label)).toEqual(["Rewrite", "Patch"]);
      expect(parsed.recommendation).toBe("Patch");
    }
  }
  // Free text and pick several too.
  expect(parse("question-text", "id: copy", "What should the empty state say?").prompt).toBe("What should the empty state say?");
  expect(parse("question-multi", "id: platforms", "Which platforms?", "- [ ] Mac", "- [ ] Linux").prompt).toBe("Which platforms?");
});

test("a real question is never dropped: words after the colon, a capital, a question mark, another name, or a link", () => {
  for (const first of ["Deploy: x?", "Deploy: should we wait for the fix?", "ID: sd-approach", "id: what?", "id: two words", "note: sd-approach", "https://example.com/pr/42"]) {
    expect(parse("question", first, ...CHOICES).prompt).toBe(first);
  }
  // After the question, an id line is context the person reads, as before.
  const later = parse("question", "Which approach do we take?", "id: sd-approach", ...CHOICES);
  expect(later.prompt).toBe("Which approach do we take?");
  expect(later.context).toContain("id: sd-approach");
});

test("located in a document, the block keeps the key its plain question has, so answers and supersedes match", () => {
  const doc = (first: string[]) => ["Intro.", "", ":::question", ...first, "Which approach do we take?", ...CHOICES, ":::", ""].join("\n");
  expect(findQuestionBlocks(doc(["id: sd-approach"]), { frontmatter: false }).map((b) => b.key)).toEqual(
    findQuestionBlocks(doc([]), { frontmatter: false }).map((b) => b.key),
  );
});
