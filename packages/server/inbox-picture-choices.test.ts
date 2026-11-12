/**
 * Which questions send_message tells to come back as picture choices
 * (`questionsWithoutPictureChoices`, inbox-picture-choices.ts).
 *
 * What regresses if this fails: the advice fires on a question that needs no
 * pictures in its choices (a merge question under screenshots of the work, a
 * wording question under the screens it is for), which the earlier rule did on
 * 7 of the 9 bodies it fired on in the eval; or it goes quiet on the rundown it
 * exists for (each option's picture above, bare choices below).
 *
 * Pure; no store, no server.
 */
import { expect, test } from "bun:test";
import { questionsWithoutPictureChoices } from "./inbox-picture-choices";
import { HAND, SENT } from "./inbox-picture-choices.fixtures";

const fires = (body: string) => questionsWithoutPictureChoices(body).keys.length > 0;
const ask = (...choices: string[]) => [":::question", "Which one do we build?", "", ...choices, ":::"].join("\n");

test("bodies agents sent: the rundown is named, the questions that need no pictures are not", () => {
  const answers = SENT.map((f) => [f.id, fires(f.body)]);
  expect(answers).toEqual(SENT.map((f) => [f.id, f.fires]));
  // The eval's bodies that needed no pictures in their choices, every one quiet now.
  expect(SENT.filter((f) => /^sent-N/.test(f.id) && fires(f.body))).toEqual([]);
  expect(SENT.filter((f) => /^sent-N/.test(f.id))).toHaveLength(7);
});

test("hand-written edges: numbered rundowns and headings fire; shared words, unrelated numbers, a contact sheet do not", () => {
  expect(HAND.map((f) => [f.id, fires(f.body)])).toEqual(HAND.map((f) => [f.id, f.fires]));
});

test("a choice is shown by its marker, a label word, the file name or a line above the picture", () => {
  // The marker opens the alt text.
  expect(fires(["![A · Grid](a.png)", "![B · List](b.png)", "", ask("- [ ] A", "- [ ] B")].join("\n"))).toBe(true);
  // A label word in the alt text.
  expect(fires(["![Forest theme](x1.png)", "![Sunset theme](x2.png)", "", ask("- [ ] Forest", "- [ ] Sunset")].join("\n"))).toBe(true);
  // The file name: option-a.png, v2.png.
  expect(fires(["![](shots/option-a.png)", "![](shots/option-b.png)", "", ask("- [ ] A · Cards", "- [ ] B · Rows")].join("\n"))).toBe(true);
  expect(fires(["![](v1.png)", "![](v2.png)", "", ask("- [ ] 1. Cards", "- [ ] 2. Rows")].join("\n"))).toBe(true);
  // A heading two lines above the picture, and "Variant 2" in the text near it.
  expect(fires(["### Compact rows", "Dense, one line each.", "![](p.png)", "", "Variant 2, roomier:", "![](q.png)", "", ask("- [ ] 1 · Compact rows", "- [ ] 2 · Roomy")].join("\n"))).toBe(true);
  // An `<img>` tag's alt text.
  expect(fires(['<img src="m.png" alt="Calendar view">', '<img src="t.png" alt="Table view">', "", ask("- [ ] Calendar", "- [ ] Table")].join("\n"))).toBe(true);
});

test("the rule counts each matched picture once, and two choices need two different pictures", () => {
  expect(questionsWithoutPictureChoices(["![Forest](f.png) ![Sunset](s.png) ![Ocean](o.png) ![Logo](logo.png)", "", ask("- [ ] Forest", "- [ ] Sunset", "- [ ] Ocean")].join("\n")).pictures).toBe(3);
  // Both choices name the one picture that says "Forest" and "Sunset": only one can have it.
  expect(fires(["![Forest and Sunset side by side](both.png)", "![The logo](logo.png)", "", ask("- [ ] Forest", "- [ ] Sunset")].join("\n"))).toBe(false);
  // The same picture twice is one picture.
  expect(fires(["![Forest](f.png)", "![Sunset](f.png)", "", ask("- [ ] Forest", "- [ ] Sunset")].join("\n"))).toBe(false);
});

test("a contact sheet of three or more options counts for none, but leaves the single pictures counted", () => {
  const sheet = "![1 · Names, 2 · Faces, 3 · Colors side by side](sheet.png)";
  const choices = ask("- [ ] 1 · Names", "- [ ] 2 · Faces", "- [ ] 3 · Colors");
  expect(fires([sheet, "![Another sheet: Names, Faces, Colors](sheet2.png)", "", choices].join("\n"))).toBe(false);
  expect(fires([sheet, "![1 · Names](1.png)", "![2 · Faces](2.png)", "", choices].join("\n"))).toBe(true);
});

test("pictures in code, in a question, or matching no choice do not count; picture choices and free text are never named", () => {
  const fenced = ["```md", "![Forest](f.png)", "![Sunset](s.png)", "```", "", ask("- [ ] Forest", "- [ ] Sunset")].join("\n");
  expect(fires(fenced)).toBe(false);
  const inOther = [ask("- [ ] Forest — ![Forest](f.png)", "- [ ] Sunset — ![Sunset](s.png)"), "", ":::question-multi", "Which modes?", "", "- [ ] Forest", "- [ ] Sunset", ":::"].join("\n");
  expect(fires(inOther)).toBe(false);
  expect(fires(["![Login screen](l.png)", "![Home screen](h.png)", "", ask("- [ ] Ship it", "- [ ] Wait")].join("\n"))).toBe(false);
  expect(fires(["![Forest](f.png)", "![Sunset](s.png)", "", ":::question-text", "Which one, and why?", ":::"].join("\n"))).toBe(false);
  expect(fires(["![Forest](f.png)", "![Sunset](s.png)", "", ask("- [ ] Forest — ![Forest](f.png)", "- [ ] Sunset")].join("\n"))).toBe(false);
});

test("never throws, whatever the body", () => {
  for (const body of ["", ":::question", ":::question\n- [ ] A\n", "![a](", "![](  )\n:::question\n- [ ] A\n- [ ] B\n:::", "<img alt=x>\n" + ask("- [ ] x", "- [ ] y"), null as unknown as string]) {
    expect(questionsWithoutPictureChoices(body)).toEqual(expect.objectContaining({ keys: expect.any(Array) }));
  }
});
