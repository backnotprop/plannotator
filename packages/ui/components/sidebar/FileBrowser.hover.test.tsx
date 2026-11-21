/**
 * File tree names show the whole name on hover (DOM_TESTS=1).
 *
 * Guards #2195: a name cut by the sidebar's narrow column had no way to read
 * the rest. Both tree names are wrapped in HostTitle with `cut`, so plan
 * review and annotate keep a native title, and a host drawing component
 * tooltips opens one only while the name is cut.
 *
 * happy-dom has no layout, so the tooltip test gives the name spans the
 * widths a cut (or fitting) name would have.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { FileBrowser } from "./FileBrowser";
import { resetComponentTooltips, setComponentTooltips } from "../HostTitle";
import type { DirState } from "../../hooks/useFileBrowser";
import type { VaultNode } from "../../types";

const hasDom = typeof document !== "undefined";
const LONG_FILE = "conversion-rate-planner-with-a-very-long-name.md";
const LONG_FILE_DISPLAY = "conversion-rate-planner-with-a-very-long-name";
const SHORT_FILE = "notes.md";
const LONG_FOLDER = "a-folder-name-far-too-long-for-the-sidebar";

const TREE: VaultNode[] = [
  { name: LONG_FOLDER, path: LONG_FOLDER, type: "folder", children: [] },
  { name: LONG_FILE, path: LONG_FILE, type: "file" },
  { name: SHORT_FILE, path: SHORT_FILE, type: "file" },
];

const DIRS: DirState[] = [
  {
    path: "/work",
    name: "work",
    tree: TREE,
    isLoading: false,
    error: null,
  },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  resetComponentTooltips();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  for (const node of document.body.querySelectorAll("[data-pn-tooltip]")) node.remove();
});

function mount(): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <FileBrowser
        dirs={DIRS}
        expandedFolders={new Set()}
        onToggleFolder={() => {}}
        collapsedDirs={new Set()}
        onToggleCollapse={() => {}}
        onSelectFile={() => {}}
        activeFile={null}
        onFetchAll={() => {}}
      />,
    );
  });
  return host;
}

/** The truncated name span inside the row whose text contains `text`. */
function nameSpan(el: HTMLElement, text: string): HTMLElement {
  for (const row of el.querySelectorAll<HTMLElement>(".file-tree-item, .file-tree-folder")) {
    if (!row.textContent?.includes(text)) continue;
    const span = [...row.querySelectorAll<HTMLElement>(".truncate")].find((node) => node.textContent === text);
    if (span) return span;
  }
  throw new Error(`no tree row named ${text}`);
}

/** happy-dom has no layout: give an element the sizes a cut (or fitting) name would have. */
function sized(node: Element, scroll: number, client: number): void {
  Object.defineProperty(node, "scrollWidth", { configurable: true, get: () => scroll });
  Object.defineProperty(node, "clientWidth", { configurable: true, get: () => client });
}

/** The pointer comes to rest on `target`, the way a mouse does. */
function hover(target: Element): void {
  act(() => {
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      target.dispatchEvent(
        new Ctor(type, {
          bubbles: type !== "pointerenter" && type !== "mouseenter",
          cancelable: true,
          pointerType: "mouse",
          clientX: 10,
          clientY: 10,
        } as PointerEventInit),
      );
    }
  });
}

function unhover(target: Element): void {
  act(() => {
    for (const type of ["pointerout", "pointerleave", "mouseout", "mouseleave"]) {
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      target.dispatchEvent(
        new Ctor(type, {
          bubbles: type !== "pointerleave" && type !== "mouseleave",
          cancelable: true,
          pointerType: "mouse",
          clientX: 400,
          clientY: 400,
        } as PointerEventInit),
      );
    }
  });
}

async function wait(ms = 400): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const tooltip = () => document.querySelector<HTMLElement>("[data-pn-tooltip]");

describe.skipIf(!hasDom)("FileBrowser: names on hover", () => {
  test("plan review and annotate keep a native title with the whole name", () => {
    const el = mount();
    expect(nameSpan(el, LONG_FILE_DISPLAY).getAttribute("title")).toBe(LONG_FILE);
    expect(nameSpan(el, "notes").getAttribute("title")).toBe(SHORT_FILE);
    expect(nameSpan(el, LONG_FOLDER).getAttribute("title")).toBe(LONG_FOLDER);
  });

  test("with component tooltips, a cut name opens the whole name and a fitting one opens nothing", async () => {
    setComponentTooltips(true);
    const el = mount();
    const cut = nameSpan(el, LONG_FILE_DISPLAY);
    const fits = nameSpan(el, "notes");

    sized(fits, 60, 60);
    hover(fits);
    await wait();
    expect(tooltip()).toBeNull();
    unhover(fits);

    sized(cut, 400, 120);
    hover(cut);
    await wait();
    expect(tooltip()?.textContent).toBe(LONG_FILE);
    expect(cut.hasAttribute("title")).toBe(false);
  });
});
