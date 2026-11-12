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

function vscodeThemeOf(body: HTMLElement) {
  const t = readTheme(body);
  return themeSupportsHalf(t.palette, t.mode) ? t : { mode: t.mode, palette: "dark-plus" };
}

const memory = new Map<string, string>();
setStorageBackend({
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
});

document.documentElement.classList.add("pn-vscode");

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
workerFactory = preparePortableWorkerFactory();
post({ type: "ready" });
