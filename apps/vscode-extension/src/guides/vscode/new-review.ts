/**
 * Starting a review (SPEC 3.2): a four-step Quick Pick. What (a PR or the
 * local changes), the agent (installed ones first; a missing one shows how to
 * install it), its model, then effort, plus "Add instructions for
 * this guide…" with the standing instructions shown. The models and efforts
 * are the agent's own, read from its ACP session config options.
 */

import * as vscode from "vscode";
import type { ConfigChoice } from "@plannotator/acp-client/client";
import { canStart, pickDefault, type AgentDescriptor, type AgentOptionsCache, type AgentStatus } from "@plannotator/acp-client/agents";
import type { DashboardModel } from "../dashboard";
import { ghRepoArg, isOpenRepository, parsePullRequestRef, parsePullRequestUrl, type PullRequestRow } from "../sources/github";
import type { RepoInfo } from "../sources/git";
import type { LocalChangesMode } from "../sources/git";
import type { AgentChoiceRecord } from "../store";

/** `repo` (`[host/]owner/repo`): a pull request of a repository that is not the one open in VS Code. */
export type SourceChoice = { kind: "local"; mode: LocalChangesMode } | { kind: "pr"; number: number; repo?: string };

/**
 * What a typed PR number or link means: a PR of the open repository, or a
 * PR of another repository (a link), which is guided from a clone in the
 * extension's storage. Null when it is neither.
 */
export function pullRequestChoice(text: string, repo: RepoInfo | null): SourceChoice | null {
  const url = parsePullRequestUrl(text);
  if (url) {
    const ghRepo = ghRepoArg(url);
    if (isOpenRepository(repo, url)) return { kind: "pr", number: url.number };
    return { kind: "pr", number: url.number, repo: ghRepo };
  }
  if (!repo) return null;
  const n = parsePullRequestRef(text, repo);
  return n !== null ? { kind: "pr", number: n } : null;
}

/** With no repository open: paste a pull request link. */
export async function pickPullRequestByLink(): Promise<SourceChoice | undefined> {
  const text = await vscode.window.showInputBox({
    title: "Guide a pull request",
    prompt: "Paste a GitHub pull request link. Guided Reviews clones the repository into its own storage (no checkout of yours is touched).",
    placeHolder: "https://github.com/owner/repo/pull/123",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() === "" || pullRequestChoice(v, null) ? null : "Paste a link like https://github.com/owner/repo/pull/123"),
  });
  return text ? pullRequestChoice(text, null) ?? undefined : undefined;
}

interface Item<T> extends vscode.QuickPickItem {
  value?: T;
}

function prDetail(p: PullRequestRow): string {
  const who = p.isMine ? "yours" : `@${p.author}`;
  return `${p.baseRefName} ← ${p.headRefName} · ${p.changedFiles} ${p.changedFiles === 1 ? "file" : "files"} · +${p.additions} −${p.deletions} · ${who}${p.isDraft ? " · draft" : ""}${p.reviewRequested ? " · waiting on you" : ""}`;
}

/** A Quick Pick that resolves to the accepted item, or the typed text when it matches `acceptValue`. */
function pick<T>(qp: vscode.QuickPick<Item<T>>, acceptValue?: (text: string) => T | undefined): Promise<T | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T | undefined) => {
      if (done) return;
      done = true;
      resolve(v);
      qp.dispose();
    };
    qp.onDidAccept(() => {
      const typed = acceptValue?.(qp.value);
      if (typed !== undefined && (qp.selectedItems.length === 0 || qp.value.trim() !== "")) return finish(typed);
      finish(qp.selectedItems[0]?.value);
    });
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

const PICK_PR = Symbol("pick-pr");

