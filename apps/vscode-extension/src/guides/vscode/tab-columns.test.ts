import { describe, expect, it } from "bun:test";
import * as vscode from "vscode";
import { ANSWER_VIEW_TYPE, diffColumnBesideAnswers } from "./tab-columns";

const base = vscode.Uri.parse("plannotator-guide://base/src/deliver.ts");
const head = vscode.Uri.file("/worktrees/pr-482/src/deliver.ts");
const otherHead = vscode.Uri.file("/worktrees/pr-482/src/worker.ts");

const answer = () => ({ input: new vscode.TabInputWebview(`mainThreadWebview-${ANSWER_VIEW_TYPE}`) });
const diff = (modified = head) => ({ input: new vscode.TabInputTextDiff(base, modified) });
const group = (viewColumn: number, tabs: Array<{ input: unknown }>, activeTab = tabs[tabs.length - 1]) => ({ viewColumn, tabs, activeTab });
const groups = (all: ReturnType<typeof group>[], active: ReturnType<typeof group>) => ({ all, activeTabGroup: active }) as unknown as vscode.TabGroups;

describe("where a guide file's diff opens while an answer tab is active", () => {
  it("opens where it would anyway when the reader is not in an answer tab", () => {
    const diffs = group(1, [diff()]);
    expect(diffColumnBesideAnswers(base, head, groups([diffs, group(2, [answer()])], diffs))).toBeUndefined();
  });

  it("goes to the group already showing this file's diff", () => {
    const other = group(1, [diff(otherHead)]);
    const mine = group(3, [diff()]);
    const answers = group(2, [answer()]);
    expect(diffColumnBesideAnswers(base, head, groups([other, answers, mine], answers))).toBe(3);
  });

  it("never the answers' group, even when it also holds the diff", () => {
    const answers = group(1, [diff(), answer()]);
    const plain = group(2, [diff(otherHead)]);
    expect(diffColumnBesideAnswers(base, head, groups([answers, plain], answers))).toBe(2);
  });

  it("else the first group without an answer, else a new group beside", () => {
    const answers = group(2, [answer()]);
    expect(diffColumnBesideAnswers(base, head, groups([group(1, [answer(), diff(otherHead)], diff(otherHead) as never), group(3, [diff(otherHead)]), answers], answers))).toBe(3);
    expect(diffColumnBesideAnswers(base, head, groups([answers], answers))).toBe(vscode.ViewColumn.Beside);
    const two = group(1, [answer()]);
    expect(diffColumnBesideAnswers(base, head, groups([two, answers], answers))).toBe(vscode.ViewColumn.Beside);
  });
});
