/**
 * The combined thread's one quiet line about what a Combine left where it was (approval "inbox-combine-across-computers";
 * `inboxCombineLeftLine`). What regresses: a line per thread or per file (a list where the owner asked for one line),
 * threads of one computer named under two, a long list of names where a few and a count would do, a line with nothing in it.
 */
import { expect, test } from "bun:test";
import { inboxCombineLeftLine } from "./inbox-types";

test("one line: the threads still open by computer, then the files not copied, each part at most three names and a count", () => {
  const line = inboxCombineLeftLine({
    open: [
      { machine: "Mini", subject: "Refund for Ada Novak" },
      { machine: "Studio", subject: "Export for Bob Tully" },
      { machine: "Mini", subject: "Invoice for Charlie Dunn" },
    ],
    files: ["a.png", "b.png", "c.png", "d.png", "e.png"],
  });
  expect(line.split("\n")).toHaveLength(1);
  expect(line.split(" · ")).toEqual(["Still open on Mini: Refund for Ada Novak, Invoice for Charlie Dunn", "Still open on Studio: Export for Bob Tully", "Not copied: a.png, b.png, c.png and 2 more"]);
  expect(inboxCombineLeftLine({ files: ["plan.pdf"] })).toBe("Not copied: plan.pdf");
  expect(inboxCombineLeftLine({})).toBe("");
});
