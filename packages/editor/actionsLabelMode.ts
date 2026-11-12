import type { ActionsLabelMode } from "@plannotator/ui/types";

export function actionsLabelModeForWidth(width: number): ActionsLabelMode {
  return width >= 800 ? "full" : width >= 680 ? "short" : "icon";
}

export function observeActionsLabelMode(
  element: HTMLElement,
  onModeChange: (mode: ActionsLabelMode) => void,
): () => void {
  const update = (entries?: readonly ResizeObserverEntry[]) => {
    const entry = entries?.find((candidate) => candidate.target === element);
    const borderBoxSize = entry?.borderBoxSize;
    const measuredBorderBox = Array.isArray(borderBoxSize)
      ? borderBoxSize[0]
      : borderBoxSize;
    const width = measuredBorderBox?.inlineSize ?? element.getBoundingClientRect().width;
    onModeChange(actionsLabelModeForWidth(width));
  };

  update();
  const observer = new ResizeObserver((entries) => update(entries));
  observer.observe(element, { box: "border-box" });
  return () => observer.disconnect();
}
