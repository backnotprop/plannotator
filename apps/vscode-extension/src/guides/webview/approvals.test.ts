import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { GeneratingViewState } from "../webview-protocol";
import { renderBottlenecks, renderPermissions } from "./approvals";

// A DOM for this file only (the package's run keeps native globals otherwise).
// The registrator is a dependency of packages/ui (its DOM test preload), so it is resolved from there.
let registrator: { register(): void; unregister(): Promise<void> } | null = null;
beforeAll(async () => {
  if (typeof document !== "undefined") return;
  const path = Bun.resolveSync("@happy-dom/global-registrator", join(import.meta.dir, "..", "..", "..", "..", "..", "packages", "ui"));
  registrator = (await import(path)).GlobalRegistrator;
  registrator!.register();
});
afterAll(async () => {
  await registrator?.unregister();
});

function state(over: Partial<GeneratingViewState> = {}): GeneratingViewState {
  return {
    mode: "generating", id: "g1", status: "running", statusMessage: null, kicker: "", title: "", sub: "", agent: "Claude Code", modelEffort: "",
    startedAt: 0, endedAt: null, cost: null, activity: [], chapters: [], unplaced: [], left: [], summary: "", savedGuideId: null, signIn: null, memoryOnly: false,
    pendingPermissions: [], approvals: { auto: false, mode: null }, offerAutoApprove: false, bottlenecks: [],
    ...over,
  };
}

const pending = {
  id: 7, title: "Run npm test", kind: "execute", target: "npm test",
  options: [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    { optionId: "reject-always", name: "Never", kind: "reject_always" },
  ],
};

describe("the run view's approvals", () => {
  it("shows a pending request with every option the agent offers, and sends the one clicked", () => {
    const sent: unknown[][] = [];
    const [panel] = renderPermissions(state({ pendingPermissions: [pending] }), (...a) => sent.push(a));
    expect(panel.textContent).toContain("Waiting for your approval: Run npm test");
    expect(panel.textContent).toContain("npm test");
    const buttons = [...panel.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Allow once", "Always allow", "Reject", "Never"]);
    buttons[1].click();
    expect(sent).toEqual([["answerPermission", "g1", 7, "allow-always"]]);
  });

  it("offers automatic approval inline while a request waits, for this run or always", () => {
    const sent: unknown[][] = [];
    const panels = renderPermissions(state({ pendingPermissions: [pending], offerAutoApprove: true }), (...a) => sent.push(a));
    const offer = panels.find((p) => p.getAttribute("data-offer") === "auto-approve")!;
    expect(offer.textContent).toContain("Let the agent work without asking?");
    for (const b of offer.querySelectorAll("button")) (b as HTMLButtonElement).click();
    expect(sent).toEqual([["approveRun", "g1"], ["approveAlways", "g1", 7]]);
    // No offer without a pending request, or once it is on.
    expect(renderPermissions(state({ offerAutoApprove: true }), () => {})).toEqual([]);
  });

  it("names a bottleneck with its one-click way through: approve now while running, resume with approval once stopped", () => {
    const b = { key: "turned-down", title: "You turned down Run npm test", detail: "Claude Code will try another way.", action: "approveRun" as const };
    const sent: unknown[][] = [];
    const [running] = renderBottlenecks(state({ bottlenecks: [b] }), (...a) => sent.push(a));
    expect(running.textContent).toContain("You turned down Run npm test");
    running.querySelector("button")!.click();
    const [stopped] = renderBottlenecks(state({ status: "stopped", bottlenecks: [b] }), (...a) => sent.push(a));
    stopped.querySelector("button")!.click();
    expect(sent).toEqual([["approveRun", "g1"], ["resumeWithApproval", "g1"]]);
    const [noAction] = renderBottlenecks(state({ bottlenecks: [{ key: "no-builder", title: "Pi never reached the guide's tools", detail: null, action: null }] }), () => {});
    expect(noAction.querySelector("button")).toBeNull();
  });
});
