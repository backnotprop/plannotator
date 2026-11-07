/**
 * DOM-gated coverage for the left panel's sticky tools block (approved design
 * record "review-sidebar-aligned").
 *
 * Regressions guarded:
 *  - a setting of the old Tree controls popover (Copy all diffs, Auto-mark
 *    viewed, Group by kind, the Viewed and Git add buttons) no longer reachable
 *    from the "…" menu, or no longer doing what it did;
 *  - Hide viewed and Search in diff losing their one-click toggles or their
 *    pressed state;
 *  - turning the Viewed button off leaving the list silently filtered;
 *  - the progress losing its words ("N of M viewed", "All M viewed", "K staged");
 *  - the hairline under the block showing when nothing is scrolled under it,
 *    or not showing when something is.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PanelControlsRow, type PanelControlsProps } from "./PanelChrome";

const hasDom = typeof document !== "undefined";
let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(element: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = "";
});

/** The row with its state held like the app holds it. */
function Harness({ onCopy, ...rest }: { onCopy?: () => void } & Partial<PanelControlsProps>) {
  const [showViewed, setShowViewed] = useState(true);
  const [showStage, setShowStage] = useState(true);
  const [hideViewed, setHideViewed] = useState(true);
  const [autoViewed, setAutoViewed] = useState(true);
  const [groupByKind, setGroupByKind] = useState(true);
  return (
    <PanelControlsRow
      viewedCount={0}
      totalCount={22}
      stagedCount={2}
      hideViewedFiles={hideViewed}
      onToggleHideViewed={() => setHideViewed((value) => !value)}
      onCopyRawDiff={onCopy}
      canCopyRawDiff
      showViewedControls={showViewed}
      onToggleShowViewedControls={() => setShowViewed((value) => !value)}
      showStageControls={showStage}
      onToggleShowStageControls={() => setShowStage((value) => !value)}
      autoViewed={autoViewed}
      onToggleAutoViewed={() => setAutoViewed((value) => !value)}
      groupByKind={groupByKind}
      onToggleGroupByKind={() => setGroupByKind((value) => !value)}
      {...rest}
    />
  );
}

const menuTrigger = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[aria-label="List options"]');
const menu = () => document.querySelector<HTMLElement>("[data-review-tree-settings]");
const menuItem = (attr: string) => menu()?.querySelector<HTMLElement>(`[${attr}]`) ?? null;
const eye = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[aria-label="Hide viewed files"]');

async function openMenu(el: HTMLElement) {
  await act(async () => {
    menuTrigger(el)?.click();
    await Promise.resolve();
  });
  expect(menu()).not.toBeNull();
}

