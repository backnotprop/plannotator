/**
 * Entry of `dist/guides.cjs`, loaded on first use by `src/guides-loader.ts`
 * in the main bundle.
 */

import type * as vscode from "vscode";
import { GuidesController, type GuidesHostBridge } from "./controller";
import type { TreeNode } from "./tree";

interface Log {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createGuides(context: vscode.ExtensionContext, log: Log, host: GuidesHostBridge) {
  const controller = new GuidesController(context, log, host);
  return {
    getChildren: (element?: TreeNode) => controller.getChildren(element),
    getTreeItem: (element: TreeNode) => controller.getTreeItem(element),
    getParent: (element: TreeNode) => controller.getParent(element),
    runCommand: (id: string, args: unknown[]) => controller.runCommand(id, args),
    dispose: () => controller.dispose(),
  };
}
