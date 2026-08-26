import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FileTree } from "./FileTree";
import type { DiffFile } from "../types";

const files: DiffFile[] = [
  {
    path: "src/example.ts",
    patch: "@@ -1 +1 @@\n-old\n+new",
    additions: 1,
    deletions: 1,
    status: "modified",
  },
];

describe("FileTree ESLint navigation", () => {
  test("exposes an ESLint entry when the current review advertises a runnable check", () => {
    const html = renderToStaticMarkup(
      <FileTree
        files={files}
        activeFileIndex={-1}
        onSelectFile={() => {}}
        annotations={[]}
        viewedFiles={new Set()}
        stagedFiles={new Set()}
        onSelectEslintCheck={() => {}}
        isEslintCheckActive={false}
        eslintCheckFileCount={1}
      />,
    );

    expect(html).toContain(">ESLint<");
    expect(html).toContain(">1<");
  });
});