export async function pickSource(model: DashboardModel): Promise<SourceChoice | undefined> {
  if (!model.repo) return pickPullRequestByLink();
  const qp = vscode.window.createQuickPick<Item<SourceChoice | typeof PICK_PR>>();
  qp.title = "New Guided Review";
  qp.step = 1;
  qp.totalSteps = 4;
  qp.placeholder = "What should the guide cover? (or type a PR number or link)";
  qp.matchOnDetail = true;
  const items: Array<Item<SourceChoice | typeof PICK_PR>> = [{ label: "This repository", kind: vscode.QuickPickItemKind.Separator }];
  const cur = model.currentBranchPR;
  if (cur) {
    items.push({ label: `$(git-pull-request) Pull request #${cur.number}`, description: cur.title, detail: prDetail(cur), value: { kind: "pr", number: cur.number } });
  }
  const local = model.local;
  if (local) {
    items.push({
      label: "$(git-compare) Local changes",
      description: `since ${local.baseLabel}`,
      detail: `${local.files} ${local.files === 1 ? "file" : "files"} · +${local.additions} −${local.deletions} · committed, uncommitted and untracked work`,
      value: { kind: "local", mode: "since-base" },
    });
    items.push({ label: "$(git-compare) Uncommitted changes only", description: "against HEAD", value: { kind: "local", mode: "uncommitted" } });
  }
  if (model.gh.state === "ok") {
    items.push({ label: "$(git-pull-request) Pull request…", description: `pick from ${model.prs.length} open, or paste a link`, detail: "GitHub via gh · no checkout needed: the PR opens in a worktree", value: PICK_PR });
  } else {
    items.push({ label: "$(info) Pull requests need the GitHub CLI", description: model.gh.state === "missing" ? "install gh" : model.gh.state === "signed-out" ? "run `gh auth login`" : "", detail: "Plannotator uses your own gh to list and fetch PRs." });
  }
  qp.items = items;
  if (cur) qp.activeItems = [items[1]];
  const choice = await pick(qp, (text) => pullRequestChoice(text, model.repo) ?? undefined);
  if (choice === PICK_PR) return pickPullRequest(model);
  return choice as SourceChoice | undefined;
}

export async function pickPullRequest(model: DashboardModel): Promise<SourceChoice | undefined> {
  const qp = vscode.window.createQuickPick<Item<SourceChoice>>();
  qp.title = "New Guided Review: pull request";
  qp.step = 1;
  qp.totalSteps = 4;
  qp.placeholder = "Pick a PR, or paste its number or link";
  qp.matchOnDetail = true;
  qp.items = model.prs.map((p) => ({ label: `#${p.number} ${p.title}`, detail: prDetail(p), value: { kind: "pr", number: p.number } }));
  return pick(qp, (text) => pullRequestChoice(text, model.repo) ?? undefined);
}

/** Whether a run approves automatically: exactly what the start flow's toggle ended on (it starts from the setting). */
export function autoApproveChoice(picked: AgentPickResult): boolean {
  return picked.autoApprove === true;
}

export interface AgentPickResult {
  agent: AgentChoiceRecord;
  instructions?: string;
  /** The user opted in to approving the agent's permission requests automatically for this run. */
  autoApprove?: boolean;
}

const LOAD_MODELS = Symbol("load-models");
const ADD_INSTRUCTIONS = Symbol("add-instructions");
const TOGGLE_APPROVE = Symbol("toggle-approve");

export interface RememberedChoice {
  agent?: string;
  model?: string;
  effort?: string;
}

/**
 * The agent step's rows: agents ready to start first (the remembered one
 * active), then the ones to install. Ready means installed, or an agent whose
 * ACP adapter Guided Reviews installs on first use (`installAdapters`).
 */
