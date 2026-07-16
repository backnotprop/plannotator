import { describe, expect, test } from "bun:test";
import { hasUnsavedCommentContent } from "./commentContent";
import type { ImageAttachment } from "../types";

const image: ImageAttachment = {
  path: "/tmp/mock.png",
  name: "mock",
};

describe("hasUnsavedCommentContent", () => {
  test("returns false for empty text and no images", () => {
    expect(hasUnsavedCommentContent("")).toBe(false);
  });

  test("returns false for whitespace-only text and no images", () => {
    expect(hasUnsavedCommentContent(" \n\t ")).toBe(false);
  });

  test("returns true for non-whitespace text", () => {
    expect(hasUnsavedCommentContent("note")).toBe(true);
  });

  test("returns true for images without text", () => {
    expect(hasUnsavedCommentContent("", [image])).toBe(true);
  });
});
