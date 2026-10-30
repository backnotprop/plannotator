/**
 * "Ask the agent" (approved 2026-10-23; asked from the Guide tab since
 * 2026-10-24): select lines in a diff in the Guide tab and ask in its Ask box,
 * or ask about a chapter at the foot of the chapter's prose; in a native
 * editor showing a guide file, right-click "Ask the Agent About This…" (a
 * Quick Pick). The question goes to the agent that wrote the guide (its model
 * and effort), and its answer opens as a page in a tab beside the guide,
 * listed under the chapter and marked on the lines. Follow-ups continue the
 * same conversation.
 */

import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { KNOWN_AGENTS, type AgentDescriptor, type LoginCommand } from "@plannotator/acp-client/agents";
import type { ReadyLaunch } from "@plannotator/acp-client/ensure-launch";
import { agentLaunchFor } from "../acp/agent-cli";
import { capCode, fileLinesHash, linesHash, newAnswerId, staleNote, type AnswerRecord, type AskAbout } from "../ask/answers";
import { AnswerShelf } from "../ask/shelf";
import { buildAskPrompt, type AskGuideContext } from "../ask/prompt";
import { GuideAskSession, type AskRun, type AskRunState, type SavedSession } from "../ask/session";
import { aboutTitle, answerListItem, answerViewState, answersFooter, goesWith, relativeTimeShort } from "../ask/view";
import type { PendingPermission, PermissionAnswer } from "../generation";
import type { RelayHost } from "../mcp/relay-host";
import { patchExcerpt } from "../reader-mapping";
import type { ReaderModel, ReaderSides } from "../reader-model";
import { headLeavesRepo, readOwnFile, realFileInside } from "../safe-path";
import type { Runner } from "../sources/runner";
import { writeSidecar, type AgentChoiceRecord, type LoadedGuide } from "../store";
import type { AnswerListItem } from "../webview-protocol";
import { pickQuestion } from "./ask-box";
import { resolveSymbolForBuilder } from "./intel";
import { guideSideOf } from "./uris";
import type { WebviewHost, WebviewMode } from "./webview-host";

export interface AsksPanel {
  panel: vscode.WebviewPanel;
  host: WebviewHost;
}

export interface AsksHost {
  context: vscode.ExtensionContext;
  version: string;
  runner: Runner;
  log(line: string): void;
  reader(): { model: ReaderModel; sides: ReaderSides } | null;
  openGuide(id: string): Promise<void>;
  openLink(href: string, column?: vscode.ViewColumn): Promise<void>;
  relayHost(): Promise<RelayHost>;
  agentById(id: string): AgentDescriptor | null;
  defaultChoice(): AgentChoiceRecord;
  ensureLaunch(agent: AgentDescriptor): Promise<ReadyLaunch | null>;
  /** Pick another agent, model or effort (the start flow's picker). */
  pickModel(current: AgentChoiceRecord): Promise<AgentChoiceRecord | null>;
  notifyPermission(pending: PendingPermission, signal: AbortSignal, agentLabel: string): Promise<PermissionAnswer | null>;
  autoApprove(): boolean;
  approveAlways(): void;
  signIn(agentId: string, logins: LoginCommand[], label: string | undefined, cwd: string): Promise<void>;
  createPanel(title: string, column: vscode.ViewColumn, onLink: (link: string) => void, preserveFocus?: boolean): AsksPanel;
  /** Whether answers are written to disk (guide history on, and the guide itself is saved). */
  persists(guide: LoadedGuide): boolean;
  updateChapterView(): void;
  setAnswering(text: string | null, answerId: string | null): void;
}

interface LiveAsk {
  run: AskRun;
  record: AnswerRecord;
  codeColumn?: vscode.ViewColumn;
}

interface AskOptions {
  codeColumn?: vscode.ViewColumn;
  followUpOf?: AnswerRecord;
  panel?: AnswerPanel;
}

type AskResult = { started: true } | { started: false; reason?: string };

interface AnswerPanel extends AsksPanel {
  /** The answer it shows now (a follow-up moves it to the next answer). */
  current: string;
  guideId: string;
  repoKey: string;
  /** Where to open code links: the diff's editor group. */
  codeColumn: vscode.ViewColumn | undefined;
}