export function agentRows(agents: readonly AgentStatus[], remembered?: string, installAdapters = false, purpose: AgentPurpose = "write"): Array<{ status: AgentStatus; label: string; description: string; detail?: string; active: boolean; ready: boolean }> {
  const caveat = purpose === "answer" ? "answers in text only" : "can't write guides yet";
  const rows = agents.map((status) => {
    const { agent, launch } = status;
    const ready = canStart(launch, installAdapters);
    const willInstall = !launch.ok && ready;
    const source = launch.ok ? (launch.source === "setting" ? "installed · command from settings" : launch.source === "managed" ? "installed by Guided Reviews" : "installed") : "";
    return {
      status,
      ready,
      label: `${launch.ok ? "$(check)" : willInstall ? "$(arrow-circle-down)" : "$(cloud-download)"} ${agent.label}`,
      description: launch.ok
        ? [source, agent.note ? caveat : ""].filter(Boolean).join(" · ")
        : willInstall
          ? ["installs its ACP adapter on first use", agent.note ? caveat : ""].filter(Boolean).join(" · ")
          : launch.reason === "requires" ? `needs ${agent.requires?.label ?? "a program"}` : agent.installCommand ? "not installed" : "not found",
      detail:
        (agent.note && (purpose === "answer" ? ANSWER_NOTE : agent.note)) ??
        (launch.ok
          ? "Runs with your own settings and permissions."
          : willInstall && agent.adapter
            ? `Installs ${agent.adapter.package}@${agent.adapter.version} into Guided Reviews' own storage. Runs with your own settings and permissions.`
            : launch.reason === "requires" || launch.reason === "setting" ? launch.message : agent.installCommand ? `Install: ${agent.installCommand}` : launch.message),
      active: false,
    };
  });
  const firstReady = rows.find((r) => r.ready);
  const target = rows.find((r) => r.status.agent.id === remembered && r.ready) ?? firstReady;
  if (target) target.active = true;
  return rows;
}

/** What the picked agent will do: write a guide, or answer questions about one. */
export type AgentPurpose = "write" | "answer";

/** An agent with a note (it cannot reach Plannotator's tools) can still answer, in text. */
const ANSWER_NOTE = "Answers in text only: it cannot reach Plannotator's tools, so it cannot draw an answer page.";

/**
 * Steps 2 to 4: the agent, its model, then effort and instructions.
 * `loadOptions` asks an agent for its options when there are none cached yet;
 * `onMissing` is told when a missing agent is picked (show how to install it).
 */
export async function pickAgentAndEffort(input: {
  agents: readonly AgentStatus[];
  optionsFor: (agentId: string) => AgentOptionsCache | null;
  loadOptions: (agent: AgentDescriptor) => Promise<AgentOptionsCache | null>;
  /** A missing agent was picked: show how to get it. Answers the agent ready to start when that happened now (its adapter was installed), else null. */
  onMissing: (status: AgentStatus) => Promise<AgentStatus | null>;
  /** `plannotator.guides.installAdapters`: an agent whose adapter is missing can be picked, and its adapter is installed on first use. */
  installAdapters?: boolean;
  remembered?: RememberedChoice;
  standingInstructions: string;
  /** Only the defaults (the Change defaults command): no instructions step. */
  defaultsOnly?: boolean;
  /** Automatic approval preselected (the `plannotator.guides.autoApprove` setting). */
  autoApprove?: boolean;
  /** The Quick Pick's title (default "Guide defaults" or "New Guided Review"). */
  title?: string;
  /** What the agent will do (default: write the guide); the words follow it. */
  purpose?: AgentPurpose;
}): Promise<AgentPickResult | undefined> {
  const title = input.title ?? (input.defaultsOnly ? "Guide defaults" : "New Guided Review");
  const total = input.defaultsOnly ? 3 : 4;
  const offset = input.defaultsOnly ? 0 : 1;
  // Step: agent
  for (;;) {
    const aq = vscode.window.createQuickPick<Item<AgentStatus>>();
    aq.title = title;
    aq.step = 1 + offset;
    aq.totalSteps = total;
    aq.placeholder = input.purpose === "answer"
      ? "Which agent answers questions about this guide? It runs with your own setup, settings and sign-in."
      : "Which agent writes the guide? It runs with your own setup, settings and sign-in.";
    aq.matchOnDetail = true;
    const rows = agentRows(input.agents, input.remembered?.agent, input.installAdapters, input.purpose);
    const items: Array<Item<AgentStatus>> = [];
    const installed = rows.filter((r) => r.ready);
    const missing = rows.filter((r) => !r.ready);
    if (installed.length) items.push({ label: "Ready", kind: vscode.QuickPickItemKind.Separator });
    for (const r of installed) items.push({ label: r.label, description: r.description, detail: r.detail, value: r.status });
    if (missing.length) items.push({ label: "Not installed: pick one to see how to install it", kind: vscode.QuickPickItemKind.Separator });
    for (const r of missing) items.push({ label: r.label, description: r.description, detail: r.detail, value: r.status });
    aq.items = items;
    const active = items.find((i) => i.value && rows.find((r) => r.active)?.status === i.value);
    if (active) aq.activeItems = [active];
    let status = await pick(aq);
    if (!status) return undefined;
    if (!canStart(status.launch, input.installAdapters ?? false)) {
      const now = await input.onMissing(status);
      if (!now) continue;
      status = now;
    }
    const picked = await pickModelAndEffort({ ...input, agent: status.agent, title, total, offset, remembered: input.remembered?.agent === status.agent.id ? input.remembered : undefined });
    if (picked === BACK) continue;
    return picked;
  }
}

