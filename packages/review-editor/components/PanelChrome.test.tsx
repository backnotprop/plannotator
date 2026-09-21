/** DOM-gated coverage for the file-panel utility row and compact controls. */
import { afterEach, describe, expect, test } from "bun:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PanelControlsRow } from "./PanelChrome";

const hasDom = typeof document !== "undefined";
let host: HTMLDivElement | null = null;
let root: Root | null = null;

function Harness({ onCopy }: { onCopy: () => void }) {
  const [showViewed, setShowViewed] = useState(true);
  const [showStage, setShowStage] = useState(true);
  const [hideViewed, setHideViewed] = useState(true);

  return (
    <PanelControlsRow
      viewedCount={0}
      totalCount={22}
      hideViewedFiles={hideViewed}
      onToggleHideViewed={() => setHideViewed((value) => !value)}
      onCopyRawDiff={onCopy}
      canCopyRawDiff
      showViewedControls={showViewed}
      onToggleShowViewedControls={() => setShowViewed((value) => !value)}
      showStageControls={showStage}
      onToggleShowStageControls={() => setShowStage((value) => !value)}
    />
  );
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("PanelControlsRow", () => {
  test.skipIf(!hasDom)(
    "copies from the utility row and toggles both per-file control columns",
    async () => {
      let copyCount = 0;
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root?.render(
          <Harness
            onCopy={() => {
              copyCount += 1;
            }}
          />,
        );
      });

      const viewedControls = host.querySelector("[data-panel-viewed-controls]");
      expect(viewedControls).not.toBeNull();
      expect(viewedControls?.textContent).toContain("0/22");
      expect(host.firstElementChild?.firstElementChild).toBe(viewedControls);
      expect(
        host.querySelector('[aria-label="Show viewed files"]'),
      ).not.toBeNull();
      const copy = host.querySelector<HTMLButtonElement>(
        '[aria-label="Copy all diffs"]',
      );
      expect(copy).not.toBeNull();
      await act(async () => copy?.click());
      expect(copyCount).toBe(1);

      const settings = host.querySelector<HTMLButtonElement>(
        '[aria-label="Tree controls"]',
      );
      expect(settings).not.toBeNull();
      await act(async () => {
        settings?.click();
        await Promise.resolve();
      });

      const popup = document.querySelector<HTMLElement>(
        "[data-review-tree-settings]",
      );
      expect(popup).not.toBeNull();
      const switches =
        popup?.querySelectorAll<HTMLButtonElement>('[role="switch"]');
      expect(switches).toHaveLength(2);
      expect(switches?.[0]?.getAttribute("aria-checked")).toBe("true");
      expect(switches?.[1]?.getAttribute("aria-checked")).toBe("true");

      await act(async () => switches?.[0]?.click());
      expect(host.querySelector("[data-panel-viewed-controls]")).toBeNull();
      expect(host.querySelector('[aria-label="Hide viewed files"]')).toBeNull();
      expect(host.textContent).not.toContain("0/22");
      await act(async () => switches?.[0]?.click());
      expect(host.querySelector('[aria-label="Hide viewed files"]')).not.toBeNull();
      await act(async () => switches?.[1]?.click());
      expect(switches?.[0]?.getAttribute("aria-checked")).toBe("true");
      expect(switches?.[1]?.getAttribute("aria-checked")).toBe("false");
    },
  );

  test.skipIf(!hasDom)(
    "the auto-mark-viewed switch appears only when a handler is supplied, and toggles",
    async () => {
      // The gear popover is the easily-reachable off switch for auto-mark-
      // viewed, two clicks from where the behavior manifests. Guards both
      // halves: hosts that do not wire it keep exactly two rows (the prop is
      // optional), and wiring it produces a working third.
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      let autoViewed = true;
      const render = async () => {
        await act(async () => {
          root?.render(
            <PanelControlsRow
              viewedCount={3}
              totalCount={9}
              showViewedControls
              onToggleShowViewedControls={() => {}}
              showStageControls
              onToggleShowStageControls={() => {}}
              autoViewed={autoViewed}
              onToggleAutoViewed={() => { autoViewed = !autoViewed; void render(); }}
            />,
          );
        });
      };
      await render();

      await act(async () => {
        host?.querySelector<HTMLButtonElement>('[aria-label="Tree controls"]')?.click();
        await Promise.resolve();
      });
      const popup = document.querySelector<HTMLElement>("[data-review-tree-settings]");
      const toggle = popup?.querySelector<HTMLButtonElement>(
        "[data-review-auto-viewed-toggle]",
      );
      expect(toggle).not.toBeNull();
      expect(toggle?.getAttribute("aria-checked")).toBe("true");
      await act(async () => toggle?.click());
      expect(autoViewed).toBe(false);
      expect(
        document
          .querySelector<HTMLElement>("[data-review-tree-settings]")
          ?.querySelector("[data-review-auto-viewed-toggle]")
          ?.getAttribute("aria-checked"),
      ).toBe("false");
    },
  );
});