describe.skipIf(!hasDom)("PanelControlsRow", () => {
  test("the progress in words, and the staged count", async () => {
    const el = await mount(<Harness />);
    expect(el.querySelector("[data-panel-viewed-controls]")?.textContent).toBe("0 of 22 viewed");
    expect(el.querySelector("[data-panel-staged-count]")?.textContent).toBe("2 staged");
    await act(async () => root?.render(<Harness viewedCount={22} />));
    expect(el.querySelector("[data-panel-viewed-controls]")?.textContent).toBe("All 22 viewed");
    await act(async () => root?.render(<Harness stagedCount={0} />));
    expect(el.querySelector("[data-panel-staged-count]")).toBeNull();
  });

  test("Hide viewed is a one-click toggle with its pressed state", async () => {
    const el = await mount(<Harness />);
    expect(eye(el)?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => eye(el)?.click());
    expect(eye(el)?.getAttribute("aria-pressed")).toBe("false");
  });

  test("Search in diff is a real toggle: a second click closes the search", async () => {
    function SearchHarness() {
      const [open, setOpen] = useState(false);
      return <Harness onOpenSearch={() => setOpen(true)} onCloseSearch={() => setOpen(false)} isSearchVisible={open} />;
    }
    const el = await mount(<SearchHarness />);
    const search = () => el.querySelector<HTMLButtonElement>('[aria-label="Search in diff"]')!;
    expect(search().getAttribute("aria-pressed")).toBe("false");
    await act(async () => search().click());
    expect(search().getAttribute("aria-pressed")).toBe("true");
    await act(async () => search().click());
    expect(search().getAttribute("aria-pressed")).toBe("false");
  });

  test("without a way to close, Search in diff claims no pressed state", async () => {
    const el = await mount(<Harness onOpenSearch={() => {}} isSearchVisible />);
    expect(el.querySelector('[aria-label="Search in diff"]')?.hasAttribute("aria-pressed")).toBe(false);
  });

  test("Search in diff and Collapse all are one click", async () => {
    const onOpenSearch = mock(() => {});
    const onToggleAllFolders = mock(() => {});
    const el = await mount(
      <Harness onOpenSearch={onOpenSearch} onToggleAllFolders={onToggleAllFolders} areAllFoldersExpanded />,
    );
    const search = el.querySelector<HTMLButtonElement>('[aria-label="Search in diff"]')!;
    await act(async () => search.click());
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    const collapse = el.querySelector<HTMLButtonElement>('[aria-label="Collapse all folders"]')!;
    await act(async () => collapse.click());
    expect(onToggleAllFolders).toHaveBeenCalledTimes(1);
    await act(async () =>
      root?.render(<Harness onOpenSearch={onOpenSearch} onToggleAllFolders={onToggleAllFolders} areAllFoldersExpanded={false} collapseDisabled />),
    );
    expect(el.querySelector<HTMLButtonElement>('[aria-label="Expand all folders"]')?.disabled).toBe(true);
  });

  test("the scope leads the row; without one the row says Files", async () => {
    const el = await mount(<Harness scope={<button type="button" data-test-scope="">Changes</button>} />);
    const row = el.querySelector("[data-panel-controls-row]")!;
    expect(row.firstElementChild?.hasAttribute("data-test-scope")).toBe(true);
    await act(async () => root?.render(<Harness />));
    expect(row.firstElementChild?.textContent).toBe("Files");
  });

  test("the … menu copies all diffs and stays open to show it", async () => {
    const onCopy = mock(() => {});
    const el = await mount(<Harness onCopy={onCopy} />);
    await openMenu(el);
    await act(async () => menuItem("data-review-copy-all-diffs")?.click());
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(menu()).not.toBeNull();
    await act(async () => root?.render(<Harness onCopy={onCopy} copyRawDiffStatus="success" />));
    expect(menuItem("data-review-copy-all-diffs")?.textContent).toBe("Copied all diffs");
  });

  test("every setting of the old Tree controls is in the … menu and toggles", async () => {
    const el = await mount(<Harness onCopy={() => {}} />);
    await openMenu(el);
    for (const attr of [
      "data-review-auto-viewed-toggle",
      "data-review-group-by-kind-toggle",
      "data-review-viewed-controls-toggle",
      "data-review-stage-controls-toggle",
    ]) {
      const item = menuItem(attr)!;
      expect(item.getAttribute("role")).toBe("menuitemcheckbox");
      expect(item.getAttribute("aria-checked")).toBe("true");
      await act(async () => item.click());
      expect(menuItem(attr)?.getAttribute("aria-checked")).toBe("false");
    }
    // Viewed button off: no progress words, no eye; Git add button off: no staged count.
    expect(el.querySelector("[data-panel-viewed-controls]")).toBeNull();
    expect(eye(el)).toBeNull();
    expect(el.querySelector("[data-panel-staged-count]")).toBeNull();
  });

  test("turning the Viewed button off first shows the hidden viewed files", async () => {
    const onToggleHideViewed = mock(() => {});
    const el = await mount(<Harness onToggleHideViewed={onToggleHideViewed} hideViewedFiles />);
    await openMenu(el);
    await act(async () => menuItem("data-review-viewed-controls-toggle")?.click());
    expect(onToggleHideViewed).toHaveBeenCalledTimes(1);
  });

  test("a host without the optional settings keeps them out of the menu", async () => {
    const el = await mount(
      <PanelControlsRow
        viewedCount={3}
        totalCount={9}
        showViewedControls
        onToggleShowViewedControls={() => {}}
        showStageControls
        onToggleShowStageControls={() => {}}
      />,
    );
    await openMenu(el);
    expect(menuItem("data-review-auto-viewed-toggle")).toBeNull();
    expect(menuItem("data-review-group-by-kind-toggle")).toBeNull();
    expect(menuItem("data-review-copy-all-diffs")).toBeNull();
    expect(menuItem("data-review-viewed-controls-toggle")).not.toBeNull();
  });

  test("the hairline shows only while files are scrolled under the block", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    host.appendChild(scroller);
    root = createRoot(scroller);
    await act(async () => root?.render(<Harness />));
    const sentinel = scroller.querySelector<HTMLElement>("[data-review-sticky-sentinel]")!;
    const block = scroller.querySelector<HTMLElement>("[data-review-sticky-tools]")!;
    const at = (top: number) => () => ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
    scroller.getBoundingClientRect = at(100);
    expect(block.hasAttribute("data-stuck")).toBe(false);
    sentinel.getBoundingClientRect = at(40);
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(block.hasAttribute("data-stuck")).toBe(true);
    sentinel.getBoundingClientRect = at(100);
    await act(async () => scroller.dispatchEvent(new Event("scroll")));
    expect(block.hasAttribute("data-stuck")).toBe(false);
  });
});