const MAX_QUESTION = 2000;
const askChoiceKey = (guideId: string) => `plannotator.guides.askChoice:${guideId}`;

export class GuideAsks implements vscode.Disposable {
  private readonly sessions = new Map<string, GuideAskSession>();
  private readonly live = new Map<string, LiveAsk>();
  private readonly panels = new Set<AnswerPanel>();
  /** The answers on disk or in memory, what was deleted, and the one-question-per-guide slot. */
  private readonly shelf: AnswerShelf;
  private answerColumn: vscode.ViewColumn | undefined;

  constructor(private readonly host: AsksHost) {
    this.shelf = new AnswerShelf((line) => host.log(line));
  }

  // ---------------------------------------------------------------------------
  // Answers, on disk or in memory
  // ---------------------------------------------------------------------------

  private save(record: AnswerRecord, guide: LoadedGuide): boolean {
    return this.shelf.save(record, this.host.persists(guide));
  }

  /** The guide's answers, newest first (a live one as it is now). */
  answersOf(guide: LoadedGuide): AnswerRecord[] {
    return this.shelf.list(guide.repoKey, guide.id, this.host.persists(guide)).map((r) => this.live.get(r.id)?.record ?? r);
  }

  private find(guide: LoadedGuide, id: string): AnswerRecord | null {
    return this.live.get(id)?.record ?? this.answersOf(guide).find((r) => r.id === id) ?? null;
  }

  /** The Guide tab's list under a chapter: answers about this chapter, and the footer. */
  chapterAnswers(guide: LoadedGuide, chapter: number): { items: AnswerListItem[]; footer?: string; busy: boolean; agent: string } {
    const all = this.answersOf(guide);
    const mine = all.filter((r) => r.about.chapter === chapter);
    const now = Date.now();
    return {
      items: mine.map((r) => answerListItem(r, now, this.live.has(r.id) && !!this.live.get(r.id)?.run.live)),
      footer: answersFooter(all),
      busy: this.isBusy(guide.id),
      agent: this.choiceFor(guide).label,
    };
  }

  private isBusy(guideId: string): boolean {
    return this.shelf.isReserved(guideId) || !!this.sessions.get(guideId)?.current;
  }

  // ---------------------------------------------------------------------------
  // Entry points
  // ---------------------------------------------------------------------------

  /** Right-click on selected code in a native editor showing a guide file: the question in a Quick Pick. */
  async askAboutSelection(): Promise<void> {
    const reader = this.host.reader();
    const editor = vscode.window.activeTextEditor;
    if (!reader || !editor) {
      void vscode.window.showInformationMessage("Open a guided review and select code in one of its files, then ask.");
      return;
    }
    const side = guideSideOf(reader.sides, editor.document.uri, reader.model.files);
    const chapter = side ? reader.model.chapterOf(side.path) : -1;
    if (!side || chapter < 0) {
      void vscode.window.showInformationMessage("That file is not part of the open guided review.");
      return;
    }
    // A symlink of the change that leads out of the repository is not the guide's file: its text is never sent.
    if (side.side === "head" && headLeavesRepo(reader.sides, reader.model.files.get(side.path) ?? { path: side.path })) {
      void vscode.window.showInformationMessage(`${side.path} leads out of the repository; it is not asked about.`);
      return;
    }
    const sel = editor.selection;
    const about = sel.isEmpty ? this.fileAbout(reader, side.path, chapter) : this.selectionAbout(reader, editor.document, sel, side, chapter);
    await this.askWithBox(about, editor.viewColumn);
  }

  /** A chapter's ask box (the Guide tab): what was typed is asked; nothing typed opens the question box. */
  async askChapter(n: number | undefined, text: string | undefined): Promise<void> {
    const reader = this.host.reader();
    if (!reader) return;
    const chapter = (n ?? reader.model.currentChapter + 1) - 1;
    const ch = reader.model.chapters[chapter];
    if (!ch) return;
    const about: AskAbout = { kind: "chapter", chapter, chapterTitle: ch.title };
    const column = vscode.window.activeTextEditor?.viewColumn;
    const question = text?.trim().slice(0, MAX_QUESTION);
    if (question) return void await this.ask(reader.model.loaded, about, question, { codeColumn: column });
    await this.askWithBox(about, column);
  }

