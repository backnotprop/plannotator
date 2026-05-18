import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

export async function renderBrowser(
  ui: ReactNode,
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  return { container, root };
}

export async function cleanupBrowser(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}
