/**
 * The Guides view's footprint in the main bundle: a tree view and command
 * stubs, all of which load `dist/guides.cjs` the first time they
 * are used. Someone who only uses the browser router never loads it.
 *
 * Typed with a few local shapes rather than `vscode`'s, because this file is
 * checked against the test mock of `vscode`, which models only what the main
 * bundle uses.
 */

import * as vscode from "vscode";
import * as path from "path";

/** Every `plannotator.guides.*` command in package.json. */
export const GUIDE_COMMANDS = [
  "plannotator.guides.newReview",
  "plannotator.guides.openHome",
  "plannotator.guides.refresh",
  "plannotator.guides.guideLocal",
  "plannotator.guides.guidePullRequest",
  "plannotator.guides.openGuide",
  "plannotator.guides.closeGuide",
  "plannotator.guides.resumeDraft",
  "plannotator.guides.saveDraftAsIs",
  "plannotator.guides.deleteDraft",
  "plannotator.guides.deleteGuide",
  "plannotator.guides.exportGuide",
  "plannotator.guides.showGeneration",
  "plannotator.guides.cancelGeneration",
  "plannotator.guides.openChapter",
  "plannotator.guides.nextChapter",
  "plannotator.guides.markChapterReviewed",
  "plannotator.guides.openFile",
  "plannotator.guides.nextFile",
  "plannotator.guides.toggleFileReviewed",
  "plannotator.guides.askAboutSelection",
  "plannotator.guides.openAnswer",
  "plannotator.guides.changeDefaults",
  "plannotator.guides.updateAdapters",
  "plannotator.guides.openPullRequestOnGitHub",
  "plannotator.guides.openPullRequest",
  "plannotator.guides.openFolder",
] as const;

export const GUIDES_TREE_VIEW = "plannotator.guides.tree";

interface Disposable {
  dispose(): unknown;
}
type Listener<T> = (value: T) => unknown;

/** What `dist/guides.cjs` exports. */
export interface GuidesModule {
  createGuides(context: unknown, log: unknown, host: GuidesHost): GuidesApi;
}

export interface GuidesHost {
  /** The Guides tree view (a `vscode.TreeView`). */
  treeView: unknown;
  /** Tell the tree view its data changed. */
  fireTreeChanged(element?: unknown): void;
}

export interface GuidesApi {
  getChildren(element?: unknown): unknown;
  getTreeItem(element: unknown): unknown;
  getParent(element: unknown): unknown;
  runCommand(id: string, args: unknown[]): Promise<unknown>;
  dispose(): void;
}

interface LoaderTreeView extends Disposable {
  visible?: boolean;
  onDidChangeVisibility?(listener: (e: { visible: boolean }) => unknown): Disposable;
}

interface LoaderWindow {
  createTreeView(id: string, options: { treeDataProvider: unknown; showCollapseAll?: boolean; manageCheckboxStateManually?: boolean }): LoaderTreeView;
}

/**
 * Showing the view from the activity bar opens the Guided Reviews dashboard
 * tab, once per session: on the first change from hidden to visible. A view
 * VS Code restored as visible at startup does not open it; the next time the
 * user hides and shows it, it does. (The controller skips it when a
 * dashboard, guide or run tab is already open.)
 */
export function dashboardAutoOpener(initiallyVisible: boolean, open: () => void): (visible: boolean) => void {
  let wasVisible = initiallyVisible;
  let opened = false;
  return (visible) => {
    if (visible && !wasVisible && !opened) {
      opened = true;
      open();
    }
    wasVisible = visible;
  };
}

export function registerGuidesLoader(
  context: { subscriptions: Disposable[]; extensionPath: string },
  log: { error(message: string): void },
): void {
  let api: GuidesApi | null = null;
  const treeListeners = new Set<Listener<unknown>>();
  let treeView: Disposable | null = null;

  const load = (): GuidesApi => {
    if (api) return api;
    // A computed path, so the bundler leaves it alone: the Guides bundle is loaded only now.
    const modulePath = path.join(context.extensionPath, "dist", "guides.cjs");
    const mod = require(modulePath) as GuidesModule;
    api = mod.createGuides(context, log, {
      treeView,
      fireTreeChanged: (element) => {
        for (const l of treeListeners) l(element);
      },
    });
    context.subscriptions.push({ dispose: () => api?.dispose() });
    return api;
  };

  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      log.error(`[guides] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return fallback;
    }
  };

  const treeDataProvider = {
    onDidChangeTreeData: (listener: Listener<unknown>): Disposable => {
      treeListeners.add(listener);
      return { dispose: () => treeListeners.delete(listener) };
    },
    getChildren: (element?: unknown) => safe(() => load().getChildren(element), []),
    getTreeItem: (element: unknown) => load().getTreeItem(element),
    getParent: (element: unknown) => safe(() => load().getParent(element), undefined),
  };

  const win = vscode.window as unknown as LoaderWindow;
  const view = win.createTreeView(GUIDES_TREE_VIEW, { treeDataProvider, showCollapseAll: true, manageCheckboxStateManually: true });
  treeView = view;
  context.subscriptions.push(view);
  const onVisible = dashboardAutoOpener(view.visible === true, () => {
    try {
      void load().runCommand("plannotator.guides.openHome", [{ auto: true }]);
    } catch (err) {
      log.error(`[guides] openHome: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  });
  const visibility = view.onDidChangeVisibility?.((e) => onVisible(e.visible));
  if (visibility) context.subscriptions.push(visibility);
  for (const id of GUIDE_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...args: unknown[]) => {
        try {
          return load().runCommand(id, args);
        } catch (err) {
          log.error(`[guides] ${id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
          return undefined;
        }
      }),
    );
  }
}
