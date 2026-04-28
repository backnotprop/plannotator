import { describe, test, expect } from "bun:test";
import { stripAtPrefix, resolveAtReference } from "./at-reference";

// The `@foo.md` convention — popularised by Claude Code but supported by
// several harnesses — treats `@` as a reference marker, not part of the
// filename. These helpers exist so every harness strips the same way and
// optionally falls back to the literal path for scoped-package-style names.

describe("stripAtPrefix", () => {
  test("removes a single leading @", () => {
    expect(stripAtPrefix("@foo.md")).toBe("foo.md");
  });

  test("removes only one @ (does not recurse)", () => {
    expect(stripAtPrefix("@@foo.md")).toBe("@foo.md");
  });

  test("leaves paths without @ unchanged", () => {
    expect(stripAtPrefix("foo.md")).toBe("foo.md");
  });

  test("leaves @ that is not at the start unchanged", () => {
    expect(stripAtPrefix("dir/@foo.md")).toBe("dir/@foo.md");
  });

  test("strips @ from scoped-package-style paths", () => {
    expect(stripAtPrefix("@scope/pkg/README.md")).toBe("scope/pkg/README.md");
  });

  test("handles empty string", () => {
    expect(stripAtPrefix("")).toBe("");
  });

  // Wrapping quotes come from harnesses that tokenize on whitespace (OpenCode,
  // Pi). Users have to quote paths with spaces: `"@My Notes.md"`. Without
  // unwrapping the quotes first, stripAtPrefix would never see the `@`.
  test("strips wrapping double quotes before stripping @", () => {
    expect(stripAtPrefix(`"@foo.md"`)).toBe("foo.md");
  });

  test("strips wrapping single quotes before stripping @", () => {
    expect(stripAtPrefix(`'@foo.md'`)).toBe("foo.md");
  });

  test("strips wrapping quotes around a path with spaces", () => {
    expect(stripAtPrefix(`"@My Notes.md"`)).toBe("My Notes.md");
  });

  test("strips wrapping quotes when no @ present", () => {
    expect(stripAtPrefix(`"foo.md"`)).toBe("foo.md");
  });

  test("leaves mismatched quotes alone (not wrapping)", () => {
    expect(stripAtPrefix(`"@foo.md`)).toBe(`"@foo.md`);
    expect(stripAtPrefix(`@foo.md"`)).toBe(`foo.md"`);
  });
});

describe("resolveAtReference", () => {
  // Primary behavior: stripped form wins if it resolves.
  test("returns the stripped path when it resolves", () => {
    const exists = (p: string) => p === "foo.md";
    expect(resolveAtReference("@foo.md", exists)).toBe("foo.md");
  });

  // Fallback: literal path used only when stripped form doesn't resolve.
  test("falls back to the literal path when only that resolves", () => {
    const exists = (p: string) => p === "@scope/pkg/README.md";
    expect(resolveAtReference("@scope/pkg/README.md", exists)).toBe("@scope/pkg/README.md");
  });

  // When BOTH resolve, stripped form wins (reference-mode primacy).
  test("prefers the stripped path when both resolve (reference wins)", () => {
    const exists = (_p: string) => true;
    expect(resolveAtReference("@foo.md", exists)).toBe("foo.md");
  });

  // Returns null when neither candidate resolves — caller handles the error.
  test("returns null when neither candidate resolves", () => {
    const exists = (_p: string) => false;
    expect(resolveAtReference("@nope.md", exists)).toBeNull();
  });

  // Inputs without @ have no fallback, just a single existence check.
  test("handles non-@ inputs with a single check", () => {
    let calls = 0;
    const exists = (p: string) => { calls++; return p === "plain.md"; };
    expect(resolveAtReference("plain.md", exists)).toBe("plain.md");
    expect(calls).toBe(1);
  });

  // Non-@ input that doesn't resolve returns null without a retry.
  test("returns null for non-@ input that doesn't resolve", () => {
    let calls = 0;
    const exists = (_p: string) => { calls++; return false; };
    expect(resolveAtReference("missing.md", exists)).toBeNull();
    expect(calls).toBe(1);
  });
});