  /**
   * The Guide tab: lines selected in a file's diff (head lines), and the
   * question typed in the selection toolbar. The answer opens beside the
   * guide and shows the agent's work as it goes; the lines get a marker in
   * the reader.
   */
  async askAboutLines(path: string, side: "old" | "new", start: number, end: number, question: string): Promise<void> {
    const reader = this.host.reader();
    if (!reader) return;
    const chapter = reader.model.chapterOf(path);
    const text = question.trim().slice(0, MAX_QUESTION);
    if (chapter < 0 || !text) return;
    // The code is what the reviewer saw: the lines of the guide's own diff on
    // that side (removed lines are base lines; a deleted file has only those).
    // Never read from disk, where a symlink in the change could point anywhere.
    const excerpt = patchExcerpt(reader.model.loaded.rawPatch ?? "", path, side, start, end);
    const oldPath = side === "old" ? reader.model.files.get(path)?.oldPath : undefined;
    const about: AskAbout = {
      kind: "selection",
      chapter,
      chapterTitle: reader.model.chapters[chapter].title,
      path,
      ...(oldPath && oldPath !== path && { oldPath }),
      side: side === "old" ? "base" : "head",
      lines: { start, end },
      ...(excerpt !== null && { code: capCode(excerpt), codeHash: linesHash(excerpt) }),
    };
    await this.ask(reader.model.loaded, about, text, { codeColumn: vscode.ViewColumn.Active });
  }

  /** Line answers of the guide, for the reader's markers (newest first). */
  lineAnswers(guide: LoadedGuide): Array<{ id: string; path: string; side: "old" | "new"; start: number; end: number; question: string; status: AnswerRecord["status"] }> {
    return this.answersOf(guide)
      .filter((r) => r.about.kind === "selection" && r.about.path && r.about.lines)
      .map((r) => ({
        id: r.id,
        path: r.about.path!,
        side: r.about.side === "base" ? ("old" as const) : ("new" as const),
        start: r.about.lines!.start,
        end: r.about.lines!.end,
        question: r.question,
        status: this.live.has(r.id) ? "answering" : r.status,
      }));
  }

  private selectionAbout(reader: { model: ReaderModel; sides: ReaderSides }, doc: vscode.TextDocument, sel: vscode.Selection, side: { path: string; side: "head" | "base" }, chapter: number): AskAbout {
    // A selection ending at column 0 of a line does not take that line.
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    const range = new vscode.Range(sel.start.line, 0, endLine, doc.lineAt(endLine).text.length);
    const code = doc.getText(range);
    const oldPath = side.side === "base" ? reader.model.files.get(side.path)?.oldPath : undefined;
    return {
      kind: "selection",
      chapter,
      chapterTitle: reader.model.chapters[chapter].title,
      path: side.path,
      ...(oldPath && oldPath !== side.path && { oldPath }),
      side: side.side,
      lines: { start: sel.start.line + 1, end: endLine + 1 },
      code: capCode(code),
      // What was asked about: these lines, as the editor showed them (the open document, saved or not).
      codeHash: linesHash(code),
    };
  }

  private fileAbout(reader: { model: ReaderModel; sides: ReaderSides }, path: string, chapter: number): AskAbout {
    const hash = this.headHash(reader, path);
    return { kind: "file", chapter, chapterTitle: reader.model.chapters[chapter].title, path, side: "head", ...(hash && { fileHash: hash }) };
  }

  /**
   * The same things the record's hash describes, now: the lines asked about
   * on the head (read from disk, inside the repository only), or the whole
   * head file. Not known (left out) for the base side and a head revision,
   * which do not move.
   */
  private currentHashes(reader: { sides: ReaderSides }, record: AnswerRecord): { fileHash?: string | null; codeHash?: string | null } {
    const about = record.about;
    if (!about.path || about.side === "base" || reader.sides.head.kind !== "fs") return {};
    if (about.codeHash && about.lines) {
      const real = realFileInside(reader.sides.head.root, about.path);
      if (!real) return { codeHash: null };
      try {
        return { codeHash: fileLinesHash(readFileSync(real, "utf8"), about.lines.start, about.lines.end) };
      } catch {
        return { codeHash: null };
      }
    }
    return about.fileHash ? { fileHash: this.headHash(reader, about.path) } : {};
  }

