/**
 * The run view's approval and bottleneck panels: a request the agent waits on
 * is always visible with every option it offers, and what in the agent's
 * setup holds the run back is named with the one click that helps.
 */

import type { GeneratingViewState } from "../webview-protocol";
import { h, icon } from "./dom";

export type Command = (name: string, ...args: unknown[]) => void;

/**
 * Requests the agent is waiting on: never a silent stall. Each shows every
 * option the agent offers; the first time, automatic approval is offered too.
 */
export function renderPermissions(s: Pick<GeneratingViewState, "id" | "pendingPermissions" | "offerAutoApprove">, command: Command): HTMLElement[] {
  const out = s.pendingPermissions.map((p) =>
    h("section", { class: "pn-approval", role: "alert", "data-permission": p.id },
      h("div", { class: "pn-approval-head" }, icon("shield"), h("b", {}, " Waiting for your approval: "), p.title, p.kind ? h("span", { class: "pn-tag" }, p.kind) : null),
      p.target ? h("code", { class: "pn-approval-target" }, p.target) : null,
      h("div", { class: "pn-actions pn-approval-actions" },
        ...p.options.map((o) =>
          h("button", { class: `pn-btn${o.kind === "allow_once" ? " pn-btn-primary" : ""}`, "data-option": o.optionId, onclick: () => command("answerPermission", s.id, p.id, o.optionId) }, o.name)),
      ),
    ));
  if (s.offerAutoApprove && s.pendingPermissions.length) {
    out.push(h("section", { class: "pn-approval pn-approval-offer", "data-offer": "auto-approve" },
      h("div", {}, icon("unlock"), h("b", {}, " Let the agent work without asking? "),
        h("span", { class: "pn-muted" }, "Approve this request and the rest automatically. What the agent may do is governed by its own settings; you can turn this off in Settings (plannotator.guides.autoApprove).")),
      h("div", { class: "pn-actions" },
        h("button", { class: "pn-btn pn-btn-primary", "data-action": "approveRun", onclick: () => command("approveRun", s.id) }, "Approve all for this run"),
        h("button", { class: "pn-btn", "data-action": "approveAlways", onclick: () => command("approveAlways", s.id, s.pendingPermissions[0]?.id) }, "Always approve during guides"),
      ),
    ));
  }
  return out;
}

/** What in the agent's setup holds the run back: named plainly, with the one click that helps. */
export function renderBottlenecks(s: GeneratingViewState, command: Command): HTMLElement[] {
  return s.bottlenecks.map((b) =>
    h("section", { class: "pn-bottleneck", "data-bottleneck": b.key },
      h("div", {}, icon("warning"), " ", h("b", {}, b.title)),
      b.detail ? h("div", { class: "pn-muted" }, b.detail) : null,
      b.action === "approveRun" && !s.approvals.auto && (s.status === "running" || s.status === "starting")
        ? h("div", { class: "pn-actions" }, h("button", { class: "pn-btn", "data-action": "approveRun", onclick: () => command("approveRun", s.id) }, "Approve automatically for this run"))
        : b.action === "resumeWithApproval" || (b.action === "approveRun" && (s.status === "stopped" || s.status === "failed"))
          ? h("div", { class: "pn-actions" }, h("button", { class: "pn-btn pn-btn-primary", "data-action": "resumeWithApproval", onclick: () => command("resumeWithApproval", s.id) }, "Resume with automatic approval"))
          : null,
    ));
}
