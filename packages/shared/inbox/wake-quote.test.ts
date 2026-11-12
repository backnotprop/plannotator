import { expect, test } from "bun:test";
import { inboxWakeQuote } from "./wake-quote";

const question = (prompt: string, position = 1, kind = "single") => ({ kind, prompt, position });
const QUESTION_BLOCK = ":::question\nWhich backoff should the worker use?\n\n- [ ] Linear\n- [ ] Exponential\n:::";

test("about ten words, with an ellipsis only when there were more", () => {
  expect(inboxWakeQuote("one two three four five six seven eight nine ten eleven twelve", [])).toEqual({ quote: "one two three four five six seven eight nine ten…" });
  expect(inboxWakeQuote("one two three", [])).toEqual({ quote: "one two three" });
});

test("plain text: headings, emphasis, links, inline code and quotes lose their marks", () => {
  expect(inboxWakeQuote("## **Done**: see [the PR](https://x/y) and `run.ts`.", [])).toEqual({ quote: "Done: see the PR and run.ts." });
  expect(inboxWakeQuote("> quoted line\n\nnext", [])).toEqual({ quote: "quoted line next" });
  expect(inboxWakeQuote("- first item\n- second item", [])).toEqual({ quote: "first item second item" });
});

test("line breaks fold, so the words read as one line", () => {
  expect(inboxWakeQuote("first line\nsecond line\r\n\r\nthird", [])).toEqual({ quote: "first line second line third" });
});

test("a message that opens with code quotes the code's words, without its fence", () => {
  expect(inboxWakeQuote("```ts\nconst a = 1;\n```", [])).toEqual({ quote: "const a = 1;" });
});

test("prose before a question is the message's opening: it is quoted, not the question", () => {
  expect(inboxWakeQuote(`Here is where it stands.\n\n${QUESTION_BLOCK}`, [question("Which backoff should the worker use?")])).toEqual({ quote: "Here is where it stands." });
});

test("a message opening with a question uses the question's own words, never `:::question`", () => {
  const first = question("Which backoff should the worker use?");
  expect(inboxWakeQuote(`${QUESTION_BLOCK}\n\nMore after.`, [question("Later one?", 2), first])).toEqual({ quote: "Which backoff should the worker use?" });
});

test("a message opening with an action item uses its own words", () => {
  expect(inboxWakeQuote(":::action\nApprove the deploy on Vercel\n:::", [question("Approve the deploy on Vercel", 1, "action")])).toEqual({ quote: "Approve the deploy on Vercel" });
});

test("a message opening with a picture uses the question's own words, else the words after the picture", () => {
  expect(inboxWakeQuote(`![chart](/tmp/a.png)\n\nThe build passes.\n\n${QUESTION_BLOCK}`, [question("Which backoff?")])).toEqual({ quote: "Which backoff?" });
  expect(inboxWakeQuote("![chart](/tmp/a.png)\n\nThe build passes.", [])).toEqual({ quote: "The build passes." });
  expect(inboxWakeQuote('<img src="/tmp/a.png">\n\nThe build passes.', [])).toEqual({ quote: "The build passes." });
});

test("with no words at all, it counts what the message asked", () => {
  expect(inboxWakeQuote(":::question\n![](a.png)\n\n- [ ] A\n- [ ] B\n:::", [question(""), question("", 2), question("![](b.png)", 3)])).toEqual({ questions: 3 });
  expect(inboxWakeQuote("![chart](/tmp/a.png)", [])).toEqual({});
});
