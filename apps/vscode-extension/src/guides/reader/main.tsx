/**
 * The Guide tab: Plannotator's guide reader (the guide-viewer chain over
 * review-editor's AllFilesCodeView, the components guides.show and the review
 * app render) hosted in a VS Code webview. The extension is the host: it
 * sends the guide (`init`), answers hovers and references from the language
 * server, opens files and diffs beside, keeps the chapter ticks and asks the
 * agent. This page runs only the extension's own script.
 *
 * Boot order: a memory settings backend before anything reads a setting;
 * then wait for `init`; then the worker pool (best effort) and the reader.
 */
import "./reader.css";
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { setStorageBackend } from "@plannotator/ui/utils/storage";
import { ThemeProvider, useTheme } from "@plannotator/ui/components/ThemeProvider";
import { TooltipProvider } from "@plannotator/ui/components/Tooltip";
import { GuideSectionSkeleton } from "@plannotator/guide-viewer/GuideSkeleton";
import { PortableWorkerPool, preparePortableWorkerFactory } from "../../../../guides-show/viewer/portablePool";
import type { ReaderInit } from "../reader-protocol";
import { onMessage, post } from "./bridge";
import { ReaderApp } from "./App";
import { themeSupportsHalf } from "@plannotator/ui/utils/themeRegistry";
import { vscodeThemeOf as readTheme } from "./theme";

/** The theme, with the palette only when it draws that mode (else Dark+ / Light+). */
function vscodeThemeOf(body: HTMLElement) {
  const t = readTheme(body);
  return themeSupportsHalf(t.palette, t.mode) ? t : { mode: t.mode, palette: "dark-plus" };
}

// Settings live in memory for the life of the tab: nothing here is a choice
// to keep (the editor's theme and font decide the look).
const memory = new Map<string, string>();
setStorageBackend({
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
});

document.documentElement.classList.add("pn-vscode");

/** Follows VS Code's theme: its kind decides light or dark, its name the syntax colors. */
function VsCodeTheme() {
  const { setMode, setHalfTheme } = useTheme();
  useEffect(() => {
    const apply = () => {
      const t = vscodeThemeOf(document.body);
      setHalfTheme(t.mode, t.palette);
      setMode(t.mode);
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class", "data-vscode-theme-id", "data-vscode-theme-kind"] });
    return () => observer.disconnect();
  }, [setMode, setHalfTheme]);
  return null;
}

const rootEl = document.getElementById("root")!;
const root = createRoot(rootEl);
const initial = vscodeThemeOf(document.body);
const shell = (children: React.ReactNode) => (
  <ThemeProvider defaultTheme={initial.mode} defaultColorTheme={initial.palette}>
    <VsCodeTheme />
    <TooltipProvider>{children}</TooltipProvider>
  </ThemeProvider>
);

root.render(shell(<div className="min-h-screen bg-background text-foreground"><GuideSectionSkeleton /></div>));

let workerFactory: Promise<(() => Worker) | null> | null = null;
let mounted = false;
onMessage((msg) => {
  if (msg.type !== "init" || mounted) return;
  mounted = true;
  const init: ReaderInit = msg.init;
  workerFactory ??= preparePortableWorkerFactory();
  void workerFactory.then((factory) => {
    document.documentElement.dataset.pnHighlighter = factory ? "worker" : "main-thread";
    const app = <ReaderApp init={init} />;
    root.render(shell(factory ? <PortableWorkerPool workerFactory={factory}>{app}</PortableWorkerPool> : app));
  });
});
// Start preparing the worker while the guide is on its way.
workerFactory = preparePortableWorkerFactory();
post({ type: "ready" });
