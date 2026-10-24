/**
 * Where a guide file's diff opens when the reader is in an answer tab (answers open beside the
 * diff, so the active group is the answers' group): the group already showing this file's diff
 * (the same base and head documents), else the first group whose open tab is not an answer,
 * else a new group beside. Never on top of the answers. Undefined when the reader is not in an
 * answer tab: VS Code's own choice, the active group.
 */

import * as vscode from "vscode";

export const ANSWER_VIEW_TYPE = "plannotator.guides.answer";

function isAnswer(tab: vscode.Tab | undefined): boolean {
  // VS Code reports a webview's viewType with a prefix of its own ("mainThreadWebview-…").
  return !!tab && tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(ANSWER_VIEW_TYPE);
}

export function diffColumnBesideAnswers(
  base: vscode.Uri,
  head: vscode.Uri,
  tabGroups: Pick<vscode.TabGroups, "all" | "activeTabGroup"> | undefined = vscode.window.tabGroups,
): vscode.ViewColumn | undefined {
  const active = tabGroups?.activeTabGroup;
  if (!tabGroups || !active || !isAnswer(active.activeTab)) return undefined;
  const others = tabGroups.all.filter((g) => g !== active && !isAnswer(g.activeTab));
  const same = (a: vscode.Uri, b: vscode.Uri) => a.toString() === b.toString();
  const withThisDiff = others.find((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff && same(t.input.original, base) && same(t.input.modified, head)));
  if (withThisDiff) return withThisDiff.viewColumn;
  const plain = others.find((g) => !g.tabs.some(isAnswer)) ?? others[0];
  return plain ? plain.viewColumn : vscode.ViewColumn.Beside;
}
