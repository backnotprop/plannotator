/**
 * The Guides view: dashboard, starting a review, the generating view and the
 * reader, wired to VS Code. State lives here; the pieces it drives
 * (generation, store, data sources, reader model) know nothing of VS Code.
 */

import * as vscode from "vscode";
import { basename, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createGuideHtml, guideExportFilename, resolveGuideViewerAssets } from "@plannotator/core/guide-format";
import { GUIDE_VIEWER_MANIFEST } from "@plannotator/core/guide-viewer-manifest";
import { findSavedGuideById } from "@plannotator/shared/guide-store";
import { readGuideInstructions } from "@plannotator/shared/guide-instructions-store";
import { AcpClient, killPendingProcessGroups } from "@plannotator/acp-client/client";
import {
  CLAUDE_CODE,
  CUSTOM_AGENT_ID,
  customAgent,
  detectAgents,
  engineLabel,
  findAgent,
  installCommandFor,
  KNOWN_AGENTS,
  readAgentOptions,
  type AdapterResolution,
  type AgentDescriptor,
  type AgentOptionsCache,
  type AgentStatus,
  type CommandOverride,
  type LoginCommand,
} from "@plannotator/acp-client/agents";
import { isSameProgram } from "@plannotator/acp-client/same-program";
import { agentLaunchFor, resolveGuidesLaunch } from "../acp/agent-cli";
import { planSignIn } from "../acp/sign-in";
import { adaptersRoot, hasManagedCopy, installAdapter, managedLaunch, type InstallResult } from "../acp/adapters";
import { ensureAgentLaunch, type ReadyLaunch } from "@plannotator/acp-client/ensure-launch";
import { parseGuideLink } from "../core/adapter";
import { loadDashboard, type DashboardModel } from "../dashboard";
import { GuideGeneration, type GenerationState, type PendingPermission, type PermissionAnswer } from "../generation";
import { startRelayHost, type RelayHost } from "../mcp/relay-host";
import { ReaderModel, guideWorktreePath, resolveReaderSides, type ReaderSides } from "../reader-model";
import { removeShareBeforeDelete } from "../share";
import { buildLocalChangesPatch, changedFilesFromPatch, getRepoInfo, type LocalChangesMode } from "../sources/git";
import {
  ensureRepoClone,
  ghRepoArg,
  isOpenRepository,
  ghRepoOfKey,
  parseGhRepoArg,
  parsePullRequestUrl,
  preparePullRequestWorktree,
  pullRequestHead,
  removePullRequestWorktree,
  repoClonePath,
  repoKeyForGhRepo,
  viewPullRequest,
} from "../sources/github";
import { defaultRunner, findExecutable, type Runner } from "../sources/runner";
import {
  deleteDraftRecord,
  deleteSavedGuide,
  allRepoKeys,
  guideForPullRequest,
  guideHistoryEnabled,
  loadDraftRecord,
  loadSavedGuide,
  setChapterReviewed,
  snapshotOfGuide,
  writeSidecar,
  type AgentChoiceRecord,
  type DraftRecord,
  type LoadedGuide,
  type RecentEntry,
  type ReviewSourceRecord,
} from "../store";
import type { ChapterViewState, GeneratingViewState, GuideViewState, HomeViewState } from "../webview-protocol";
import { chapterColorCss, linkInfo, locateLink, resolveSymbolForBuilder } from "./intel";
import { autoApproveChoice, pickAgentAndEffort, pickPullRequest, pickPullRequestByLink, pickSource, type RememberedChoice, type SourceChoice } from "./new-review";
import { ReaderUi } from "./reader-ui";
import { GuideAsks } from "./asks";
import { approveAlwaysTarget, isKnownPullRequestUrl } from "../trust";
import { getChildren, getParent, getTreeItem, nodeId, relativeTime, type TreeData, type TreeNode } from "./tree";
import { ANSWER_VIEW_TYPE, diffColumnBesideAnswers } from "./tab-columns";
import { GuideContentProvider, GUIDE_SCHEME, baseUri, guideSideOf, headPathOf, headUri } from "./uris";
import { WebviewHost, webviewHtml, webviewOptions, type WebviewHandlers, type WebviewMode } from "./webview-host";
import { pullRequestWorktreeInUse, removeDraftWorktree, type WorktreeUsers } from "../worktrees";

