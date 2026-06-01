import { describe, test, expect } from "bun:test";
import { parseAnnotateArgs } from "./annotate-args";

describe("parseAnnotateArgs", () => {
  test("path only", () => {
    expect(parseAnnotateArgs("spec.md")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: false,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("path with --gate at end", () => {
    expect(parseAnnotateArgs("spec.md --gate")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("--gate before path", () => {
    expect(parseAnnotateArgs("--gate spec.md")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("path with both flags", () => {
    expect(parseAnnotateArgs("spec.md --gate --json")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: true,
      hook: false,
      renderHtml: false,
    });
  });

  test("flags only, no path", () => {
    expect(parseAnnotateArgs("--gate --json")).toEqual({
      filePath: "",
      rawFilePath: "",
      gate: true,
      json: true,
      hook: false,
      renderHtml: false,
    });
  });

  test("path with spaces rejoins with single space", () => {
    expect(parseAnnotateArgs("my file.md --gate")).toEqual({
      filePath: "my file.md",
      rawFilePath: "my file.md",
      gate: true,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  // `@` is the reference-mode marker (Claude Code / OpenCode / Pi convention),
  // not part of the filename. The parser strips it on `filePath` as the primary
  // behavior — that's the common case. `rawFilePath` preserves the original
  // for callers that want to try the literal form as a fallback (scoped-package-
  // style names). See at-reference.ts for the combined helper.

  test("leading @ is stripped (reference-mode primary) and rawFilePath preserves it", () => {
    expect(parseAnnotateArgs("@spec.md --gate")).toEqual({
      filePath: "spec.md",
      rawFilePath: "@spec.md",
      gate: true,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("scoped-package-style path: filePath stripped, rawFilePath literal", () => {
    expect(parseAnnotateArgs("@plannotator/ui/README.md")).toEqual({
      filePath: "plannotator/ui/README.md",
      rawFilePath: "@plannotator/ui/README.md",
      gate: false,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("@ stripped on filePath when combined with --gate --json, raw preserved", () => {
    expect(parseAnnotateArgs("@docs/spec.md --gate --json")).toEqual({
      filePath: "docs/spec.md",
      rawFilePath: "@docs/spec.md",
      gate: true,
      json: true,
      hook: false,
      renderHtml: false,
    });
  });

  test("URL passes through", () => {
    expect(parseAnnotateArgs("https://example.com/docs --gate")).toEqual({
      filePath: "https://example.com/docs",
      rawFilePath: "https://example.com/docs",
      gate: true,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("extra whitespace is collapsed", () => {
    expect(parseAnnotateArgs("  spec.md   --gate  ")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("empty string produces empty result", () => {
    expect(parseAnnotateArgs("")).toEqual({
      filePath: "",
      rawFilePath: "",
      gate: false,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("nullish input is tolerated", () => {
    expect(parseAnnotateArgs(undefined as unknown as string)).toEqual({
      filePath: "",
      rawFilePath: "",
      gate: false,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("folder path with trailing slash", () => {
    expect(parseAnnotateArgs("./specs/ --gate --json")).toEqual({
      filePath: "./specs/",
      rawFilePath: "./specs/",
      gate: true,
      json: true,
      hook: false,
      renderHtml: false,
    });
  });

  // Regressions from the initial parser: the tokenize-and-rejoin approach
  // collapsed consecutive whitespace in file paths. Before this branch,
  // OpenCode and Pi passed the raw args string straight through, so files
  // with double-spaces or tabs in their names worked fine. These tests pin
  // that behavior so we don't regress it again.

  test("double-space inside a file path is preserved (flag at end)", () => {
    expect(parseAnnotateArgs("My  Notes.md --gate")).toEqual({
      filePath: "My  Notes.md",
      rawFilePath: "My  Notes.md",
      gate: true,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("double-space inside a file path is preserved (flag at start)", () => {
    expect(parseAnnotateArgs("--gate My  Notes.md")).toEqual({
      filePath: "My  Notes.md",
      rawFilePath: "My  Notes.md",
      gate: true,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("tab inside a file path is preserved", () => {
    expect(parseAnnotateArgs("My\tNotes.md --gate")).toEqual({
      filePath: "My\tNotes.md",
      rawFilePath: "My\tNotes.md",
      gate: true,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("multi-whitespace path with no flags passes through untouched", () => {
    expect(parseAnnotateArgs("/tmp/My  Notes.md")).toEqual({
      filePath: "/tmp/My  Notes.md",
      rawFilePath: "/tmp/My  Notes.md",
      gate: false,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  // OpenCode and Pi don't go through a shell, so users who quote paths
  // (shell muscle memory, copy-paste from docs) have literal quote
  // characters reach the parser. Strip them at the tokenization layer
  // so downstream callers don't have to reason about quoting.

  test("wrapping double quotes are stripped from both filePath and rawFilePath", () => {
    expect(parseAnnotateArgs(`"@foo.md" --gate`)).toEqual({
      filePath: "foo.md",
      rawFilePath: "@foo.md",
      gate: true,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("wrapping single quotes are stripped", () => {
    expect(parseAnnotateArgs(`'@foo.md' --gate`)).toEqual({
      filePath: "foo.md",
      rawFilePath: "@foo.md",
      gate: true,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("wrapping quotes around a path with spaces", () => {
    expect(parseAnnotateArgs(`"@My Notes.md" --gate`)).toEqual({
      filePath: "My Notes.md",
      rawFilePath: "@My Notes.md",
      gate: true,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  test("wrapping quotes without @ still get stripped", () => {
    expect(parseAnnotateArgs(`"My Notes.md"`)).toEqual({
      filePath: "My Notes.md",
      rawFilePath: "My Notes.md",
      gate: false,
      json: false,
      hook: false,
      renderHtml: false,
    });
  });

  // --hook emits hook-native JSON ({"decision":"block","reason":"..."}) for
  // annotations and empty stdout for approve/close. It implies --gate in the
  // binary, but the parser is a pure tokenizer — it reports which flags were
  // present without applying implication logic.

  test("--hook alongside --gate", () => {
    expect(parseAnnotateArgs("spec.md --gate --hook")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: false,
      hook: true,
      renderHtml: false,
    });
  });

  test("--hook with all three flags", () => {
    expect(parseAnnotateArgs("spec.md --gate --json --hook")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: true,
      hook: true,
      renderHtml: false,
    });
  });

  test("--hook alone implies gate", () => {
    expect(parseAnnotateArgs("spec.md --hook")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: false,
      hook: true,
      renderHtml: false,
    });
  });

  test("--hook before path", () => {
    expect(parseAnnotateArgs("--hook --gate spec.md")).toEqual({
      filePath: "spec.md",
      rawFilePath: "spec.md",
      gate: true,
      json: false,
      hook: true,
      renderHtml: false,
    });
  });

  test("--render-html with HTML file and --gate", () => {
    expect(parseAnnotateArgs("plan.html --render-html --gate")).toEqual({
      filePath: "plan.html",
      rawFilePath: "plan.html",
      gate: true,
      json: false,
      hook: false,
      renderHtml: true,
    });
  });

  test("--render-html alone", () => {
    expect(parseAnnotateArgs("plan.html --render-html")).toEqual({
      filePath: "plan.html",
      rawFilePath: "plan.html",
      gate: false,
      json: false,
      hook: false,
      renderHtml: true,
    });
  });
});