const BACK = Symbol("back");

async function pickModelAndEffort(input: {
  agent: AgentDescriptor;
  optionsFor: (agentId: string) => AgentOptionsCache | null;
  loadOptions: (agent: AgentDescriptor) => Promise<AgentOptionsCache | null>;
  remembered?: RememberedChoice;
  standingInstructions: string;
  defaultsOnly?: boolean;
  autoApprove?: boolean;
  title: string;
  total: number;
  offset: number;
  purpose?: AgentPurpose;
}): Promise<AgentPickResult | undefined | typeof BACK> {
  const { agent } = input;
  let options = input.optionsFor(agent.id);
  let triedLoading = false;
  // Step: model
  for (;;) {
    const qp = vscode.window.createQuickPick<Item<ConfigChoice | null | typeof LOAD_MODELS | typeof BACK>>();
    qp.title = input.title;
    qp.step = 2 + input.offset;
    qp.totalSteps = input.total;
    qp.placeholder = `Which ${agent.label} model ${input.purpose === "answer" ? "answers" : "writes the guide"}?`;
    if (!options && !triedLoading) {
      // First time: the agent lists its own models (nothing is prompted, no cost); cached afterwards.
      triedLoading = true;
      qp.busy = true;
      qp.enabled = false;
      qp.placeholder = `Asking ${agent.label} for its models…`;
      let hidden = false;
      const off = qp.onDidHide(() => (hidden = true));
      qp.show();
      options = await input.loadOptions(agent);
      off.dispose();
      if (hidden) {
        qp.dispose();
        return undefined;
      }
      qp.busy = false;
      qp.enabled = true;
      qp.placeholder = `Which ${agent.label} model ${input.purpose === "answer" ? "answers" : "writes the guide"}?`;
    }
    const items: Array<Item<ConfigChoice | null | typeof LOAD_MODELS | typeof BACK>> = [{ label: agent.label, kind: vscode.QuickPickItemKind.Separator }];
    const models = options?.model;
    const preferred = pickDefault(models ?? null, agent.defaultModel, input.remembered?.model);
    if (models && models.options.length > 0) {
      for (const m of models.options) {
        items.push({
          label: `$(sparkle) ${m.name}`,
          description: [m.value === preferred?.value ? "default" : "", m.value === models.current ? "agent's current" : ""].filter(Boolean).join(" · "),
          detail: m.description,
          value: m,
        });
      }
    } else {
      items.push({ label: "$(sparkle) Agent default", description: options ? `${agent.label} exposes no model choice` : "", value: null });
    }
    if (!options) items.push({ label: `$(refresh) Load the models from ${agent.label}`, detail: `Starts ${agent.label} once to read its options (nothing runs, no cost).`, value: LOAD_MODELS });
    items.push({ label: "$(arrow-left) Another agent", value: BACK, alwaysShow: true });
    qp.items = items;
    const active = items.find((i) => i.value && typeof i.value === "object" && preferred && i.value.value === preferred.value);
    if (active) qp.activeItems = [active];
    const chosen = await pick(qp);
    if (chosen === undefined) return undefined;
    if (chosen === BACK) return BACK;
    if (chosen === LOAD_MODELS) {
      options = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Asking ${agent.label} for its models…` }, () => input.loadOptions(agent));
      continue;
    }
    const model = chosen as ConfigChoice | null;
    // Step: effort (+ instructions)
    let instructions = input.standingInstructions || undefined;
    let added = false;
    let autoApprove = !!input.autoApprove;
    for (;;) {
      const eq = vscode.window.createQuickPick<Item<ConfigChoice | null | typeof ADD_INSTRUCTIONS | typeof TOGGLE_APPROVE>>();
      eq.title = input.title;
      eq.step = 3 + input.offset;
      eq.totalSteps = input.total;
      eq.placeholder = `Effort for ${model?.name ?? "the agent's default model"}`;
      const efforts = options?.effortByModel?.[model?.value ?? ""] ?? options?.effort ?? null;
      const preferredEffort = pickDefault(efforts, agent.defaultEffort, input.remembered?.effort);
      const eItems: Array<Item<ConfigChoice | null | typeof ADD_INSTRUCTIONS | typeof TOGGLE_APPROVE>> = [];
      if (efforts && efforts.options.length) {
        for (const e of efforts.options) eItems.push({ label: e.name, description: e.value === preferredEffort?.value ? "default" : "", detail: e.description, value: e });
      } else eItems.push({ label: "Agent default", description: "this model has no effort levels", value: null });
      if (!input.defaultsOnly) {
        eItems.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        eItems.push({
          label: added ? "$(check) Instructions for this guide" : "$(edit) Add instructions for this guide…",
          description: instructions ? "" : "optional",
          detail: instructions ? `${added ? "" : "Standing instructions: "}${instructions.replace(/\s+/g, " ").slice(0, 110)}` : "Standing instructions: none (set them in Plannotator's web app)",
          value: ADD_INSTRUCTIONS,
          alwaysShow: true,
        });
        eItems.push({
          label: autoApprove ? "$(unlock) Approve the agent's requests automatically: on" : "$(lock) Approve the agent's requests automatically: off",
          description: autoApprove ? "this run" : "you approve each request",
          detail: autoApprove
            ? `Every permission request ${agent.label} sends is approved for you during this guide${agent.permissiveModes?.length ? `, and it runs in its ${agent.permissiveModes[0]} mode` : ""}. Pick to turn off.`
            : `Off: ${agent.label} runs with your own settings and you answer what it asks about. Pick to turn on for this guide.`,
          value: TOGGLE_APPROVE,
          alwaysShow: true,
        });
      }
      eq.items = eItems;
      const activeEffort = eItems.find((i) => i.value && typeof i.value === "object" && preferredEffort && i.value.value === preferredEffort.value);
      if (activeEffort) eq.activeItems = [activeEffort];
      const effortChoice = await pick(eq);
      if (effortChoice === undefined) return undefined;
      if (effortChoice === TOGGLE_APPROVE) {
        autoApprove = !autoApprove;
        continue;
      }
      if (effortChoice === ADD_INSTRUCTIONS) {
        const text = await vscode.window.showInputBox({
          title: "Instructions for this guide",
          prompt: "Appended to the guide prompt. Prefilled with your standing instructions.",
          value: instructions ?? "",
          ignoreFocusOut: true,
        });
        if (text !== undefined) {
          instructions = text.trim() || undefined;
          added = true;
        }
        continue;
      }
      const effort = effortChoice as ConfigChoice | null;
      return {
        agent: {
          id: agent.id,
          label: agent.label,
          ...(model && { model: { id: model.value, label: model.name } }),
          ...(effort && { effort: { id: effort.value, label: effort.name } }),
        },
        ...(instructions && { instructions }),
        ...(autoApprove && { autoApprove: true }),
      };
    }
  }
}
