/**
 * The file browser says when the server left files out (DOM_TESTS=1).
 *
 * Guards: an answer with `truncated: true` used to be read by nobody, so the
 * files past PLANNOTATOR_FILE_BROWSER_MAX_FILES vanished from the tree with no
 * hint. The hook must carry `truncated` / `fileLimit` from the answer, and the
 * tree must end with one quiet line naming the cap and the knob; an answer
 * that is not truncated (or a host backend that never sends the field) shows
 * nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { FileBrowser } from "./FileBrowser";
import { resetFileTreeBackend, setFileTreeBackend, useFileBrowser } from "../../hooks/useFileBrowser";

const hasDom = typeof document !== "undefined";
const DIR = "/work/folder";
const NOTE = "[data-file-limit-note]";
let root: Root | null = null;
let host: HTMLElement | null = null;

function useBackend(body: Record<string, unknown>): void {
  setFileTreeBackend({
    loadTree: async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
    loadVaultTree: async () => new Response(JSON.stringify({ tree: [] })),
    watchTrees: () => undefined,
  });
}

const Harness: React.FC = () => {
  const browser = useFileBrowser();
  React.useEffect(() => {
    browser.fetchAll([DIR]);
    // fetchAll is stable; run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <FileBrowser
      dirs={browser.dirs}
      expandedFolders={browser.expandedFolders}
      onToggleFolder={browser.toggleFolder}
      collapsedDirs={browser.collapsedDirs}
      onToggleCollapse={browser.toggleCollapse}
      onSelectFile={() => {}}
      activeFile={null}
      onFetchAll={() => {}}
    />
  );
};

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Harness />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const TREE = [
  { name: "README.md", path: "README.md", type: "file" },
  { name: "docs", path: "docs", type: "folder", children: [{ name: "plan.md", path: "docs/plan.md", type: "file" }] },
];

describe.skipIf(!hasDom)("FileBrowser: files past the cap", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    resetFileTreeBackend();
  });

  test("a truncated answer ends the tree with one line naming the cap and the knob", async () => {
    useBackend({ tree: TREE, truncated: true, fileLimit: 5000 });
    await mount();
    expect(host?.textContent).toContain("README");
    const notes = host?.querySelectorAll(NOTE) ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain("5,000");
    expect(notes[0].textContent).toContain("PLANNOTATOR_FILE_BROWSER_MAX_FILES");
  });

  test("no line when the answer is complete, or carries no truncated field", async () => {
    useBackend({ tree: TREE, truncated: false, fileLimit: 5000 });
    await mount();
    expect(host?.textContent).toContain("README");
    expect(host?.querySelector(NOTE)).toBeNull();
    act(() => root?.unmount());
    host?.remove();

    useBackend({ tree: TREE });
    await mount();
    expect(host?.querySelector(NOTE)).toBeNull();
  });
});
