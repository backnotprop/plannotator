/** DOM-gated coverage for the file-tree search field's local placement. */
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileTree } from "./FileTree";
import type { DiffFile } from "../types";

const hasDom = typeof document !== "undefined";
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const files: DiffFile[] = [
  {
    path: "src/example.ts",
    patch: "@@ -1 +1 @@\n-old\n+new",
    additions: 1,
    deletions: 1,
    status: "modified",
  },
];

function Tree({ query }: { query: string }) {
  return (
    <FileTree
      files={files}
      activeFileIndex={0}
      onSelectFile={() => {}}
      annotations={[]}
      viewedFiles={new Set()}
      stagedFiles={new Set()}
      searchQuery={query}
      isSearchOpen
      isSearchPending={false}
      onOpenSearch={() => {}}
      onSearchChange={() => {}}
      onSearchClear={() => {}}
      onSearchClose={() => {}}
      searchGroups={[]}
      searchMatches={[]}
    />
  );
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("FileTree search placement", () => {
  test.skipIf(!hasDom)(
    "keeps the search field directly below its utility row",
    async () => {
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);

      await act(async () => root?.render(<Tree query="" />));
      let controls = host.querySelector("[data-panel-controls-row]");
      let search = host.querySelector("[data-panel-search-field]");
      expect(controls).not.toBeNull();
      expect(controls?.nextElementSibling).toBe(search);

      await act(async () => root?.render(<Tree query="needle" />));
      controls = host.querySelector("[data-panel-controls-row]");
      search = host.querySelector("[data-panel-search-field]");
      expect(controls?.nextElementSibling).toBe(search);
      expect(host.textContent).toContain("No matches found");
    },
  );
});