interface Log {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface GuidesHostBridge {
  treeView: vscode.TreeView<TreeNode>;
  fireTreeChanged(element?: TreeNode): void;
}

interface PanelEntry {
  panel: vscode.WebviewPanel;
  host: WebviewHost;
}

interface RunEntry {
  gen: GuideGeneration;
  background: boolean;
  panel: PanelEntry | null;
  running: Promise<void> | null;
}

/** The models and efforts an agent listed, cached per agent. */
const optionsKey = (agentId: string) => `plannotator.guides.agentOptions.${agentId}`;
const DEFAULTS_KEY = "plannotator.guides.defaults";
const APPROVE_RUN_BUTTON = "Approve all for this run";
const OPTIONS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export class GuidesController implements vscode.Disposable {
  /** `gh` is the `plannotator.guides.ghPath` setting when set (VS Code's PATH may not have it). */
  private readonly runner: Runner = (command, args, options) => {
    const ghPath = command === "gh" ? vscode.workspace.getConfiguration("plannotator.guides").get<string>("ghPath")?.trim() : "";
    return defaultRunner(ghPath || command, args, options);
  };
  /** The absolute path of `gh` (the setting, else on PATH), for the credential helper a storage clone gets. */
  private ghPath(): string | null {
    const set = vscode.workspace.getConfiguration("plannotator.guides").get<string>("ghPath")?.trim();
    return findExecutable(set || "gh");
  }
  private readonly disposables: vscode.Disposable[] = [];
  private dashboard: DashboardModel | null = null;
  private loading: Promise<void> | null = null;
  private relay: Promise<RelayHost> | null = null;
  private run: RunEntry | null = null;
  private home: PanelEntry | null = null;
  private readonly guidePanels = new Map<string, PanelEntry>();
  private readonly draftPanels = new Map<string, PanelEntry>();
  private chapterView: { view: vscode.WebviewView; host: WebviewHost } | null = null;
  private reader: { model: ReaderModel; sides: ReaderSides } | null = null;
  private currentFile: string | null = null;
  /** Guides made while guide history is off: kept in memory for this session only. */
  private readonly sessionGuides = new Map<string, LoadedGuide>();
  private readonly ui: ReaderUi;
  private readonly asks: GuideAsks;
  private readonly version: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Log,
    private readonly bridge: GuidesHostBridge,
  ) {
    this.version = String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? "dev");
    this.ui = new ReaderUi({ current: () => this.reader });
    this.asks = new GuideAsks({
      context,
      version: this.version,
      runner: this.runner,
      log: (line) => this.log.info(line),
      reader: () => this.reader,
      openGuide: (id) => this.openGuide(id),
      openLink: (href, column) => this.openLink(href, "open", column),
      relayHost: () => this.relayHost(),
      agentById: (id) => this.agentById(id),
      defaultChoice: () => {
        const d = this.context.globalState.get<RememberedChoice>(DEFAULTS_KEY);
        const agent = this.agentById(d?.agent ?? CLAUDE_CODE.id) ?? CLAUDE_CODE;
        return { id: agent.id, label: agent.label };
      },
      ensureLaunch: (agent) => this.ensureLaunch(agent),
      pickModel: async (current) => {
        const picked = await pickAgentAndEffort({ ...this.pickerInput({ agent: current.id, model: current.model?.id, effort: current.effort?.id }), standingInstructions: "", defaultsOnly: true, title: "Who answers questions about this guide", purpose: "answer" });
        return picked?.agent ?? null;
      },
      notifyPermission: (pending, signal, label) => this.notifyPermission(pending, signal, label),
      autoApprove: () => this.autoApproveSetting(),
      approveAlways: () => void vscode.workspace.getConfiguration("plannotator.guides").update("autoApprove", "allow-all", vscode.ConfigurationTarget.Global),
      signIn: (agentId, logins, label, cwd) => this.signIn(label, { agentId, logins, cwd }),
      createPanel: (title, column, onLink, preserveFocus) => this.createPanel(ANSWER_VIEW_TYPE, title, "answer", column, preserveFocus ?? false, { onLink: (link) => onLink(link) }),
      persists: (guide) => guideHistoryEnabled() && !this.sessionGuides.has(guide.id),
      updateChapterView: () => this.updateChapterView(),
      setAnswering: (text, answerId) => this.ui.setAnswering(text, answerId),
    });
    this.disposables.push(
      this.ui,
      this.asks,
      vscode.workspace.registerTextDocumentContentProvider(GUIDE_SCHEME, new GuideContentProvider(this.runner)),
      bridge.treeView.onDidChangeCheckboxState((e) => this.onCheckboxes(e)),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.onActiveEditor(editor)),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.updateEditorContext(editor)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
    );
    void this.refresh();
  }

  // -------------------------------------------------------------------------
  // Tree
  // -------------------------------------------------------------------------

  private treeData(): TreeData {
    return {
      dashboard: this.dashboard,
      loading: !!this.loading,
      generation: this.run?.gen.state ?? null,
      reader: this.reader?.model ?? null,
      readerLabel: this.readerLabel(),
      currentFile: this.currentFile,
    };
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return getChildren(this.treeData(), node);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return getTreeItem(this.treeData(), node);
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return getParent(this.treeData(), node);
  }

  private fireTree(): void {
    this.bridge.fireTreeChanged();
  }

  private readerLabel(): string {
    const env = this.reader?.model.loaded.envelope;
    return env ? env.label || "local" : "";
  }

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  private cwd(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  async refresh(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      this.fireTree();
      try {
        this.dashboard = withSessionGuides(await loadDashboard(this.runner, this.cwd()), [...this.sessionGuides.values()], guideHistoryEnabled());
      } catch (err) {
        this.log.error(`[guides] dashboard: ${err instanceof Error ? err.stack ?? err.message : err}`);
      } finally {
        this.loading = null;
      }
      this.fireTree();
      this.updateHome();
    })();
    return this.loading;
  }

  private homeState(): HomeViewState {
    const d = this.dashboard;
    const defaults = this.context.globalState.get<RememberedChoice>(DEFAULTS_KEY);
    const agent = this.agentById(defaults?.agent ?? CLAUDE_CODE.id) ?? CLAUDE_CODE;
    const options = this.agentOptions(agent.id);
    const isClaude = agent.id === CLAUDE_CODE.id;
    const modelName = options?.model?.options.find((o) => o.value === defaults?.model)?.name ?? (defaults?.model ? defaults.model : isClaude ? "Sonnet" : "its default model");
    const effortName = options?.effort?.options.find((o) => o.value === defaults?.effort)?.name ?? (defaults?.effort ? defaults.effort : isClaude ? "low effort" : "default effort");
    const ghNote = !d ? null : d.gh.state === "missing" ? "Install the GitHub CLI (gh) to see pull requests." : d.gh.state === "signed-out" ? "Run `gh auth login` to see pull requests." : d.gh.state === "error" ? "gh did not answer." : null;
    return {
      mode: "home",
      repo: d?.repo ? { name: d.repo.displayName, branch: d.repo.branch, host: d.repo.github ? "GitHub" : "local repository" } : null,
      defaults: { agent: agent.label, model: modelName, effort: /effort/.test(effortName) ? effortName : `${effortName.toLowerCase()} effort` },
      ghNote,
      cards: {
        pr: d && d.gh.state === "ok" && d.repo?.github
          ? { open: d.prs.length, waiting: d.prs.filter((p) => p.reviewRequested).length, current: d.currentBranchPR ? { number: d.currentBranchPR.number, title: d.currentBranchPR.title } : null }
          : null,
        local: d?.local ? { files: d.local.files, additions: d.local.additions, deletions: d.local.deletions, baseLabel: d.local.baseLabel } : null,
      },
      recent: (d?.recent ?? []).map((r) => ({
        kind: r.kind,
        id: r.id,
        title: r.title,
        sub: [r.repoName ?? d?.repo?.displayName.split("/").pop(), r.label].filter(Boolean).join(" · "),
        progress: r.kind === "guide" && r.progress && !r.moved ? r.progress : null,
        note: r.sessionOnly ? "not saved: this session only" : r.moved ? "head moved since the guide" : r.kind === "draft" ? `Draft · ${r.draftInfo?.chapters ?? 0} chapters · ${r.draftInfo?.filesLeft ?? 0} files left` : null,
        warn: !!r.moved,
        when: relativeTime(r.at),
      })),
      waiting: (d?.waiting ?? []).map((w) => ({
        url: w.url,
        number: w.number,
        title: w.title,
        sub: `${w.repo} · @${w.author}`,
        inThisRepo: (() => {
          const ref = parsePullRequestUrl(w.url);
          return !!ref && isOpenRepository(d?.repo, ref);
        })(),
      })),
      notes: d?.notes ?? [],
    };
  }

  private updateHome(): void {
    this.home?.host.show(this.homeState());
  }

  /**
   * The Guided Reviews dashboard tab. `auto`: opened because the view was
   * shown from the activity bar, so it stays away when a dashboard, guide or
   * run tab is already open (the extension asks at most once per session).
   */
  openHome(auto = false): void {
    if (auto && (this.home || this.guidePanels.size > 0 || this.draftPanels.size > 0 || this.run?.panel)) return;
    if (this.home) {
      this.home.panel.reveal();
      this.updateHome();
      return;
    }
    const entry = this.createPanel("plannotator.guides.home", "Guided Reviews", "home");
    this.home = entry;
    entry.panel.onDidDispose(() => (this.home = null));
    entry.host.show(this.homeState());
  }

  private createPanel(viewType: string, title: string, mode: WebviewMode, column: vscode.ViewColumn = vscode.ViewColumn.Active, preserveFocus = false, handlers: Partial<WebviewHandlers> = {}): PanelEntry {
    const panel = vscode.window.createWebviewPanel(viewType, title, { viewColumn: column, preserveFocus }, { ...webviewOptions(this.context.extensionUri), retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "images", "guides.svg");
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri, mode);
    const host = new WebviewHost(panel.webview, {
      onCommand: (command, args) => void this.webviewCommand(command, args),
      onLink: (link, action) => void this.openLink(link, action),
      onLinkInfo: (link) => this.linkInfo(link),
      ...handlers,
    });
    panel.onDidDispose(() => host.dispose());
    return { panel, host };
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async runCommand(id: string, args: unknown[]): Promise<unknown> {
    const name = id.replace(/^plannotator\.guides\./, "");
    try {
      return await this.dispatch(name, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`[guides] ${id}: ${err instanceof Error ? err.stack ?? err.message : err}`);
      void vscode.window.showErrorMessage(`Guided Reviews: ${message}`);
      return undefined;
    }
  }

  private async webviewCommand(command: string, args: unknown[]): Promise<void> {
    const map: Record<string, string> = {
      guideLocal: "guideLocal",
      guidePullRequest: "guidePullRequest",
      guideCurrentPR: "guidePullRequest",
      newReview: "newReview",
      openGuide: "openGuide",
      resumeDraft: "resumeDraft",
      saveDraftAsIs: "saveDraftAsIs",
      deleteDraft: "deleteDraft",
      cancel: "cancelGeneration",
      runInBackground: "runInBackground",
      openLocation: "openLocation",
      openChapter: "openChapter",
      markChapterReviewed: "markChapterReviewed",
      nextChapter: "nextChapter",
      openFile: "openFile",
      changeDefaults: "changeDefaults",
      openExternal: "openPullRequestOnGitHub",
      openPullRequest: "openPullRequest",
      openFolder: "openFolder",
      refresh: "refresh",
      exportGuide: "exportGuide",
      signIn: "signIn",
      answerPermission: "answerPermission",
      approveRun: "approveRun",
      approveAlways: "approveAlways",
      resumeWithApproval: "resumeWithApproval",
      ask: "askChapter",
      openAnswer: "openAnswer",
      followUp: "followUp",
      stopAnswer: "stopAnswer",
      answerMenu: "answerMenu",
      openAnswerExternal: "openAnswerExternal",
    };
    if (command === "guideCurrentPR" && this.dashboard?.currentBranchPR) args = [this.dashboard.currentBranchPR.number];
    const target = map[command];
    if (target) await this.runCommand(`plannotator.guides.${target}`, args);
  }

  private async dispatch(name: string, args: unknown[]): Promise<unknown> {
    const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    switch (name) {
      case "refresh":
        return this.refresh();
      case "openHome":
        return this.openHome(!!args[0] && typeof args[0] === "object" && (args[0] as { auto?: unknown }).auto === true);
      case "newReview":
        return this.newReview();
      case "guideLocal":
        return this.newReview({ kind: "local", mode: "since-base" });
      case "guidePullRequest": {
        const target = this.pullRequestTarget(args[0]);
        if (target) return this.newReview(target);
        await this.ensureDashboard();
        const choice = this.dashboard?.repo ? await pickPullRequest(this.dashboard) : await pickPullRequestByLink();
        return choice ? this.newReview(choice) : undefined;
      }
      case "openPullRequest": {
        const target = this.pullRequestTarget(args[0]);
        return target ? this.openPullRequest(target) : this.dispatch("guidePullRequest", []);
      }
      case "openFolder":
        return vscode.commands.executeCommand("workbench.action.files.openFolder");
      case "openGuide":
        return this.openGuide(str(args[0]));
      case "closeGuide":
        return this.closeGuide();
      case "showGeneration":
        return this.showGeneration(str(args[0]));
      case "resumeDraft":
        return this.resumeDraft(str(args[0]) ?? treeArg(args[0]));
      case "saveDraftAsIs":
        return this.saveDraftAsIs(str(args[0]) ?? treeArg(args[0]));
      case "deleteDraft":
        return this.deleteDraft(str(args[0]) ?? treeArg(args[0]));
      case "deleteGuide":
        return this.deleteGuide(str(args[0]) ?? treeArg(args[0]));
      case "exportGuide":
        return this.exportGuide(str(args[0]) ?? treeArg(args[0]));
      case "cancelGeneration":
        return this.run?.gen.cancel();
      case "runInBackground":
        return this.runInBackground();
      case "openLocation":
        return this.openLocation(str(args[0]), num(args[1]));
      case "openChapter":
        return this.openChapter(num(args[0]) ?? (args[0] && typeof args[0] === "object" && "index" in (args[0] as object) ? (args[0] as { index: number }).index + 1 : undefined), args[1] as { openFile?: boolean } | undefined);
      case "nextChapter":
        return this.nextChapter();
      case "markChapterReviewed":
        return this.markChapterReviewed(num(args[0]) ?? (this.reader ? this.reader.model.currentChapter + 1 : undefined), typeof args[1] === "boolean" ? args[1] : undefined);
      case "openFile":
        return this.openFile(str(args[0]) ?? (args[0] && typeof args[0] === "object" && "path" in (args[0] as object) ? (args[0] as { path: string }).path : undefined));
      case "nextFile":
        return this.nextFile(str(args[0]) ?? this.currentFile ?? undefined);
      case "toggleFileReviewed":
        return this.toggleFileReviewed(str(args[0]) ?? (args[0] && typeof args[0] === "object" && "path" in (args[0] as object) ? (args[0] as { path: string }).path : undefined));
      case "changeDefaults":
        return this.changeDefaults();
      case "updateAdapters":
        return this.updateAdapters();
      case "signIn":
        return this.signIn(str(args[0]));
      case "answerPermission": {
        // (run id, permission id, option id): a guide run, or a question being answered
        const gen = this.run?.gen;
        const id = num(args[1]);
        const optionId = str(args[2]);
        if (this.asks.answerPermission(str(args[0]), id, optionId)) return;
        if (gen && gen.state.id === str(args[0]) && id !== undefined && optionId) gen.answerPermission(id, { optionId });
        return;
      }
      case "approveRun":
        if (this.asks.approveRun(str(args[0]))) return;
        if (this.run && this.run.gen.state.id === str(args[0])) this.run.gen.approveAutomatically();
        return;
      case "approveAlways": {
        // (run id, permission id). The setting is written only for a request that is really
        // waiting on the user: a forged command (no such run or request) changes nothing.
        const runId = str(args[0]);
        const permissionId = num(args[1]);
        const gen = this.run?.gen;
        const target = approveAlwaysTarget(runId, permissionId, {
          generation: gen ? { id: gen.state.id, live: isLive(gen.state), pending: gen.state.pendingPermissions.map((p) => p.id) } : null,
          askPending: (run, id) => this.asks.hasPendingPermission(run, id),
        });
        if (!target) {
          this.log.warn(`[guides] approveAlways ignored: no request ${permissionId ?? "?"} is waiting in run ${runId ?? "?"}`);
          return;
        }
        await vscode.workspace.getConfiguration("plannotator.guides").update("autoApprove", "allow-all", vscode.ConfigurationTarget.Global);
        if (target === "ask") this.asks.approveRun(runId);
        else gen!.approveAutomatically();
        return;
      }
      case "askAboutSelection":
        return this.asks.askAboutSelection();
      case "askAboutFile":
        return this.asks.askAboutFile(str(args[0]) ?? (args[0] && typeof args[0] === "object" && "path" in (args[0] as object) ? (args[0] as { path: string }).path : undefined));
      case "askThreadSubmit":
        return this.asks.threads.submit(args[0]);
      case "askThreadCancel":
      case "askThreadClose":
        return this.asks.threads.close(args[0]);
      case "askThreadSettings":
        return this.asks.threads.settings(args[0]);
      case "askThreadPick":
        return this.asks.threads.pick(args[0], args[1]);
      case "askThreadAgain":
        return this.asks.threads.again(args[0]);
      case "askThreadStop":
        return this.asks.threads.stop(args[0]);
      case "askChapter":
        return this.asks.askChapter(num(args[0]), str(args[1]));
      case "openAnswer":
        return this.asks.openAnswer(str(args[0]));
      case "followUp":
        return this.asks.followUp(str(args[0]), str(args[1]));
      case "stopAnswer":
        return this.asks.stop(str(args[0]));
      case "answerMenu":
        return this.asks.menu(str(args[0]), str(args[1]));
      case "openAnswerExternal":
        return this.asks.openExternal(str(args[1]));
      case "resumeWithApproval":
        return this.resumeDraft(str(args[0]) ?? treeArg(args[0]), true);
      case "openPullRequestOnGitHub": {
        // A tree row passes its node (the extension's own data); a webview passes a string,
        // which opens without asking only when it is a pull request the extension knows.
        const fromNode = args[0] && typeof args[0] === "object" ? ((args[0] as { pr?: { url: string }; row?: { url: string } }).pr?.url ?? (args[0] as { row?: { url: string } }).row?.url) : undefined;
        const target = fromNode ?? str(args[0]);
        if (!target || !/^https:\/\//.test(target)) return;
        if (!fromNode && !isKnownPullRequestUrl(target, this.knownPullRequestUrls())) {
          const choice = await vscode.window.showInformationMessage(`Open ${target} in your browser?`, "Open");
          if (choice !== "Open") return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(target));
        return;
      }
      default:
        this.log.warn(`[guides] unknown command ${name}`);
        return undefined;
    }
  }

  /** Pull requests the extension itself knows: the dashboard's, the open guide's and the run's. */
  private knownPullRequestUrls(): string[] {
    const d = this.dashboard;
    const env = this.reader?.model.loaded.envelope;
    return [
      ...(d?.prs.map((p) => p.url) ?? []),
      ...(d?.waiting.map((w) => w.url) ?? []),
      d?.currentBranchPR?.url,
      env?.prUrl,
      env?.review?.source.pr?.url,
      this.reader?.model.loaded.sidecar.source?.pr?.url,
      this.run?.gen.state.source.pr?.url,
    ].filter((u): u is string => !!u);
  }

  /**
   * A pull request named by a tree row, a dashboard row, a number (this
   * repository) or a link: as a source choice, with `repo` when it belongs to
   * another repository than the one open.
   */
  private pullRequestTarget(arg: unknown): Extract<SourceChoice, { kind: "pr" }> | null {
    const open = this.dashboard?.repo ?? null;
    const fromUrl = (url: string, number?: number): Extract<SourceChoice, { kind: "pr" }> | null => {
      const ref = parsePullRequestUrl(url);
      if (!ref) return number !== undefined && open ? { kind: "pr", number } : null;
      const ghRepo = ghRepoArg(ref);
      return isOpenRepository(open, ref) ? { kind: "pr", number: ref.number } : { kind: "pr", number: ref.number, repo: ghRepo };
    };
    if (typeof arg === "number") return open ? { kind: "pr", number: arg } : null;
    if (typeof arg === "string") return /^\d+$/.test(arg) ? (open ? { kind: "pr", number: Number(arg) } : null) : fromUrl(arg);
    if (!arg || typeof arg !== "object") return null;
    const node = arg as TreeNode | { number?: unknown; url?: unknown };
    if ("kind" in node && node.kind === "pr") return { kind: "pr", number: node.pr.number };
    if ("kind" in node && node.kind === "waiting") return fromUrl(node.row.url, node.row.number);
    const n = typeof (node as { number?: unknown }).number === "number" ? ((node as { number: number }).number) : undefined;
    const url = typeof (node as { url?: unknown }).url === "string" ? ((node as { url: string }).url) : undefined;
    return url ? fromUrl(url, n) : n !== undefined && open ? { kind: "pr", number: n } : null;
  }

  /**
   * Clicking a pull request: open its guide when one was made at the PR's
   * current head, show the run when one is building it, else start a new
   * guided review of it. Never the browser ("Open on GitHub" does that).
   */
  private async openPullRequest(target: Extract<SourceChoice, { kind: "pr" }>): Promise<void> {
    const open = this.dashboard?.repo ?? null;
    const repoKey = target.repo ? repoKeyForGhRepo(target.repo) : open?.repoKey;

    const live = this.run && isLive(this.run.gen.state) ? this.run.gen.state : null;
    if (live && live.repoKey === repoKey && live.source.pr?.number === target.number) return this.showGeneration(live.id);
    if (repoKey) {
      const known = !target.repo ? this.dashboard?.prs.find((p) => p.number === target.number)?.headRefOid : undefined;
      // The open repository's PR is asked in its own folder (gh reads its remotes, SSH host aliases included).
      const head = known || (target.repo ? await pullRequestHead(this.runner, target.repo, target.number) : open ? await pullRequestHead(this.runner, null, target.number, open.root) : null);
      const id = guideForPullRequest(repoKey, target.number, head);
      if (id) return this.openGuide(id);
    }
    return this.newReview(target);
  }

  private async ensureDashboard(): Promise<void> {
    if (!this.dashboard) await this.refresh();
  }

  // -------------------------------------------------------------------------
  // Agent options (models and efforts), cached per agent
  // -------------------------------------------------------------------------

  private agentOptions(agentId: string): AgentOptionsCache | null {
    const cached = this.context.globalState.get<AgentOptionsCache>(optionsKey(agentId));
    return cached && Date.now() - cached.fetchedAt < OPTIONS_MAX_AGE_MS ? cached : null;
  }

  /**
   * The command override for a known agent: `plannotator.guides.agentCommands`
   * (`{ "<id>": { "command": "…", "args": [] } }`), else for Claude Code the
   * older `plannotator.guides.claudeCode.command` / `.args`.
   */
  private agentOverride(agentId: string): CommandOverride {
    const cfg = vscode.workspace.getConfiguration("plannotator.guides");
    const map = cfg.get<Record<string, { command?: unknown; args?: unknown }>>("agentCommands") ?? {};
    const entry = map[agentId];
    if (entry && typeof entry.command === "string" && entry.command.trim()) {
      return { command: entry.command, args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : undefined };
    }
    if (agentId === CLAUDE_CODE.id) {
      const claude = vscode.workspace.getConfiguration("plannotator.guides.claudeCode");
      return { command: claude.get<string>("command") ?? "", args: claude.get<string[]>("args") ?? [] };
    }
    return {};
  }

  /** The custom agent (`plannotator.guides.customAgent.*`), when a command is set. */
  private customAgent(): AgentDescriptor | null {
    const cfg = vscode.workspace.getConfiguration("plannotator.guides.customAgent");
    return customAgent({ command: cfg.get<string>("command") ?? "", args: cfg.get<string[]>("args") ?? [], label: cfg.get<string>("label") ?? "" });
  }

  private agentById(agentId: string): AgentDescriptor | null {
    return findAgent(agentId, this.customAgent());
  }

  private agentStatuses(): AgentStatus[] {
    return detectAgents((id) => this.agentOverride(id), this.customAgent(), findExecutable, this.managedFor, this.installAdaptersSetting());
  }

  /** Resolution order: the command in settings, the agent on PATH, the adapter Guided Reviews installed. */
  private launchFor(agent: AgentDescriptor): AdapterResolution {
    return resolveGuidesLaunch(agent, agent.id === CUSTOM_AGENT_ID ? {} : this.agentOverride(agent.id), findExecutable, this.managedFor, process.platform, isSameProgram, {
      useInstalled: vscode.workspace.getConfiguration("plannotator.guides").get<boolean>("useInstalledCli") ?? true,
    });
  }

  private readonly managedFor = (agent: AgentDescriptor) => (agent.adapter ? managedLaunch(this.adaptersRoot(), agent.id, agent.adapter, agent.args) : null);

  private adaptersRoot(): string {
    return adaptersRoot(this.context.globalStorageUri.fsPath);
  }

  /** `plannotator.guides.installAdapters` (default on): install a missing npm ACP adapter into the extension's storage. */
  private installAdaptersSetting(): boolean {
    return vscode.workspace.getConfiguration("plannotator.guides").get<boolean>("installAdapters") ?? true;
  }

  private readonly adapterInstalls = new Map<string, Promise<InstallResult>>();

  /** Install (or reinstall) the agent's pinned adapter, with a progress notification. One install per agent at a time. */
  private installAdapterNow(agent: AgentDescriptor): Promise<InstallResult> {
    const spec = agent.adapter;
    if (!spec) return Promise.resolve({ ok: false, message: `${agent.label} has no ACP adapter to install.` });
    const running = this.adapterInstalls.get(agent.id);
    if (running) return running;
    const job = Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${agent.label}'s ACP adapter…` }, async (progress) => {
        progress.report({ message: `${spec.package}@${spec.version}` });
        const result = await installAdapter(this.adaptersRoot(), agent.id, agent.label, spec, { runner: this.runner });
        this.log.info(result.ok ? `[guides] installed ${spec.package}@${spec.version} in ${result.dir}` : `[guides] ${result.message}`);
        return result;
      }),
    ).finally(() => this.adapterInstalls.delete(agent.id));
    this.adapterInstalls.set(agent.id, job);
    return job;
  }

  /**
   * The command to start the agent, installing its adapter first when it is
   * missing and the setting allows. When the agent cannot be started, says
   * why (with Retry for a failed install, or how to install the agent) and
   * answers null. Which copy of Claude Code or Codex the adapter runs (the
   * user's CLI, or the one that comes with the adapter) goes to the log on
   * each launch, never to a notification.
   */
  private async ensureLaunch(agent: AgentDescriptor): Promise<ReadyLaunch | null> {
    const launch = await this.resolveReadyLaunch(agent);
    if (launch?.cliLog) this.log.info(`[guides] ${launch.cliLog}`);
    return launch;
  }

  private resolveReadyLaunch(agent: AgentDescriptor): Promise<ReadyLaunch | null> {
    return ensureAgentLaunch(agent, {
      resolve: (a) => this.launchFor(a),
      installAdapters: this.installAdaptersSetting(),
      install: (a) => this.installAdapterNow(a),
      installFailed: async (a, message) => {
        const choice = await vscode.window.showErrorMessage(message, "Retry", "Copy command", "Open docs");
        if (choice === "Copy command") void vscode.env.clipboard.writeText(a.installCommand);
        if (choice === "Open docs") void vscode.env.openExternal(vscode.Uri.parse(a.docsUrl));
        return choice === "Retry" ? "retry" : "stop";
      },
      missing: async (a, launch) => {
        const now = await this.showMissing({ agent: a, launch });
        return now?.launch.ok ? now.launch : null;
      },
    });
  }

  /** "Guided Reviews: Update Agent Adapters": reinstall every adapter Guided Reviews installed, at the pinned version. */
  private async updateAdapters(): Promise<void> {
    const root = this.adaptersRoot();
    const agents = KNOWN_AGENTS.filter((a) => a.adapter && hasManagedCopy(root, a.id));
    if (agents.length === 0) {
      void vscode.window.showInformationMessage("Guided Reviews has not installed any agent adapter yet. It installs one when a guide starts with an agent that needs it.");
      return;
    }
    const done: string[] = [];
    for (const agent of agents) {
      const result = await this.installAdapterNow(agent);
      if (!result.ok) {
        const choice = await vscode.window.showErrorMessage(result.message, "Retry");
        if (choice === "Retry") return this.updateAdapters();
        continue;
      }
      done.push(`${agent.label} (${agent.adapter!.package}@${agent.adapter!.version})`);
    }
    if (done.length) void vscode.window.showInformationMessage(`Updated the ACP adapters for ${done.join(", ")}.`);
  }

  /** `plannotator.guides.autoApprove`: the user opted in to approving the agent's requests automatically during guides. */
  private autoApproveSetting(): boolean {
    return vscode.workspace.getConfiguration("plannotator.guides").get<string>("autoApprove") === "allow-all";
  }

  /** Start the agent once, read its config options, stop it. Nothing is prompted. */
  private async probeAgentOptions(agent: AgentDescriptor): Promise<AgentOptionsCache | null> {
    const launch = await this.ensureLaunch(agent);
    if (!launch) return null;
    const cwd = this.dashboard?.repo?.root ?? this.cwd() ?? this.context.globalStorageUri.fsPath;
    mkdirSync(cwd, { recursive: true });
    let client: AcpClient | null = null;
    try {
      client = await AcpClient.start(agentLaunchFor(launch, cwd), {
        onUpdate: () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        onStderr: (t) => this.log.info(`[agent] ${t.trimEnd()}`),
      }, { name: "plannotator-vscode", title: "Plannotator", version: this.version });
      const session = await Promise.race([
        client.newSession(cwd, []),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${agent.label} did not answer within 60 seconds.`)), 60_000)),
      ]);
      const options = readAgentOptions(agent.id, session.configOptions);
      await this.context.globalState.update(optionsKey(agent.id), options);
      return options;
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not read ${agent.label}'s models: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      client?.dispose();
    }
  }

  /**
   * Why the agent cannot start, with what fixes it: install its adapter now
   * (when auto-install is off), "Install <agent>" (a terminal with the
   * agent's official install command typed in, for the user to run), its
   * docs, or settings. Answers the agent's new status when its adapter was
   * installed here, else null.
   */
  private async showMissing(status: AgentStatus): Promise<AgentStatus | null> {
    const { agent, launch } = status;
    if (launch.ok) return status;
    // The command for this platform (on Windows the documented PowerShell one); none: the docs instead.
    const installCmd = launch.reason === "agent" ? installCommandFor(agent.installCommand, agent.installCommandWindows) : launch.reason === "requires" && agent.requires ? installCommandFor(agent.requires.installCommand, undefined) : null;
    const installAgent = installCmd ? (launch.reason === "requires" && agent.requires ? `Install ${agent.requires.label}` : `Install ${agent.label}`) : null;
    const buttons = [
      ...(launch.reason === "adapter" ? ["Install adapter", "Copy command"] : []),
      ...(installAgent ? [installAgent] : []),
      "Open docs",
      ...(launch.reason === "setting" || launch.reason === "adapter" ? ["Open settings"] : []),
    ];
    const choice = await vscode.window.showErrorMessage(launch.message, ...buttons);
    if (choice === "Install adapter") {
      const result = await this.installAdapterNow(agent);
      if (!result.ok) {
        const again = await vscode.window.showErrorMessage(result.message, "Retry");
        return again === "Retry" ? this.showMissing({ agent, launch: this.launchFor(agent) }) : null;
      }
      const now = this.launchFor(agent);
      return now.ok ? { agent, launch: now } : null;
    }
    if (choice === "Copy command") void vscode.env.clipboard.writeText(agent.installCommand);
    if (choice && choice === installAgent) {
      const terminal = vscode.window.createTerminal({ name: choice });
      terminal.show();
      // Typed in, not run: the user reads it and presses Enter.
      terminal.sendText(installCmd!, false);
    }
    if (choice === "Open docs") void vscode.env.openExternal(vscode.Uri.parse(launch.reason === "requires" && agent.requires ? agent.requires.docsUrl : agent.docsUrl));
    if (choice === "Open settings") {
      const key = agent.id === CUSTOM_AGENT_ID ? "plannotator.guides.customAgent" : launch.reason === "adapter" ? "plannotator.guides.installAdapters" : "plannotator.guides.agentCommands";
      void vscode.commands.executeCommand("workbench.action.openSettings", key);
    }
    return null;
  }

  private pickerInput(remembered: RememberedChoice | undefined) {
    return {
      agents: this.agentStatuses(),
      optionsFor: (id: string) => this.agentOptions(id),
      loadOptions: (agent: AgentDescriptor) => this.probeAgentOptions(agent),
      onMissing: (status: AgentStatus) => this.showMissing(status),
      installAdapters: this.installAdaptersSetting(),
      remembered: remembered ? { agent: remembered.agent ?? CLAUDE_CODE.id, model: remembered.model, effort: remembered.effort } : undefined,
    };
  }

  private async changeDefaults(): Promise<void> {
    const defaults = this.context.globalState.get<RememberedChoice>(DEFAULTS_KEY);
    const picked = await pickAgentAndEffort({ ...this.pickerInput(defaults), standingInstructions: "", defaultsOnly: true });
    if (!picked) return;
    await this.context.globalState.update(DEFAULTS_KEY, { agent: picked.agent.id, model: picked.agent.model?.id, effort: picked.agent.effort?.id });
    this.updateHome();
  }

  // -------------------------------------------------------------------------
  // Starting a review
  // -------------------------------------------------------------------------

  private async newReview(preset?: SourceChoice): Promise<void> {
    if (this.run && isLive(this.run.gen.state)) {
      const choice = await vscode.window.showWarningMessage("A guide is being built. Show it?", "Show");
      if (choice) this.showGeneration(this.run.gen.state.id);
      return;
    }
    await this.ensureDashboard();
    const model = this.dashboard;
    // With no repository open, only a pull request (by link) can be guided: from a clone in the extension's storage.
    const source = preset ?? (model ? await pickSource(model) : await pickPullRequestByLink());
    if (!source) return;
    if (!model?.repo && !(source.kind === "pr" && source.repo)) {
      void vscode.window.showWarningMessage("Open a folder that is a git repository, or paste a pull request link, to start a guided review.");
      return;
    }
    const choicesKey = model?.repo ? `plannotator.guides.choices:${model.repo.root}` : null;
    const remembered = (choicesKey && this.context.workspaceState.get<RememberedChoice>(choicesKey)) || this.context.globalState.get<RememberedChoice>(DEFAULTS_KEY);
    const picked = await pickAgentAndEffort({ ...this.pickerInput(remembered), standingInstructions: readGuideInstructions(), autoApprove: this.autoApproveSetting() });
    if (!picked) return;
    if (choicesKey) await this.context.workspaceState.update(choicesKey, { agent: picked.agent.id, model: picked.agent.model?.id, effort: picked.agent.effort?.id });
    // The start flow's toggle (seeded from the setting) decides, for this run.
    await this.startRun(source, picked.agent, picked.instructions, undefined, autoApproveChoice(picked));
  }

  private async prepareSource(choice: SourceChoice): Promise<{ source: ReviewSourceRecord; rawPatch: string; repoKey: string } | null> {
    if (choice.kind === "pr" && choice.repo) return this.prepareOtherRepoPullRequest(choice.number, choice.repo);
    const repo = this.dashboard?.repo ?? (this.cwd() ? await getRepoInfo(this.runner, this.cwd()!) : null);
    if (!repo) throw new Error("No git repository is open.");
    if (choice.kind === "local") {
      const patch = await buildLocalChangesPatch(this.runner, repo, choice.mode as LocalChangesMode);
      if (patch.files.length === 0) {
        void vscode.window.showInformationMessage(choice.mode === "uncommitted" ? "There are no uncommitted changes." : `There are no changes since ${patch.baseLabel}.`);
        return null;
      }
      return {
        rawPatch: patch.rawPatch,
        repoKey: repo.repoKey,
        source: {
          kind: "local",
          repoRoot: repo.root,
          headRoot: repo.root,
          repoName: repo.displayName,
          label: choice.mode === "uncommitted" ? "Uncommitted changes" : "Local changes",
          branch: repo.branch,
          headSha: repo.headSha,
          baseSha: patch.baseSha,
          baseLabel: patch.baseLabel,
          workingTree: true,
        },
      };
    }
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Preparing PR #${choice.number}` }, async (progress) => {
      const pr = await viewPullRequest(this.runner, repo.root, choice.number);
      const storage = this.context.globalStorageUri.fsPath;
      mkdirSync(storage, { recursive: true });
      const wt = await preparePullRequestWorktree(this.runner, repo, pr, storage, (step) => progress.report({ message: step }));
      return {
        rawPatch: wt.rawPatch,
        repoKey: repo.repoKey,
        source: {
          kind: "pr",
          repoRoot: repo.root,
          headRoot: wt.path,
          repoName: repo.displayName,
          label: `PR #${pr.number}`,
          headSha: wt.headSha,
          baseSha: wt.mergeBase,
          baseLabel: pr.baseRefName,
          pr: { number: pr.number, url: pr.url, title: pr.title, author: pr.author },
          worktreePath: wt.path,
        },
      };
    });
  }

  /**
   * A pull request of a repository that is not open in VS Code: a blobless
   * clone of it in the extension's storage (made once, reused), then the
   * same per-PR worktree as any PR. When that cannot work (no gh, not signed
   * in, no access), says why in one line and how to fix it.
   */
  private async prepareOtherRepoPullRequest(number: number, ghRepo: string): Promise<{ source: ReviewSourceRecord; rawPatch: string; repoKey: string } | null> {
    const storage = this.context.globalStorageUri.fsPath;
    mkdirSync(storage, { recursive: true });
    try {
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Preparing ${ghRepo}#${number}` }, async (progress) => {
        const step = (m: string) => progress.report({ message: m });
        const repo = await ensureRepoClone(this.runner, ghRepo, storage, step, { ghPath: this.ghPath() });
        const pr = await viewPullRequest(this.runner, repo.root, number, ghRepo);
        const wt = await preparePullRequestWorktree(this.runner, repo, pr, storage, step);
        return {
          rawPatch: wt.rawPatch,
          repoKey: repo.repoKey,
          source: {
            kind: "pr" as const,
            repoRoot: repo.root,
            headRoot: wt.path,
            repoName: repo.displayName,
            label: `PR #${pr.number}`,
            headSha: wt.headSha,
            baseSha: wt.mergeBase,
            baseLabel: pr.baseRefName,
            pr: { number: pr.number, url: pr.url, title: pr.title, author: pr.author },
            worktreePath: wt.path,
          },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      const choice = await vscode.window.showErrorMessage(`Could not guide ${ghRepo}#${number}: ${message} Open the repository in VS Code and guide it from there, or check \`gh auth status\`.`, "Open a folder…", "Open on GitHub");
      if (choice === "Open a folder…") void vscode.commands.executeCommand("workbench.action.files.openFolder");
      if (choice === "Open on GitHub") {
        const ref = parseGhRepoArg(ghRepo);
        if (ref) void vscode.env.openExternal(vscode.Uri.parse(`https://${ref.host}/${ref.owner}/${ref.repo}/pull/${number}`));
      }
      return null;
    }
  }

  private relayHost(): Promise<RelayHost> {
    if (!this.relay) {
      this.relay = startRelayHost({ serverVersion: this.version, log: (l) => this.log.warn(l) });
      this.disposables.push({ dispose: () => void this.relay?.then((r) => r.close()) });
    }
    return this.relay;
  }

  private async startRun(choice: SourceChoice, agent: AgentChoiceRecord, instructions?: string, resume?: DraftRecord, autoApprove = this.autoApproveSetting()): Promise<void> {
    const descriptor = this.agentById(agent.id);
    if (!descriptor) {
      void vscode.window.showErrorMessage(agent.id === CUSTOM_AGENT_ID ? "This guide was started with the custom agent, which is no longer set (plannotator.guides.customAgent.command)." : `Plannotator does not know the agent ${agent.label}.`);
      return;
    }
    const available = await this.ensureLaunch(descriptor);
    if (!available) return;
    let prepared: { source: ReviewSourceRecord; rawPatch: string; repoKey?: string } | null;
    if (resume) prepared = { source: resume.source, rawPatch: resume.draft.review.rawPatch, repoKey: resume.repoKey };
    else prepared = await this.prepareSource(choice);
    if (!prepared) return;
    const launch = available;
    const repoKey = resume?.repoKey ?? prepared.repoKey ?? this.dashboard?.repo?.repoKey;
    if (!repoKey) throw new Error("No repository.");
    const relay = await this.relayHost();
    const files = changedFilesFromPatch(prepared.rawPatch);
    const gen = new GuideGeneration(
      { repoKey, source: prepared.source, rawPatch: prepared.rawPatch, files, agent, ...(instructions && { instructions }), ...(resume && { resume }), ...(autoApprove && { autoApprove: true }) },
      {
        relay,
        agent: descriptor,
        agentLaunch: (cwd) => agentLaunchFor(launch, cwd),
        mcpServer: {
          command: process.execPath,
          args: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "guide-mcp.cjs").fsPath],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        },
        clientInfo: { name: "plannotator-vscode", title: "Plannotator", version: this.version },
        requestPermission: (pending, signal) => this.notifyPermission(pending, signal, agent.label),
        approveAlways: () => void vscode.workspace.getConfiguration("plannotator.guides").update("autoApprove", "allow-all", vscode.ConfigurationTarget.Global),
        resolveSymbol: (name, path, f, headRoot) => resolveSymbolForBuilder(name, path, headRoot, f.map((x) => x.path)),
        checkMermaid: (source) => this.checkMermaid(source),
        log: (line) => this.log.info(line),
        history: guideHistoryEnabled(),
      },
    );
    const entry: RunEntry = { gen, background: false, panel: null, running: null };
    this.run = entry;
    this.draftPanels.get(gen.state.id)?.panel.dispose();
    this.showRunPanel(entry);
    void vscode.commands.executeCommand("setContext", "plannotator.guides.generating", true);
    let lastTree = 0;
    gen.onChange((state) => {
      entry.panel?.host.show(this.generatingState(state));
      this.updateBadge(state);
      const now = Date.now();
      if (now - lastTree > 400 || !isLive(state)) {
        lastTree = now;
        this.fireTree();
      }
    });
    entry.running = gen.run().then(() => this.onRunEnded(entry));
  }

  private async onRunEnded(entry: RunEntry): Promise<void> {
    const state = entry.gen.state;
    void vscode.commands.executeCommand("setContext", "plannotator.guides.generating", false);
    this.updateBadge(state);
    if (entry.gen.memoryGuide) this.sessionGuides.set(entry.gen.memoryGuide.id, entry.gen.memoryGuide);
    await this.refresh();
    if (state.status === "failed" && state.signIn) {
      void this.signIn();
      return;
    }
    if (state.status === "finished" && state.savedGuideId) {
      if (entry.background || !entry.panel) {
        const choice = await vscode.window.showInformationMessage(`Guide ready: ${state.draft.title || state.source.label}`, "Open guide");
        if (choice) await this.openGuide(state.savedGuideId);
      } else {
        entry.panel.panel.dispose();
        await this.openGuide(state.savedGuideId);
      }
      if (this.run === entry) this.run = null;
      this.fireTree();
      return;
    }
    if (entry.background && state.status !== "finished") {
      const choice = await vscode.window.showWarningMessage(`The guide for ${state.source.label} stopped: ${state.statusMessage ?? ""}`, "Show");
      if (choice) this.showRunPanel(entry);
    }
  }

  private showRunPanel(entry: RunEntry): void {
    if (entry.panel) {
      entry.panel.panel.reveal();
      return;
    }
    const p = this.createPanel("plannotator.guides.guide", "Guide", "generating");
    p.panel.title = `Guide · ${entry.gen.state.source.label}`;
    entry.panel = p;
    entry.background = false;
    p.panel.onDidDispose(() => {
      if (entry.panel === p) entry.panel = null;
      if (isLive(entry.gen.state)) entry.background = true;
    });
    p.host.show(this.generatingState(entry.gen.state));
  }

  private runInBackground(): void {
    const entry = this.run;
    if (!entry) return;
    entry.background = true;
    // Keep the tab (it renders the Mermaid check) but step away from it.
    void vscode.commands.executeCommand("workbench.action.navigateBack");
    void vscode.window.showInformationMessage(`Building the guide for ${entry.gen.state.source.label} in the background. You'll get a notification when it is ready.`);
  }

  private updateBadge(state: GenerationState): void {
    this.bridge.treeView.badge = isLive(state) ? { value: 1, tooltip: `Building a guide · ${state.progress.placed} of ${state.progress.total} files placed` } : undefined;
  }

  private generatingState(s: GenerationState): GeneratingViewState {
    const live = isLive(s);
    const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
    const source = s.source;
    return {
      mode: "generating",
      id: s.id,
      status: s.status,
      statusMessage: s.statusMessage ?? null,
      kicker: `${live ? "Building guided review" : s.status === "finished" ? "Guided review saved" : "Draft guided review"} · ${source.label}`,
      title: s.draft.title || (source.pr?.title ?? `${source.label} on ${source.branch ?? source.repoName}`),
      sub: source.kind === "pr" && source.pr ? `${source.pr.url.replace(/^https:\/\//, "")} · in a worktree at ${source.headSha.slice(0, 7)}` : `${source.repoName} · ${source.baseLabel}..working tree`,
      agent: s.agent.label,
      modelEffort: [s.appliedModel ?? s.agent.model?.label ?? "agent default", s.appliedEffort ?? s.agent.effort?.label].filter(Boolean).join(" · "),
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      cost: s.cost ? `$${s.cost.amount.toFixed(2)}` : null,
      activity: s.activity.map((a) => ({ id: a.id, at: fmt(a.at), kind: a.kind, title: a.title, ...(a.detail && { detail: a.detail }), ...(a.status && { status: a.status }), ...(a.isError && { isError: true }), ...(a.locations && { locations: a.locations }) })),
      chapters: s.draft.chapters.map((c, i) => ({
        n: i + 1,
        id: c.id,
        title: c.title,
        added: s.marks.added.includes(c.id),
        files: c.files.map((f) => ({ path: f.file, name: basename(f.file), movedFrom: s.marks.moved[f.file] ?? null })),
      })),
      unplaced: s.draft.unplaced.map((u) => basename(u.file)),
      left: [...s.progress.remaining],
      summary: s.progress.line,
      savedGuideId: s.savedGuideId ?? null,
      signIn: s.signIn ? (s.signIn.logins.length ? s.signIn.logins.map((l) => l.label) : ["Sign in"]) : null,
      memoryOnly: !!s.memoryOnly,
      pendingPermissions: (s.pendingPermissions ?? []).map((p) => ({ id: p.id, title: p.title, kind: p.kind ?? null, target: p.target ?? null, options: p.options })),
      approvals: { auto: !!s.autoApprove, mode: s.permissiveMode ?? null },
      offerAutoApprove: !!s.offerAutoApprove && !s.autoApprove,
      bottlenecks: (s.bottlenecks ?? []).map((b) => ({ key: b.key, title: b.title, detail: b.detail ?? null, action: b.action ?? null })),
    };
  }

  /**
   * A pending permission request, as a notification (it never blocks the
   * editor) with every option the agent offers plus "Approve all for this run".
   * The run view shows the same request with the same buttons; the first
   * answer wins. Dismissing the notification leaves it waiting in the run view.
   */
  private async notifyPermission(pending: PendingPermission, signal: AbortSignal, agentLabel: string): Promise<PermissionAnswer | null> {
    if (signal.aborted) return null;
    const message = `${agentLabel} asks to run: ${pending.title}${pending.target ? ` (${pending.target})` : ""}`;
    const buttons = [...pending.options.map((o) => o.name), APPROVE_RUN_BUTTON];
    const choice = await vscode.window.showInformationMessage(message, ...buttons);
    if (!choice || signal.aborted) return null;
    if (choice === APPROVE_RUN_BUTTON) return { approve: "run" };
    const option = pending.options.find((o) => o.name === choice);
    return option ? { optionId: option.optionId } : null;
  }

  /**
   * Sign in to the agent: a terminal running the agent's own login command
   * (the terminal sign-ins it listed in `initialize`), else `claude /login`.
   */
  private async signIn(label?: string, explicit?: { agentId: string; logins: LoginCommand[]; cwd: string }): Promise<void> {
    const state = this.run?.gen.state;
    const logins: LoginCommand[] = explicit?.logins ?? state?.signIn?.logins ?? [];
    const agent = (explicit ? this.agentById(explicit.agentId) : state && this.agentById(state.agent.id)) ?? CLAUDE_CODE;
    const launch = this.launchFor(agent);
    let choice = label;
    if (!choice) {
      const buttons = logins.length ? logins.map((l) => l.label) : ["Sign in"];
      choice = await vscode.window.showErrorMessage(`${agent.label} is not signed in. Sign in in a terminal, then resume the guide.`, ...buttons);
      if (!choice) return;
    }
    const login = logins.find((l) => l.label === choice) ?? (logins.length === 1 ? logins[0] : undefined);
    const plan = planSignIn(agent, launch, login);
    if (!plan.ok) {
      void vscode.window.showErrorMessage(plan.message);
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: `${agent.label} sign-in`,
      shellPath: plan.command,
      shellArgs: plan.args,
      cwd: explicit?.cwd ?? state?.source.repoRoot ?? this.cwd(),
      env: plan.env,
    });
    terminal.show();
  }

  /** The Mermaid render check, in whichever Guides webview is open. */
  private async checkMermaid(source: string): Promise<{ ok: true; checked: boolean } | { ok: false; message: string; line?: number }> {
    const hosts = [this.run?.panel?.host, this.home?.host, ...[...this.guidePanels.values()].map((p) => p.host), this.chapterView?.host].filter((h): h is WebviewHost => !!h && h.isReady);
    for (const host of hosts) {
      const r = await host.checkMermaid(source);
      if (!r) continue;
      return r.ok ? { ok: true, checked: true } : { ok: false, message: r.message ?? "Mermaid could not render it.", ...(r.line !== undefined && { line: r.line }) };
    }
    return { ok: true, checked: false };
  }

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  private findDraft(id: string | undefined): DraftRecord | null {
    if (!id) return null;
    // With guide history off the run's draft is only in memory.
    if (this.run?.gen.state.id === id && this.run.gen.state.memoryOnly) return this.run.gen.toDraftRecord();
    const keys = new Set([this.dashboard?.repo?.repoKey, this.run?.gen.state.repoKey, ...allRepoKeys()].filter((k): k is string => !!k));
    for (const key of keys) {
      const r = loadDraftRecord(key, id);
      if (r) return r;
    }
    return null;
  }

  private showGeneration(id: string | undefined): void {
    if (this.run && (!id || this.run.gen.state.id === id)) {
      this.showRunPanel(this.run);
      return;
    }
    const record = this.findDraft(id);
    if (!record) {
      void vscode.window.showWarningMessage("That draft is gone.");
      return;
    }
    const existing = this.draftPanels.get(record.id);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const p = this.createPanel("plannotator.guides.guide", `Guide · draft`, "generating");
    this.draftPanels.set(record.id, p);
    p.panel.onDidDispose(() => this.draftPanels.delete(record.id));
    const gen = new GuideGeneration(
      { repoKey: record.repoKey, source: record.source, rawPatch: record.draft.review.rawPatch, files: changedFilesFromPatch(record.draft.review.rawPatch), agent: record.agent, ...(record.instructions && { instructions: record.instructions }), resume: record },
      this.idleDeps(record.agent.id),
    );
    const state = { ...gen.state, status: record.status === "running" ? "stopped" : record.status, statusMessage: record.statusMessage ?? "The run stopped before the guide was finished.", startedAt: record.createdAt, endedAt: record.updatedAt } as GenerationState;
    p.host.show(this.generatingState(state));
  }

  /** Deps for a generation that is never run (Save as is). */
  private idleDeps(agentId: string): ConstructorParameters<typeof GuideGeneration>[1] {
    return {
      relay: null as unknown as RelayHost,
      agent: this.agentById(agentId) ?? CLAUDE_CODE,
      agentLaunch: () => {
        throw new Error("not running");
      },
      mcpServer: { command: "", args: [] },
      clientInfo: { name: "plannotator-vscode", title: "Plannotator", version: this.version },
      resolveSymbol: (name, path, f, headRoot) => resolveSymbolForBuilder(name, path, headRoot, f.map((x) => x.path)),
      checkMermaid: (source) => this.checkMermaid(source),
      history: guideHistoryEnabled(),
    };
  }

  private async resumeDraft(id: string | undefined, autoApprove?: boolean): Promise<void> {
    const record = this.findDraft(id ?? this.run?.gen.state.id);
    if (!record) {
      void vscode.window.showWarningMessage("That draft is gone.");
      return;
    }
    if (this.run && isLive(this.run.gen.state)) {
      void vscode.window.showWarningMessage("A guide is already being built.");
      return;
    }
    this.draftPanels.get(record.id)?.panel.dispose();
    if (this.run?.gen.state.id === record.id) this.run.panel?.panel.dispose();
    await this.startRun({ kind: "local", mode: "since-base" }, record.agent, record.instructions, record, autoApprove ?? this.autoApproveSetting());
  }

  private async saveDraftAsIs(id: string | undefined): Promise<void> {
    const record = this.findDraft(id ?? this.run?.gen.state.id);
    if (!record) return;
    const gen = new GuideGeneration(
      { repoKey: record.repoKey, source: record.source, rawPatch: record.draft.review.rawPatch, files: changedFilesFromPatch(record.draft.review.rawPatch), agent: record.agent, ...(record.instructions && { instructions: record.instructions }), resume: record },
      this.idleDeps(record.agent.id),
    );
    const result = await gen.saveAsIs();
    if (!result.ok) {
      void vscode.window.showWarningMessage(`The draft was not saved: ${result.problems.join(" ")}`);
      return;
    }
    if (gen.memoryGuide) {
      this.sessionGuides.set(gen.memoryGuide.id, gen.memoryGuide);
      void vscode.window.showInformationMessage("Guide history is off, so this guide is kept only until VS Code closes.");
    }
    this.draftPanels.get(record.id)?.panel.dispose();
    if (this.run?.gen.state.id === record.id) {
      this.run.panel?.panel.dispose();
      this.run = null;
    }
    await this.refresh();
    await this.openGuide(result.guideId);
  }

  private async deleteDraft(id: string | undefined): Promise<void> {
    const record = this.findDraft(id);
    if (!record) return;
    const ok = await vscode.window.showWarningMessage(`Delete the draft "${record.draft.title || record.source.label}"?`, { modal: true }, "Delete");
    if (ok !== "Delete") return;
    deleteDraftRecord(record.repoKey, record.id);
    this.draftPanels.get(record.id)?.panel.dispose();
    // The same rule as deleting a guide: the PR's worktree goes unless something else still reads it.
    await removeDraftWorktree(this.runner, record, this.worktreeUsers());
    await this.refresh();
  }

  // -------------------------------------------------------------------------
  // Reading a guide
  // -------------------------------------------------------------------------

  private locateGuide(id: string): { repoKey: string } | null {
    const memory = this.sessionGuides.get(id);
    if (memory) return { repoKey: memory.repoKey };
    const key = this.dashboard?.repo?.repoKey;
    if (key && loadSavedGuide(key, id)) return { repoKey: key };
    const found = findSavedGuideById(id);
    return found ? { repoKey: found.repoKey } : null;
  }

  /**
   * The repository a guide is read from: the open one when it is the guide's
   * own, else the extension's clone of it (made now for a GitHub repository
   * when there is none, so a PR guide of another repository opens without
   * that repository open). Null when there is no way to reach it.
   */
  private async readerRepoRoot(repoKey: string, onStep: (m: string) => void): Promise<string | null> {
    const open = this.dashboard?.repo;
    if (open && open.repoKey === repoKey) return open.root;
    const storage = this.context.globalStorageUri.fsPath;
    const clone = repoClonePath(storage, repoKey);
    if (existsSync(join(clone, ".git"))) return clone;
    const ghRepo = ghRepoOfKey(repoKey);
    if (!ghRepo) return null;
    try {
      return (await ensureRepoClone(this.runner, ghRepo, storage, onStep, { ghPath: this.ghPath() })).root;
    } catch (err) {
      this.log.warn(`[guides] ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** A saved guide, or one kept in memory because guide history is off. */
  private loadGuide(repoKey: string, id: string): LoadedGuide | null {
    return this.sessionGuides.get(id) ?? loadSavedGuide(repoKey, id);
  }

  async openGuide(id: string | undefined): Promise<void> {
    if (!id) return;
    if (this.reader?.model.id !== id) {
      await this.ensureDashboard();
      const where = this.locateGuide(id);
      if (!where) {
        void vscode.window.showWarningMessage("That guide is gone.");
        return;
      }
      const loaded = this.loadGuide(where.repoKey, id);
      if (!loaded) return;
      if (!loaded.rawPatch) {
        void vscode.window.showWarningMessage("This guide predates portable guides: its diff was not kept, so it opens in Plannotator's web app only.");
        return;
      }
      const sides = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Opening the guide" }, (progress) =>
        this.readerRepoRoot(where.repoKey, (m) => progress.report({ message: m })).then((repoRoot) =>
          resolveReaderSides(this.runner, loaded, { repoRoot, storageDir: this.context.globalStorageUri.fsPath, onStep: (m) => progress.report({ message: m }) }),
        ),
      );
      if ("error" in sides) {
        void vscode.window.showWarningMessage(sides.error);
        return;
      }
      const model = new ReaderModel(loaded);
      const firstOpen = model.reviewed.findIndex((r) => !r);
      model.currentChapter = firstOpen >= 0 ? firstOpen : 0;
      this.reader = { model, sides };
      this.asks.onReaderChanged(model.id);
      this.currentFile = null;
      void vscode.commands.executeCommand("setContext", "plannotator.guides.readerOpen", true);
    }
    this.showGuidePanel();
    this.updateReaderViews();
    void vscode.commands.executeCommand(`${"plannotator.guides.tree"}.focus`);
    void this.recheckDiagram();
  }

  /**
   * A guide whose overview diagram was saved without a render check (no
   * Guides webview was open during a background run) is checked once its tab
   * is open, and the reader is told when it does not render.
   */
  private async recheckDiagram(): Promise<void> {
    const reader = this.reader;
    if (!reader || reader.model.loaded.sidecar.diagramCheck !== "unchecked") return;
    const source = reader.model.overview?.diagram?.source;
    const host = this.guidePanels.get(reader.model.id)?.host;
    if (!source || !host) return;
    let result: Awaited<ReturnType<WebviewHost["checkMermaid"]>> = null;
    for (let i = 0; i < 20 && !result; i++) {
      result = await host.checkMermaid(source);
      if (!result) await new Promise((r) => setTimeout(r, 250));
    }
    if (!result || this.reader !== reader) return;
    const loaded = reader.model.loaded;
    loaded.sidecar.diagramCheck = result.ok ? "ok" : "failed";
    if (!this.sessionGuides.has(loaded.id)) writeSidecar(loaded.repoKey, loaded.id, loaded.sidecar);
    if (!result.ok) void vscode.window.showWarningMessage(`The overview diagram of this guide does not render: ${result.message ?? "Mermaid refused it"}${result.line ? ` (line ${result.line})` : ""}.`);
  }

  private closeGuide(): void {
    if (!this.reader) return;
    this.guidePanels.get(this.reader.model.id)?.panel.dispose();
    this.reader = null;
    this.asks.onReaderChanged(null);
    this.currentFile = null;
    void vscode.commands.executeCommand("setContext", "plannotator.guides.readerOpen", false);
    this.updateReaderViews();
  }

  private guideState(): GuideViewState | null {
    if (!this.reader) return null;
    const { model, sides } = this.reader;
    const env = model.loaded.envelope;
    const engine = engineLabel(env.engine);
    const kicker = ["Guided review", env.label, engine, model.loaded.sidecar.agent?.model?.label ?? env.model, env.generatedAt ? relativeTime(env.generatedAt) : ""].filter(Boolean).join(" · ");
    return {
      mode: "guide",
      guideId: model.id,
      kicker,
      title: model.title,
      intent: env.guide.intent,
      overview: model.overview,
      chapters: model.chapters.map((c, i) => ({ n: i + 1, title: c.title, files: c.files.map((f) => basename(f.path)), reviewed: model.reviewed[i], color: chapterColorCss(i) })),
      reviewed: model.reviewed.filter(Boolean).length,
      moved: sides.moved,
    };
  }

  private showGuidePanel(): void {
    if (!this.reader) return;
    const id = this.reader.model.id;
    let p = this.guidePanels.get(id);
    if (!p) {
      for (const [other, entry] of this.guidePanels) if (other !== id) entry.panel.dispose();
      p = this.createPanel("plannotator.guides.guide", "Guide", "guide");
      const entry = p;
      this.guidePanels.set(id, entry);
      entry.panel.onDidDispose(() => {
        if (this.guidePanels.get(id) === entry) this.guidePanels.delete(id);
      });
    } else p.panel.reveal();
    p.panel.title = `Guide · ${this.reader.model.loaded.envelope.label || "local"}`;
    const state = this.guideState();
    if (state) p.host.show(state);
  }

  private chapterState(): ChapterViewState {
    if (!this.reader) return { mode: "chapter", empty: true };
    const { model } = this.reader;
    const i = model.currentChapter;
    const ch = model.chapters[i];
    if (!ch) return { mode: "chapter", empty: true };
    const sc = model.loaded.sidecar;
    const footer = sc.agent ? [sc.agent.label, sc.agent.model?.label, sc.agent.effort?.label, sc.cost ? `$${sc.cost.amount.toFixed(2)}` : ""].filter(Boolean).join(" · ") : undefined;
    return {
      mode: "chapter",
      empty: false,
      n: i + 1,
      total: model.chapters.length,
      title: ch.title,
      overview: ch.overview,
      files: ch.files.map((f) => ({ path: f.path, name: basename(f.path), summary: f.summary, reviewed: model.fileTicks.has(f.path) })),
      reviewed: model.reviewed[i],
      hasNext: i + 1 < model.chapters.length,
      ...(footer && { footer }),
      ...this.chapterAsks(i),
    };
  }

  /** The chapter view's ask box and the answers about this chapter. */
  private chapterAsks(chapter: number): Pick<ChapterViewState, "ask" | "answers" | "answersFooter"> {
    if (!this.reader) return {};
    const a = this.asks.chapterAnswers(this.reader.model.loaded, chapter);
    return { ask: { agent: a.agent, busy: a.busy }, ...(a.items.length && { answers: a.items }), ...(a.footer && a.items.length && { answersFooter: a.footer }) };
  }

  resolveChapterView(view: vscode.WebviewView): void {
    view.webview.options = webviewOptions(this.context.extensionUri);
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri, "chapter");
    const host = new WebviewHost(view.webview, {
      onCommand: (command, args) => void this.webviewCommand(command, args),
      onLink: (link, action) => void this.openLink(link, action),
      onLinkInfo: (link) => this.linkInfo(link),
    });
    this.chapterView = { view, host };
    view.onDidDispose(() => {
      host.dispose();
      if (this.chapterView?.view === view) this.chapterView = null;
    });
    this.updateChapterView();
  }

  updateChapterView(): void {
    if (!this.chapterView) return;
    const state = this.chapterState();
    this.chapterView.view.title = state.empty ? "Chapter" : `Chapter ${state.n} · why this changed`;
    this.chapterView.host.show(state);
  }

  private updateReaderViews(): void {
    this.fireTree();
    this.updateChapterView();
    const state = this.guideState();
    if (state && this.reader) this.guidePanels.get(this.reader.model.id)?.host.show(state);
    this.ui.refresh();
    this.ui.updateStatus(this.currentFile);
    this.updateEditorContext(vscode.window.activeTextEditor);
  }

  private persistTicks(): void {
    if (!this.reader) return;
    const { model } = this.reader;
    if (!this.sessionGuides.has(model.id)) {
      setChapterReviewed(model.loaded.repoKey, model.id, model.reviewed);
      writeSidecar(model.loaded.repoKey, model.id, { ...model.loaded.sidecar, fileTicks: [...model.fileTicks] });
    }
    model.loaded.sidecar.fileTicks = [...model.fileTicks];
    model.loaded.envelope.reviewed = [...model.reviewed];
  }

  private async openChapter(n: number | undefined, options?: { openFile?: boolean; column?: vscode.ViewColumn }): Promise<void> {
    if (!this.reader || n === undefined) return;
    const { model } = this.reader;
    const index = n - 1;
    if (!model.chapters[index]) return;
    model.currentChapter = index;
    this.updateReaderViews();
    void vscode.commands.executeCommand("plannotator.guides.chapter.focus");
    try {
      await this.bridge.treeView.reveal({ kind: "chapter", index }, { expand: true, select: true, focus: false });
    } catch {
      // the tree may not be visible
    }
    if (options?.openFile !== false) {
      const first = model.chapters[index].files.find((f) => !model.fileTicks.has(f.path)) ?? model.chapters[index].files[0];
      if (first) await this.openFile(first.path, undefined, options?.column);
    }
  }

  private async nextChapter(): Promise<void> {
    if (!this.reader) return;
    const next = this.reader.model.currentChapter + 1;
    if (next >= this.reader.model.chapters.length) {
      void vscode.window.showInformationMessage("That was the last chapter.");
      return;
    }
    await this.openChapter(next + 1);
  }

  private async markChapterReviewed(n: number | undefined, value?: boolean): Promise<void> {
    if (!this.reader || n === undefined) return;
    const { model } = this.reader;
    const index = n - 1;
    model.setChapterReviewed(index, value ?? !model.reviewed[index]);
    this.persistTicks();
    this.updateReaderViews();
  }

  private async toggleFileReviewed(path: string | undefined): Promise<void> {
    const p = path ?? this.currentFile;
    if (!this.reader || !p) return;
    this.reader.model.setFileReviewed(p, !this.reader.model.fileTicks.has(p));
    this.persistTicks();
    this.updateReaderViews();
  }

  private onCheckboxes(e: vscode.TreeCheckboxChangeEvent<TreeNode>): void {
    if (!this.reader) return;
    for (const [node, state] of e.items) {
      const checked = state === vscode.TreeItemCheckboxState.Checked;
      if (node.kind === "chapter") this.reader.model.setChapterReviewed(node.index, checked);
      else if (node.kind === "file") this.reader.model.setFileReviewed(node.path, checked);
    }
    this.persistTicks();
    this.updateReaderViews();
  }

  private async nextFile(path: string | undefined): Promise<void> {
    if (!this.reader) return;
    const next = this.reader.model.nextFile(path ?? null);
    if (!next) {
      void vscode.window.showInformationMessage("That was the last file of the guide.");
      return;
    }
    await this.openFile(next.path);
  }

  /** Open a guide file in the native diff editor, in preview so stepping reuses one tab. */
  async openFile(path: string | undefined, line?: number, column?: vscode.ViewColumn): Promise<void> {
    if (!this.reader || !path) return;
    const { model, sides } = this.reader;
    const file = model.files.get(path) ?? { path, status: "modified" };
    const chapter = model.chapterOf(path);
    if (chapter >= 0) model.currentChapter = chapter;
    this.currentFile = path;
    const focus = model.focusRanges(path)[0];
    const target = line ?? focus?.start ?? model.files.get(path)?.hunks[0]?.start;
    const selection = target ? new vscode.Range(target - 1, 0, target - 1, 0) : undefined;
    const title = `${basename(path)}${chapter >= 0 ? ` · Chapter ${chapter + 1}` : ""}`;
    const where = column ?? diffColumnBesideAnswers(baseUri(sides, file), headUri(sides, file));
    await vscode.commands.executeCommand("vscode.diff", baseUri(sides, file), headUri(sides, file), title, { preview: true, ...(selection && { selection }), ...(where && { viewColumn: where }) });
    this.updateReaderViews();
    void this.offerDiffCodeLens();
  }

  /**
   * The "Chapter 2 of 5 · Mark reviewed · Next file" line is a CodeLens, and
   * VS Code hides CodeLens in diff editors unless `diffEditor.codeLens` is on.
   * Ask once; never change the setting without the reader's yes.
   */
  private async offerDiffCodeLens(): Promise<void> {
    if (vscode.workspace.getConfiguration("diffEditor").get<boolean>("codeLens")) return;
    if (this.context.globalState.get<boolean>("plannotator.guides.askedDiffCodeLens")) return;
    await this.context.globalState.update("plannotator.guides.askedDiffCodeLens", true);
    const choice = await vscode.window.showInformationMessage(
      "Guided reviews put a line at the top of each diff: its chapter, Mark reviewed and Next file. VS Code hides such lines in diffs unless CodeLens in the diff editor is on. Turn it on?",
      "Turn on",
      "Not now",
    );
    if (choice === "Turn on") await vscode.workspace.getConfiguration("diffEditor").update("codeLens", true, vscode.ConfigurationTarget.Global);
  }

  /** `plannotator.guides.editorInGuide`: the editor shows a file of the open guide (either side), for "Ask the Agent About This…". */
  private updateEditorContext(editor: vscode.TextEditor | undefined): void {
    const inGuide = !!editor && !!this.reader && (() => {
      const side = guideSideOf(this.reader!.sides, editor.document.uri, this.reader!.model.files);
      return !!side && this.reader!.model.chapterOf(side.path) >= 0;
    })();
    void vscode.commands.executeCommand("setContext", "plannotator.guides.editorInGuide", inGuide);
  }

  private onActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (!this.reader || !editor) return;
    const path = headPathOf(this.reader.sides, editor.document.uri);
    if (!path || this.reader.model.chapterOf(path) < 0 || path === this.currentFile) return;
    this.currentFile = path;
    this.reader.model.currentChapter = this.reader.model.chapterOf(path);
    this.updateReaderViews();
  }

  private async openLocation(path: string | undefined, line?: number): Promise<void> {
    if (!path) return;
    const root = this.run?.gen.state.source.headRoot ?? this.reader?.sides.gitRoot ?? this.dashboard?.repo?.root;
    if (!root) return;
    const uri = path.startsWith("/") ? vscode.Uri.file(path) : vscode.Uri.joinPath(vscode.Uri.file(root), path);
    const pos = line ? new vscode.Position(Math.max(0, line - 1), 0) : undefined;
    await vscode.window.showTextDocument(uri, { preview: true, ...(pos && { selection: new vscode.Range(pos, pos) }) });
  }

  private async linkInfo(href: string) {
    if (!this.reader) return { ok: false, label: href, inChange: false, message: "Open a guide first." };
    try {
      return await linkInfo(href, this.reader.model, this.reader.sides);
    } catch (err) {
      return { ok: false, label: href, inChange: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** A click on an overview link: its diff when the file is in the change, the plain file otherwise. */
  private async openLink(href: string, action: "open" | "definition" | "references", column?: vscode.ViewColumn): Promise<void> {
    if (!this.reader) return;
    const parsed = parseGuideLink(href);
    if (!parsed?.ok) return;
    const link = parsed.link;
    if (link.kind === "chapter") return this.openChapter(link.chapter, column ? { column } : undefined);
    const target = await locateLink(link, this.reader.model, this.reader.sides);
    if ("error" in target) {
      void vscode.window.showWarningMessage(target.error);
      return;
    }
    if (action === "open" && target.inChange) return this.openFile(target.path, target.range.start.line + 1, column);
    const editor = await vscode.window.showTextDocument(target.uri, { preview: true, selection: target.range, ...(column && { viewColumn: column }) });
    if (action === "definition") await vscode.commands.executeCommand("editor.action.revealDefinition");
    if (action === "references") await vscode.commands.executeCommand("editor.action.goToReferences", editor.document.uri, target.range.start);
  }

  // -------------------------------------------------------------------------
  // Export and delete
  // -------------------------------------------------------------------------

  private async exportGuide(id: string | undefined): Promise<void> {
    const guideId = id ?? this.reader?.model.id;
    if (!guideId) return;
    const where = this.locateGuide(guideId);
    const loaded = where ? this.loadGuide(where.repoKey, guideId) : null;
    if (!where || !loaded) return;
    const snapshot = snapshotOfGuide(loaded);
    if (!snapshot) {
      void vscode.window.showWarningMessage("This guide's diff was not kept, so it cannot be exported.");
      return;
    }
    const html = createGuideHtml(snapshot, { viewer: resolveGuideViewerAssets(GUIDE_VIEWER_MANIFEST, { baseUrl: process.env.PLANNOTATOR_GUIDE_VIEWER_URL }) });
    const defaultUri = vscode.Uri.joinPath(vscode.Uri.file(this.dashboard?.repo?.root ?? this.context.globalStorageUri.fsPath), guideExportFilename(snapshot.guide.title));
    const target = await vscode.window.showSaveDialog({ defaultUri, filters: { HTML: ["html"] }, title: "Download portable guide" });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(html, "utf8"));
    void vscode.window.showInformationMessage(`Saved ${basename(target.fsPath)}. It opens in any browser.`);
  }

  private async deleteGuide(id: string | undefined): Promise<void> {
    if (!id) return;
    const where = this.locateGuide(id);
    const loaded = where ? this.loadGuide(where.repoKey, id) : null;
    if (!where || !loaded) return;
    const memory = this.sessionGuides.has(id);
    const share = loaded.envelope.share;
    const ok = await vscode.window.showWarningMessage(
      memory ? `Delete the guide "${loaded.envelope.title}"? It was never saved (guide history is off).` : `Delete the guide "${loaded.envelope.title}"? The web app's list loses it too.${share ? " Its share link is removed first." : ""}`,
      { modal: true },
      "Delete",
    );
    if (ok !== "Delete") return;
    // The envelope is the only copy of the share link's delete token: remove the link first.
    const unshared = await removeShareBeforeDelete(share);
    if (!unshared.ok) {
      const choice = await vscode.window.showWarningMessage(
        `Could not remove the share link ${unshared.url}: ${unshared.reason}. Deleting the guide now loses the only copy of its delete token.`,
        { modal: true, detail: `To remove the link later: ${unshared.command}` },
        "Copy command and delete",
      );
      if (choice !== "Copy command and delete") return;
      await vscode.env.clipboard.writeText(unshared.command);
    }
    if (this.reader?.model.id === id) this.closeGuide();
    if (memory) this.sessionGuides.delete(id);
    else deleteSavedGuide(where.repoKey, id);
    this.asks.onGuideDeleted(where.repoKey, id);
    const storage = this.context.globalStorageUri.fsPath;
    const wt = guideWorktreePath(loaded, storage);
    const repoRoot = loaded.sidecar.source?.repoRoot ?? this.dashboard?.repo?.root;
    if (wt && repoRoot && !pullRequestWorktreeInUse(where.repoKey, wt, this.worktreeUsers(), { guideId: id })) await removePullRequestWorktree(this.runner, repoRoot, wt, storage);
    await this.refresh();
  }

  /** What reads a PR worktree besides the guides and drafts on disk. */
  private worktreeUsers(): WorktreeUsers {
    return {
      storageDir: this.context.globalStorageUri.fsPath,
      liveRunHeadRoot: this.run?.gen.state.source.headRoot ?? null,
      readerGitRoot: this.reader?.sides.gitRoot ?? null,
      sessionGuides: this.sessionGuides.values(),
    };
  }

  dispose(): void {
    // VS Code is closing: no grace period for the agent or anything it started.
    this.run?.gen.kill();
    this.asks.kill();
    // An agent stopped, exited or crashed earlier whose group still waits out its grace: killed now too.
    killPendingProcessGroups();
    for (const d of this.disposables) d.dispose();
  }
}

