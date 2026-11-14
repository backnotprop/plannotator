/**
 * An asker's own label before a question's prompt (`id: sd-approach`), as
 * agents write it (a session whose history was compacted guessed the block's
 * shape and put one first; the person then saw "id: sd-approach" as the
 * question). The parser reads the next line as the prompt and shows the
 * label as context, so nothing the agent wrote is hidden.
 *
 * What regresses if this fails: the person's card shows the label as the
 * question again; or the label disappears from the card; or a real question that starts with a word and a colon
 * ("Deploy: should we…?") loses its first line; or the key moves off the one
 * builds before this computed (the label line was the prompt then). The
 * store keeps each question's key from the send and the window computes it
 * again from the body, so a moved key would orphan a stored question's
 * picks, answers and supersedes.
 */
import { expect, test } from "bun:test";
import { findQuestionBlocks, parseQuestionBlock, questionKey } from "./question-block";

const CHOICES = ["", "- [ ] Rewrite", "- [ ] Patch", "", "Recommended: Patch"];
const parse = (kind: string, ...lines: string[]) => parseQuestionBlock(kind, lines.join("\n"))!;

test("an id or key label before the question shows as context: the next line is the question, and the key is the label line's", () => {
  for (const label of ["id: sd-approach", "key: approach-1", "question_id: q7", "decision-key:db", "  id: #42"]) {
    for (const lead of [[], [""]]) {
      const parsed = parse("question", ...lead, label, "Which approach do we take?", ...CHOICES);
      expect(parsed.prompt).toBe("Which approach do we take?");
      // The key builds before this computed, when the label line was the prompt.
      expect(parsed.key).toBe(questionKey("single", label.trim()));
      // The label still shows: first in the context, under the question.
      expect(parsed.context.split("\n")[0].trim()).toBe(label.trim());
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

test("a question stored with a leading id line keeps the key it was stored with, and shows the real question", () => {
  // The key main computed for this block (its prompt was the label line), as a session's later supersedes named it.
  const stored = parse("question", "id: sd-approach", "How should we stop delivering the same event twice?", ...CHOICES);
  expect(stored.key).toBe("q-41d641f8");
  expect(stored.prompt).toBe("How should we stop delivering the same event twice?");
  expect(stored.context).toBe("id: sd-approach");
  const doc = ["Intro.", "", ":::question", "id: sd-approach", "How should we stop delivering the same event twice?", ...CHOICES, ":::", ""].join("\n");
  expect(findQuestionBlocks(doc, { frontmatter: false }).map((b) => b.key)).toEqual(["q-41d641f8"]);
  // A label and nothing else to ask stays the question, as before.
  const bare = parse("question", "id: sd-approach", ...CHOICES);
  expect(bare.prompt).toBe("id: sd-approach");
  expect(bare.key).toBe("q-41d641f8");
  expect(bare.context).toBe("");
});