  private headHash(reader: { sides: ReaderSides }, path: string): string | null {
    if (reader.sides.head.kind !== "fs") return null;
    try {
      const bytes = readOwnFile(reader.sides.head.root, path);
      return bytes ? createHash("sha1").update(bytes).digest("hex") : null;
    } catch {
      return null;
    }
  }

  private async askWithBox(about: AskAbout, codeColumn: vscode.ViewColumn | undefined): Promise<void> {
    const reader = this.host.reader();
    if (!reader) return;
    const guide = reader.model.loaded;
    let choice = this.choiceFor(guide);
    const now = Date.now();
    const picked = await pickQuestion({
      agentLabel: choice.label,
      modelEffort: modelEffortLabel(choice),
      about: aboutTitle(about),
      goesWith: goesWith(about),
      past: this.answersOf(guide).slice(0, 8).map((r) => ({ id: r.id, question: r.question, sub: answerListItem(r, now, false).sub, when: relativeTimeShort(r.answeredAt ?? r.askedAt, now) })),
      changeModel: async () => {
        const next = await this.host.pickModel(choice);
        if (!next) return null;
        choice = next;
        await this.host.context.globalState.update(askChoiceKey(guide.id), next);
        return modelEffortLabel(next);
      },
    });
    if (!picked) return;
    if (picked.kind === "open") return this.openAnswer(picked.answerId);
    await this.ask(guide, about, picked.question.slice(0, MAX_QUESTION), { codeColumn });
  }

  /** The agent, model and effort that answer: the reader's pick for this guide, else the guide's own. */
  choiceFor(guide: LoadedGuide): AgentChoiceRecord {
    const picked = this.host.context.globalState.get<AgentChoiceRecord>(askChoiceKey(guide.id));
    if (picked && this.host.agentById(picked.id)) return picked;
    const own = guide.sidecar.agent;
    if (own && this.host.agentById(own.id)) return own;
    const byEngine = KNOWN_AGENTS.find((a) => a.engine === guide.envelope.engine);
    if (byEngine) return { id: byEngine.id, label: byEngine.label, ...(guide.envelope.model && { model: { id: guide.envelope.model, label: guide.envelope.model } }) };
    return this.host.defaultChoice();
  }

  // ---------------------------------------------------------------------------
  // Asking
  // ---------------------------------------------------------------------------

  private async ask(guide: LoadedGuide, about: AskAbout, question: string, opts: AskOptions): Promise<AskResult> {
    const reader = this.host.reader();
    if (!reader || reader.model.id !== guide.id) return { started: false, reason: "Its guide is not open." };
    // One question at a time per guide: the slot is taken before anything is awaited, so a
    // second ask (a double Enter, the box and the chapter at once) is refused, never half-started.
    if (!this.shelf.reserve(guide.id)) {
      const busy = this.sessions.get(guide.id)?.current;
      const running = busy ? this.live.get(busy.state.answerId)?.record : undefined;
      const who = running?.agent.label ?? this.choiceFor(guide).label;
      const choice = await vscode.window.showWarningMessage(
        `${who} is ${running ? "answering" : "getting ready to answer"} another question${running ? `: “${running.question}”` : ""}.`,
        ...(running ? ["Show it", "Stop it"] : []),
      );
      if (choice === "Show it" && running) await this.openAnswer(running.id);
      if (choice === "Stop it") await busy?.cancel();
      return { started: false };
    }
    let started = false;
    try {
      started = await this.start(guide, reader, about, question, opts);
    } finally {
      if (!started) this.shelf.release(guide.id);
    }
    return started ? { started: true } : { started: false, reason: "The agent did not start." };
  }