function isLive(s: GenerationState): boolean {
  return s.status === "starting" || s.status === "running" || s.status === "finishing";
}

/** A tree node passed as a command argument (inline actions pass the node). */
function treeArg(arg: unknown): string | undefined {
  if (!arg || typeof arg !== "object") return undefined;
  const node = arg as TreeNode;
  if (node.kind === "recent") return node.entry.id;
  return undefined;
}

export { nodeId };

/** The dashboard with this session's unsaved guides (guide history off) and a note when history is off. */
function withSessionGuides(model: DashboardModel, guides: LoadedGuide[], history: boolean): DashboardModel {
  const key = model.repo?.repoKey;
  const entries: RecentEntry[] = guides
    .filter((g) => g.repoKey === key)
    .map((g) => ({ kind: "guide", id: g.id, title: g.envelope.title, label: g.envelope.label, at: g.envelope.savedAt, progress: { reviewed: g.envelope.reviewed.filter(Boolean).length, total: g.envelope.guide.sections.length }, sessionOnly: true }));
  const notes = history ? model.notes : [...model.notes, "Guide history is off (PLANNOTATOR_GUIDE_HISTORY or guideHistory in Plannotator's config.json): new guides and drafts are not saved, only kept until VS Code closes."];
  return { ...model, recent: [...entries, ...model.recent].sort((a, b) => b.at - a.at), notes };
}
