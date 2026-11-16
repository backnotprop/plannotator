import { expect, test } from "bun:test";
import { editorAnnotationLines } from "./editor-annotation-lines";

test("a line selection ending at column zero excludes the next line", () => {
  expect(editorAnnotationLines({ start: { line: 3, character: 0 }, end: { line: 6, character: 0 } }))
    .toEqual({ lineStart: 4, lineEnd: 6 });
});

test("selections with text on the last line include that line", () => {
  expect(editorAnnotationLines({ start: { line: 3, character: 1 }, end: { line: 6, character: 1 } }))
    .toEqual({ lineStart: 4, lineEnd: 7 });
  expect(editorAnnotationLines({ start: { line: 3, character: 1 }, end: { line: 3, character: 2 } }))
    .toEqual({ lineStart: 4, lineEnd: 4 });
});