  /** Start answering (the guide's slot is held); true when a run started, which releases the slot when it ends. */
  private async start(guide: LoadedGuide, reader: { model: ReaderModel; sides: ReaderSides }, about: AskAbout, question: string, opts: AskOptions): Promise<boolean> {
    const choice = this.choiceFor(guide);
    const descriptor = this.host.agentById(choice.id);
    if (!descriptor) {
      void vscode.window.showErrorMessage(`Plannotator does not know the agent ${choice.label}.`);
      return false;
    }
    const launch = await this.host.ensureLaunch(descriptor);
    if (!launch) return false;
    if (this.shelf.isGuideDeleted(guide.id) || this.host.reader()?.model.id !== guide.id) return false;
    const cwd = reader.sides.head.kind === "fs" ? reader.sides.head.root : reader.sides.gitRoot;
    const session = await this.sessionFor(guide, descriptor, launch, cwd, reader);
    const record: AnswerRecord = {
      v: 1,
      id: newAnswerId(),
      guideId: guide.id,
      repoKey: guide.repoKey,
      question,
      about,
      askedAt: Date.now(),
      status: "answering",
      agent: choice,
      ...(await this.headSha(guide, cwd).then((sha) => (sha ? { headSha: sha } : {}))),
      ...(opts.followUpOf && { followUpOf: opts.followUpOf.id }),
      seen: true,
    };
    if (!this.save(record, guide)) return false;
    const context = guideContext(guide, reader, cwd);
    const previous = opts.followUpOf ? { question: opts.followUpOf.question, ...(opts.followUpOf.title && { title: opts.followUpOf.title }) } : undefined;
    const run = session.ask({
      answerId: record.id,
      agent: choice,
      autoApprove: this.host.autoApprove(),
      prompt: (m) => buildAskPrompt({
        mode: m.firstInSession ? m.session : opts.followUpOf ? "followUp" : "next",
        ...(m.loadedFrom && { loadedFrom: m.loadedFrom }),
        question,
        about,
        guide: context,
        ...(previous && { previous }),
      }),
    });
    const live: LiveAsk = { run, record, ...(opts.codeColumn && { codeColumn: opts.codeColumn }) };
    this.live.set(record.id, live);
    // The tab opens beside the guide at once and shows the work as it goes (a follow-up's open tab moves on).
    const panel = opts.panel ?? this.panelFor(record, opts.codeColumn, true);
    panel.current = record.id;
    panel.panel.title = tabTitle(question, true);
    panel.panel.reveal(panel.panel.viewColumn, true);
    this.host.setAnswering(question, record.id);
    let lastChapter = 0;
    run.onChange((state) => {
      this.showLive(live, state);
      const now = Date.now();
      if (now - lastChapter > 600) {
        lastChapter = now;
        this.host.updateChapterView();
      }
    });
    this.showLive(live, run.state);
    this.host.updateChapterView();
    void run.done.then((state) => {
      this.shelf.release(guide.id);
      this.finished(guide, live, state, session);
    });
    return true;
  }

