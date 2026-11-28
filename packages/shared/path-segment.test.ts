import { describe, expect, test } from "bun:test";
import { decodePathSegment } from "./path-segment";

describe("decodePathSegment", () => {
  test("decodes a well-formed segment exactly like decodeURIComponent", () => {
    for (const segment of ["job-1", "saved%3A1000-guide", "a%20b", "%E0%A4%A8", "ini_01J"]) {
      expect(decodePathSegment(segment)).toBe(decodeURIComponent(segment));
    }
  });

  test("answers null, never throws, for a malformed escape", () => {
    for (const segment of ["%", "abc%", "%zz", "%E0%A4%A", "%C0"]) {
      expect(() => decodeURIComponent(segment)).toThrow(URIError);
      expect(decodePathSegment(segment)).toBeNull();
    }
  });
});
