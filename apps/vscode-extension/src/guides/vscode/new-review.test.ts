/**
 * The start flow's automatic-approval toggle, through a scripted Quick Pick
 * on the vscode mock (each step picks the first item whose label matches).
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as vscode from "vscode";
import { CLAUDE_CODE, OPENCODE, PI, resolveAgentLaunch, type AgentOptionsCache, type AgentStatus } from "@plannotator/acp-client/agents";
import type { RepoInfo } from "../sources/git";
import { agentRows, autoApproveChoice, pickAgentAndEffort, pullRequestChoice } from "./new-review";

type Item = { label: string; kind?: number };

function scriptQuickPicks(steps: Array<RegExp>): { seen: string[][] } {
  const seen: string[][] = [];
  (vscode.window as unknown as Record<string, unknown>).createQuickPick = () => {
    const accept: Array<() => void> = [];
    const qp = {
      items: [] as Item[],
      activeItems: [] as Item[],
      selectedItems: [] as Item[],
      value: "",
      title: "", step: 0, totalSteps: 0, placeholder: "", busy: false, enabled: true, matchOnDetail: false,
      onDidAccept: (cb: () => void) => { accept.push(cb); return { dispose() {} }; },
      onDidHide: () => ({ dispose() {} }),
      show() {
        // The model step first shows itself busy while the agent's models load; the pick comes at the next show.
        if (qp.busy) return;
        const want = steps.shift();
        if (!want) throw new Error("no scripted step left");
        const tryPick = (left: number) => {
          const item = qp.items.find((i) => i.kind !== -1 && want.test(i.label));
          if (!item && left > 0) return void setTimeout(() => tryPick(left - 1), 1);
          seen.push(qp.items.map((i) => i.label));
          if (!item) throw new Error(`no item matches ${want}: ${qp.items.map((i) => i.label).join(" | ")}`);
          qp.selectedItems = [item];
          for (const cb of accept) cb();
        };
        queueMicrotask(() => tryPick(20));
      },
      dispose() {},
    };
    return qp;
  };
  return { seen };
}

const options: AgentOptionsCache = {
  agentId: "claude-code",
  fetchedAt: Date.now(),
  model: { configId: "model", name: "Model", current: "opus", options: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] },
  effort: { configId: "effort", name: "Effort", current: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
};
const agents: AgentStatus[] = [{ agent: CLAUDE_CODE, launch: { ok: true, command: "/bin/claude-agent-acp", args: [], source: "path" } }];
const input = (autoApprove: boolean) => ({
  agents,
  optionsFor: () => options,
  loadOptions: async () => options,
  onMissing: async () => null,
  standingInstructions: "",
  autoApprove,
});

afterEach(() => {
  delete (vscode.window as unknown as Record<string, unknown>).createQuickPick;
});

describe("the start flow's automatic approval", () => {
  it("turns on for this run when the toggle is picked with the setting off", async () => {
    const { seen } = scriptQuickPicks([/Claude Code/, /Sonnet/, /requests automatically: off/, /^Low$/]);
    const picked = await pickAgentAndEffort(input(false));
    expect(picked?.autoApprove).toBe(true);
    expect(autoApproveChoice(picked!)).toBe(true);
    expect(seen[3]).toContain("$(unlock) Approve the agent's requests automatically: on");
  });

  it("turns off for this run when the toggle is picked with the setting on", async () => {
    scriptQuickPicks([/Claude Code/, /Sonnet/, /requests automatically: on/, /^Low$/]);
    const picked = await pickAgentAndEffort(input(true));
    expect(picked?.autoApprove).toBeUndefined();
    expect(autoApproveChoice(picked!)).toBe(false);
  });

  it("keeps the setting's value when the toggle is left alone", async () => {
    scriptQuickPicks([/Claude Code/, /Sonnet/, /^Low$/]);
    expect(autoApproveChoice((await pickAgentAndEffort(input(true)))!)).toBe(true);
    scriptQuickPicks([/Claude Code/, /Sonnet/, /^Low$/]);
    expect(autoApproveChoice((await pickAgentAndEffort(input(false)))!)).toBe(false);
  });
});

describe("an agent whose ACP adapter Guided Reviews installs", () => {
  const missing: AgentStatus[] = [
    { agent: CLAUDE_CODE, launch: resolveAgentLaunch(CLAUDE_CODE, {}, () => null, () => null) },
    { agent: OPENCODE, launch: resolveAgentLaunch(OPENCODE, {}, () => null, () => null) },
  ];

  it("is ready to pick (it installs on first use) only while installAdapters is on", () => {
    const on = agentRows(missing, undefined, true);
    expect(on.map((r) => [r.status.agent.id, r.ready, r.description])).toEqual([
      ["claude-code", true, "installs its ACP adapter on first use"],
      ["opencode", false, "not installed"],
    ]);
    expect(on[0].detail).toContain("@agentclientprotocol/claude-agent-acp@0.91.0");
    expect(on[0].active).toBe(true);
    expect(agentRows(missing, undefined, false).map((r) => r.ready)).toEqual([false, false]);
  });

  it("goes on to the model step, where loading the options installs the adapter", async () => {
    const loads: string[] = [];
    scriptQuickPicks([/Claude Code/, /Sonnet/, /^Low$/]);
    const picked = await pickAgentAndEffort({ ...input(false), agents: missing, installAdapters: true, optionsFor: () => null, loadOptions: async (a) => { loads.push(a.id); return options; } });
    expect(loads).toEqual(["claude-code"]);
    expect(picked?.agent.id).toBe("claude-code");
  });

  it("with installAdapters off, a pick shows how to install it, and continues when it was installed there", async () => {
    const shown: string[] = [];
    scriptQuickPicks([/Claude Code/, /Sonnet/, /^Low$/]);
    const picked = await pickAgentAndEffort({
      ...input(false),
      agents: missing,
      installAdapters: false,
      onMissing: async (status) => { shown.push(status.agent.id); return { agent: status.agent, launch: { ok: true, command: "/x/node", args: ["e.js"], source: "managed" } }; },
    });
    expect(shown).toEqual(["claude-code"]);
    expect(picked?.agent.id).toBe("claude-code");
  });
});

describe("a typed or pasted pull request", () => {
  const repo = { repoKey: "github.com__northwind__checkout-service", github: { host: "github.com", owner: "northwind", repo: "checkout-service" } } as RepoInfo;

  it("is a PR of the open repository by number or by its link", () => {
    expect(pullRequestChoice("482", repo)).toEqual({ kind: "pr", number: 482 });
    expect(pullRequestChoice("https://github.com/northwind/checkout-service/pull/482/files", repo)).toEqual({ kind: "pr", number: 482 });
  });

  it("is a PR of another repository by its link, with or without a folder open", () => {
    expect(pullRequestChoice("https://github.com/northwind/ledger-ui/pull/212", repo)).toEqual({ kind: "pr", number: 212, repo: "northwind/ledger-ui" });
    expect(pullRequestChoice("https://github.com/northwind/ledger-ui/pull/212", null)).toEqual({ kind: "pr", number: 212, repo: "northwind/ledger-ui" });
    expect(pullRequestChoice("https://ghe.corp.example/team/svc/pull/7", null)).toEqual({ kind: "pr", number: 7, repo: "ghe.corp.example/team/svc" });
  });

  it("needs a folder for a bare number, and is nothing otherwise", () => {
    expect(pullRequestChoice("482", null)).toBeNull();
    expect(pullRequestChoice("not a pr", repo)).toBeNull();
  });
});

describe("the picker for who answers questions about a guide", () => {
  it("says the agent answers, and an agent that cannot reach the tools answers in text", () => {
    const pi: AgentStatus = { agent: PI, launch: { ok: true, source: "path", command: "/usr/bin/pi-acp", args: [] } as AgentStatus["launch"] };
    const [writes] = agentRows([pi]);
    expect(writes.description).toContain("can't write guides yet");
    const [answers] = agentRows([pi], undefined, false, "answer");
    expect(answers.description).toContain("answers in text only");
    expect(answers.description).not.toContain("guides");
    expect(answers.detail).toStartWith("Answers in text only");
  });
});