  private async sessionFor(guide: LoadedGuide, agent: AgentDescriptor, launch: ReadyLaunch, cwd: string, reader: { model: ReaderModel; sides: ReaderSides }): Promise<GuideAskSession> {
    const existing = this.sessions.get(guide.id);
    if (existing && existing.agentId === agent.id && existing.input.cwd === cwd) return existing;
    existing?.dispose();
    const sc = guide.sidecar;
    const saved: SavedSession[] = [];
    if (sc.askSession && sc.askSession.agent === agent.id) saved.push({ id: sc.askSession.id, from: sc.askSession.id === sc.acpSessionId ? "guide" : "asks" });
    if (sc.acpSessionId && sc.agent?.id === agent.id) saved.push({ id: sc.acpSessionId, from: "guide" });
    const relay = await this.host.relayHost();
    const headFiles = [...reader.model.files.keys()];
    const session = new GuideAskSession({ guideId: guide.id, cwd, saved }, {
      relay,
      agent,
      agentLaunch: (dir) => agentLaunchFor(launch, dir),
      mcpServer: {
        command: process.execPath,
        args: [vscode.Uri.joinPath(this.host.context.extensionUri, "dist", "guide-mcp.cjs").fsPath],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
      clientInfo: { name: "plannotator-vscode", title: "Plannotator", version: this.host.version },
      linkHooks: {
        chapterCount: reader.model.chapters.length,
        fileExists: async (p) => reader.model.files.has(p) || (reader.sides.head.kind === "fs" && existsSync(join(cwd, p))),
        resolveSymbol: (name, path) => resolveSymbolForBuilder(name, path, cwd, headFiles),
      },
      requestPermission: (pending, signal) => this.host.notifyPermission(pending, signal, agent.label),
      approveAlways: () => this.host.approveAlways(),
      log: (line) => this.host.log(line),
    });
    this.sessions.set(guide.id, session);
    return session;
  }

  private async headSha(guide: LoadedGuide, cwd: string): Promise<string | null> {
    const source = guide.sidecar.source;
    if (source?.kind === "pr") return source.headSha;
    const r = await this.host.runner("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 10_000 }).catch(() => null);
    return r && r.code === 0 ? r.stdout.trim() : guide.envelope.headSha ?? null;
  }

  private finished(guide: LoadedGuide, live: LiveAsk, state: AskRunState, session: GuideAskSession): void {
    const record = live.record;
    record.status = state.status === "starting" || state.status === "working" ? "stopped" : state.status;
    record.answeredAt = state.endedAt ?? Date.now();
    if (state.answer) {
      record.title = state.answer.title;
      record.html = state.answer.html;
    }
    if (state.text) record.text = state.text;
    if (state.statusMessage) record.statusMessage = state.statusMessage;
    if (state.cost) record.cost = state.cost;
    if (state.session) record.session = state.session;
    const model = state.appliedModel ? { model: { id: record.agent.model?.id ?? state.appliedModel, label: state.appliedModel } } : {};
    const effort = state.appliedEffort ? { effort: { id: record.agent.effort?.id ?? state.appliedEffort, label: state.appliedEffort } } : {};
    record.agent = { ...record.agent, ...model, ...effort };
    const panel = this.panelShowing(record.id);
    record.seen = !!panel?.panel.visible;
    this.live.delete(record.id);
    this.host.setAnswering(null, null);
    // Deleted while it was being answered (the answer, or its guide): nothing is written back.
    if (!this.save(record, guide)) {
      this.host.updateChapterView();
      return;
    }
    // Remember the session, so a later window loads it when the agent can.
    if (session.askSessionId && !this.shelf.isGuideDeleted(guide.id)) {
      guide.sidecar.askSession = { id: session.askSessionId, agent: session.agentId };
      if (this.host.persists(guide)) writeSidecar(guide.repoKey, guide.id, guide.sidecar);
    }
    if (panel) {
      panel.panel.title = tabTitle(record.question, false);
      void this.showRecord(panel, record);
    }
    this.host.updateChapterView();
    if (state.signIn) {
      const logins = state.signIn.logins;
      void vscode.window.showErrorMessage(`${record.agent.label} is not signed in. Sign in in a terminal, then ask again.`, ...(logins.length ? logins.map((l) => l.label) : ["Sign in"])).then((label) => {
        if (label) void this.host.signIn(record.agent.id, logins, label, session.input.cwd);
      });
    } else if (!panel?.panel.visible && (record.status === "answered" || record.status === "text")) {
      void vscode.window.showInformationMessage(`Answer ready: ${record.question}`, "Open").then((c) => {
        if (c) void this.openAnswer(record.id);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // The answer tab
  // ---------------------------------------------------------------------------

  private panelShowing(answerId: string): AnswerPanel | null {
    for (const p of this.panels) if (p.current === answerId) return p;
    return null;
  }

  private panelFor(record: AnswerRecord, codeColumn: vscode.ViewColumn | undefined, preserveFocus = false): AnswerPanel {
    const existing = this.panelShowing(record.id);
    if (existing) return existing;
    // Later answers reuse the right-hand group the first one opened in.
    const column = this.answerColumn && [...this.panels].some((p) => p.panel.viewColumn === this.answerColumn) ? this.answerColumn : vscode.ViewColumn.Beside;
    let entry: AnswerPanel;
    const base = this.host.createPanel(tabTitle(record.question, record.status === "answering"), column, (link) => void this.openAnswerLink(entry, link), preserveFocus);
    entry = { ...base, current: record.id, guideId: record.guideId, repoKey: record.repoKey, codeColumn };
    this.panels.add(entry);
    entry.panel.onDidDispose(() => this.panels.delete(entry));
    entry.panel.onDidChangeViewState(() => {
      if (entry.panel.viewColumn) this.answerColumn = entry.panel.viewColumn;
    });
    if (entry.panel.viewColumn) this.answerColumn = entry.panel.viewColumn;
    return entry;
  }

  private showLive(live: LiveAsk, state: AskRunState): void {
    const panel = this.panelShowing(live.record.id);
    if (!panel) return;
    panel.host.show(answerViewState({ record: live.record, run: state, now: Date.now(), followUpOf: this.followUpOf(live.record), busy: true }));
  }

  private followUpOf(record: AnswerRecord): { id: string; question: string } | null {
    if (!record.followUpOf) return null;
    const reader = this.host.reader();
    const prev = reader && reader.model.id === record.guideId ? this.find(reader.model.loaded, record.followUpOf) : null;
    return prev ? { id: prev.id, question: prev.question } : null;
  }

  private async showRecord(panel: AnswerPanel, record: AnswerRecord): Promise<void> {
    const live = this.live.get(record.id);
    if (live) return this.showLive(live, live.run.state);
    const reader = this.host.reader();
    const stale = reader && reader.model.id === record.guideId
      ? staleNote(record, { ...this.currentHashes(reader, record), headSha: await this.headSha(reader.model.loaded, reader.sides.head.kind === "fs" ? reader.sides.head.root : reader.sides.gitRoot) })
      : null;
    panel.host.show(answerViewState({ record, now: Date.now(), stale, followUpOf: this.followUpOf(record), busy: this.isBusy(record.guideId) }));
  }

  /** Open an answer of the open guide in its tab (beside the diff). */
  async openAnswer(id: string | undefined): Promise<void> {
    const reader = this.host.reader();
    if (!id || !reader) return;
    const guide = reader.model.loaded;
    const record = this.find(guide, id);
    if (!record) {
      void vscode.window.showWarningMessage("That answer is gone.");
      return;
    }
    const panel = this.panelFor(record, vscode.window.activeTextEditor?.viewColumn);
    panel.current = record.id;
    panel.panel.title = tabTitle(record.question, record.status === "answering" && this.live.has(record.id));
    panel.panel.reveal(panel.panel.viewColumn, false);
    if (!record.seen && !this.live.has(record.id)) {
      record.seen = true;
      this.save(record, guide);
      this.host.updateChapterView();
    }
    await this.showRecord(panel, record);
  }

  /** A link in an answer page: open the guide it belongs to first, then the link, in the diff's editor group. */
  private async openAnswerLink(panel: AnswerPanel, link: string): Promise<void> {
    if (this.host.reader()?.model.id !== panel.guideId) await this.host.openGuide(panel.guideId);
    await this.host.openLink(link, panel.codeColumn ?? vscode.ViewColumn.One);
  }

  async followUp(answerId: string | undefined, text: string | undefined): Promise<void> {
    const reader = this.host.reader();
    const question = text?.trim().slice(0, MAX_QUESTION);
    if (!reader || !answerId || !question) return;
    const prev = this.find(reader.model.loaded, answerId);
    if (!prev) return;
    await this.ask(reader.model.loaded, prev.about, question, { followUpOf: prev, codeColumn: this.panelShowing(answerId)?.codeColumn, ...(this.panelShowing(answerId) && { panel: this.panelShowing(answerId)! }) });
  }

  async stop(answerId: string | undefined): Promise<void> {
    if (!answerId) return;
    await this.live.get(answerId)?.run.cancel();
  }

  /** The tab's "…": ask again, delete (after a confirm), copy the question. `again` (the tab's button) asks again at once. */
  async menu(answerId: string | undefined, action?: string): Promise<void> {
    const reader = this.host.reader();
    if (!reader || !answerId) return;
    const guide = reader.model.loaded;
    const record = this.find(guide, answerId);
    if (!record) return;
    const pick = action === "again" ? action : (await vscode.window.showQuickPick([
      { label: "$(refresh) Ask again", value: "again" },
      { label: "$(copy) Copy the question", value: "copy" },
      { label: "$(trash) Delete this answer", value: "delete" },
    ], { title: record.question }))?.value;
    if (pick === "again") return void await this.ask(guide, record.about, record.question, { codeColumn: this.panelShowing(record.id)?.codeColumn, ...(this.panelShowing(record.id) && { panel: this.panelShowing(record.id)! }) });
    if (pick === "copy") return void vscode.env.clipboard.writeText(record.question);
    if (pick === "delete") {
      const sure = await vscode.window.showWarningMessage(`Delete the answer to “${record.question}”?`, { modal: true }, "Delete");
      if (sure !== "Delete") return;
      // Marked deleted first, so a run still answering it does not write it back when it ends.
      this.shelf.remove(record, this.host.persists(guide));
      if (this.live.has(record.id)) await this.stop(record.id);
      this.panelShowing(record.id)?.panel.dispose();
      this.host.updateChapterView();
    }
  }

  /** A web link in an answer page: the agent wrote it, so ask before opening it. */
  async openExternal(url: string | undefined): Promise<void> {
    if (!url || !/^https?:\/\//i.test(url)) return;
    const choice = await vscode.window.showInformationMessage(`The answer links to ${url}. Open it in your browser?`, "Open");
    if (choice === "Open") await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /** Permission answers from an answer tab; false when the id is not an answer being asked. */
  answerPermission(answerId: string | undefined, id: number | undefined, optionId: string | undefined): boolean {
    const live = answerId ? this.live.get(answerId) : undefined;
    if (!live) return false;
    if (id !== undefined && optionId) live.run.answerPermission(id, { optionId });
    return true;
  }

  /** Whether this answer's run is waiting on the user for this permission request. */
  hasPendingPermission(answerId: string | undefined, id: number | undefined): boolean {
    const live = answerId ? this.live.get(answerId) : undefined;
    return !!live && live.run.live && id !== undefined && live.run.state.pendingPermissions.some((p) => p.id === id);
  }

  approveRun(answerId: string | undefined): boolean {
    const live = answerId ? this.live.get(answerId) : undefined;
    if (!live) return false;
    live.run.approveAutomatically();
    return true;
  }

  /** The guide was deleted: its conversation and answers go too. */
  onGuideDeleted(repoKey: string, guideId: string): void {
    // Marked first: a question still being answered must not write its answer or the sidecar back.
    this.shelf.removeGuide(repoKey, guideId);
    this.sessions.get(guideId)?.dispose();
    this.sessions.delete(guideId);
    for (const p of [...this.panels]) if (p.guideId === guideId) p.panel.dispose();
  }

  /** The reader opened another guide, or closed. */
  onReaderChanged(_guideId: string | null): void {}

  dispose(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }

  /** VS Code is closing. */
  kill(): void {
    for (const s of this.sessions.values()) s.kill();
  }
}

function modelEffortLabel(choice: AgentChoiceRecord): string {
  return [choice.model?.label ?? "agent default", choice.effort?.label].filter(Boolean).join(" · ");
}

function tabTitle(question: string, answering: boolean): string {
  const q = question.length > 42 ? `${question.slice(0, 40)}…` : question;
  return `${answering ? "Answering: " : "Answer: "}${q}`;
}

/** The guide as the prompt tells it, and where the change is. */
function guideContext(guide: LoadedGuide, reader: { model: ReaderModel; sides: ReaderSides }, cwd: string): AskGuideContext {
  const env = guide.envelope;
  const source = guide.sidecar.source;
  const changeLabel = source?.kind === "pr" && source.pr
    ? `pull request #${source.pr.number}, “${source.pr.title}” (${source.pr.url})`
    : env.review?.source.pr ? `pull request #${env.review.source.pr.number}${env.review.source.pr.url ? ` (${env.review.source.pr.url})` : ""}`
      : `the local changes${source?.branch ? ` on ${source.branch}` : ""} (${env.label || basename(cwd)})`;
  return {
    title: env.title,
    intent: env.guide.intent,
    chapters: reader.model.chapters.map((c) => ({ title: c.title, overview: c.overview, files: c.files.map((f) => f.path) })),
    changeLabel,
    cwd,
    baseRev: reader.sides.baseRev,
    rawPatch: guide.rawPatch ?? "",
  };
}
