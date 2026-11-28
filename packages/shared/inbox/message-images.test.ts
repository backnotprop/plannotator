/**
 * Which pictures a body shows outside code (message-images.ts), as the window draws it. The failure this guards: two
 * stray backticks in different paragraphs read as one code span, so a picture between them is left out of the
 * message's pictures and the window's request for it is refused (403), though the window draws it.
 */
import { expect, test } from "bun:test";
import { blankInlineCode, inboxMessageImageRefs, inboxMessageImageRefsInOrder } from "./message-images";

test("a code span never crosses a blank line: a picture between stray backticks of different paragraphs is shown", () => {
  const body = "Press the ` key.\n\n![shot](shot.png)\n\nThen the ` key again.";
  expect([...inboxMessageImageRefs(body)]).toEqual(["shot.png"]);
  expect(inboxMessageImageRefsInOrder(body)).toEqual(["shot.png"]);
  // A blank line with spaces on it ends a paragraph too.
  expect([...inboxMessageImageRefs("a ` b\n  \t\n![s](s.png) ` c")]).toEqual(["s.png"]);
  // Windows line endings: a blank line is still a blank line.
  expect([...inboxMessageImageRefs("Press the ` key.\r\n\r\n![shot](shot.png)\r\n\r\nThen the ` key again.")]).toEqual(["shot.png"]);
  // Within one paragraph a span still runs over a line break, and a picture inside it is code.
  expect([...inboxMessageImageRefs("Run `a\n![x](x.png)` now.\n\n![y](y.png)")]).toEqual(["y.png"]);
  expect(blankInlineCode("`a`\n\n`b`")).toBe("   \n\n   ");
});
