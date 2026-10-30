/**
 * What the answer tab and the Guide tab's answer list show, from a saved
 * answer and, while it is being answered, the live run. No `vscode` here.
 */

import type { ActivityRow, AnswerListItem, AnswerViewState } from "../webview-protocol";
import type { AnswerRecord, AskAbout } from "./answers";
import type { AskRunState } from "./session";

function base(path: string): string {
  return path.split("/").pop() ?? path;
}

function linesLabel(lines: { start: number; end: number }): string {
  return lines.start === lines.end ? `${lines.start}` : `${lines.start}–${lines.end}`;
}

/** The path the lines asked about have on their side: the old path of a renamed file on the old side. */
function shownPath(about: AskAbout): string {
  return about.side === "base" && about.oldPath ? about.oldPath : about.path ?? "";
}

/** "deliver.ts · lines 25–31", "deliver.ts", "Chapter 2". */
export function aboutShort(about: AskAbout): string {
  if (about.kind === "chapter" || !about.path) return `Chapter ${about.chapter + 1}`;
  if (about.kind === "selection" && about.lines) return `${base(shownPath(about))} · ${about.lines.start === about.lines.end ? "line" : "lines"} ${linesLabel(about.lines)}${about.side === "base" ? " (old)" : ""}`;
  return base(about.path);
}

/** "deliver.ts · lines 25–31" for the question box title; "chapter 2" for a chapter. */
export function aboutTitle(about: AskAbout): string {
  return about.kind === "chapter" || !about.path ? `chapter ${about.chapter + 1}` : aboutShort(about);
}

/** What goes with the question, for the question box's last line. */
export function goesWith(about: AskAbout): string[] {
  const out: string[] = [];
  if (about.kind === "selection" && about.path && about.lines) out.push(`${base(about.path)} ${linesLabel(about.lines)}`);
  if (about.kind !== "chapter" && about.path) out.push(about.kind === "file" ? `${base(about.path)} and its diff` : "the file's diff");
  if (about.kind === "chapter") out.push(`Chapter ${about.chapter + 1}, its overview and its files' diffs`);
  else out.push(`Chapter ${about.chapter + 1}`);
  out.push("the guide");
  return out;
}

export function relativeTimeShort(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d`;
}

function relativeTimeLong(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function money(cost: { amount: number } | undefined): string | null {
  return cost ? `$${cost.amount.toFixed(2)}` : null;
}

function fmt(ms: number): string {
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
}

export function activityRows(state: AskRunState): ActivityRow[] {
  return state.activity.map((a) => ({ id: a.id, at: fmt(a.at), kind: a.kind, title: a.title, ...(a.detail && { detail: a.detail }), ...(a.status && { status: a.status }), ...(a.isError && { isError: true }), ...(a.locations && { locations: a.locations }) }));
}

export interface AnswerViewInput {
  record: AnswerRecord;
  /** The live run, while it answers (or just after). */
  run?: AskRunState | null;
  followUpOf?: { id: string; question: string } | null;
  stale?: string | null;
  /** Another question of this guide is being answered (no follow-up until it ends). */
  busy?: boolean;
  now: number;
}

export function answerViewState(input: AnswerViewInput): AnswerViewState {
  const { record, run, now } = input;
  const status = run && (run.status === "starting" || run.status === "working") ? "answering" : record.status;
  const about = record.about;
  const where = about.kind === "chapter" || !about.path ? `Chapter ${about.chapter + 1}` : `Chapter ${about.chapter + 1} · ${aboutShort(about).replace(" · lines ", " ").replace(" · line ", " ")}`;
  const model = run?.appliedModel ?? record.agent.model?.label;
  const effort = run?.appliedEffort ?? record.agent.effort?.label;
  const elapsed = record.answeredAt ? `${Math.max(1, Math.round((record.answeredAt - record.askedAt) / 1000))}s` : null;
  const cost = money(run?.cost ?? record.cost);
  const meta = [record.agent.label, model, effort?.toLowerCase(), status === "answering" ? null : elapsed, status === "answering" ? null : cost, relativeTimeLong(record.answeredAt ?? record.askedAt, now)].filter(Boolean).join(" · ");
  const jump = about.kind === "chapter" || !about.path
    ? { label: `Chapter ${about.chapter + 1}`, link: `chapter:${about.chapter + 1}` }
    : about.kind === "selection" && about.lines && about.side !== "base"
      ? { label: `Lines ${linesLabel(about.lines)}`, link: `code:${about.path}#L${about.lines.start}${about.lines.end !== about.lines.start ? `-L${about.lines.end}` : ""}` }
      : { label: base(about.path), link: `code:${about.path}` };
  const quote = about.kind === "selection" && about.code && about.lines
    ? { header: `${shownPath(about)} · ${about.lines.start === about.lines.end ? "line" : "lines"} ${linesLabel(about.lines)}${about.side === "base" ? " · old version" : record.headSha ? ` · head ${record.headSha.slice(0, 7)}` : ""}`, start: about.lines.start, lines: about.code.split("\n").slice(0, 40) }
    : null;
  const page = run?.answer ?? (record.html && record.title ? { title: record.title, html: record.html } : null);
  return {
    mode: "answer",
    id: record.id,
    question: record.question,
    kicker: `Answer · ${where}`,
    agent: record.agent.label,
    meta,
    jump,
    quote,
    status: status === "answering" ? "answering" : page && status === "answered" ? "answered" : status,
    statusMessage: run?.statusMessage ?? record.statusMessage ?? null,
    startedAt: run?.startedAt ?? record.askedAt,
    endedAt: run?.endedAt ?? record.answeredAt ?? null,
    cost,
    activity: run ? activityRows(run) : [],
    stream: run?.stream ?? "",
    page,
    text: run?.text ?? record.text ?? null,
    stale: input.stale ?? null,
    followUpOf: input.followUpOf ?? null,
    canFollowUp: status !== "answering" && !input.busy,
    pendingPermissions: (run?.pendingPermissions ?? []).map((p) => ({ id: p.id, title: p.title, kind: p.kind ?? null, target: p.target ?? null, options: p.options })),
    offerAutoApprove: !!run?.offerAutoApprove && !run?.autoApprove,
    approvals: { auto: !!run?.autoApprove, mode: run?.permissiveMode ?? null },
    signIn: run?.signIn ? (run.signIn.logins.length ? run.signIn.logins.map((l) => l.label) : ["Sign in"]) : null,
  };
}

export function answerListItem(record: AnswerRecord, now: number, live: boolean): AnswerListItem {
  return {
    id: record.id,
    question: record.question,
    sub: record.about.kind === "chapter" ? `Chapter ${record.about.chapter + 1}` : aboutShort(record.about),
    when: live ? "answering" : relativeTimeShort(record.answeredAt ?? record.askedAt, now),
    isNew: !record.seen && record.status !== "answering",
    status: live ? "answering" : record.status,
  };
}

/** "Claude Code · Sonnet · low · answers $0.05" under a chapter's answers. */
export function answersFooter(records: readonly AnswerRecord[]): string | undefined {
  if (!records.length) return undefined;
  const last = records[0];
  const total = records.reduce((sum, r) => sum + (r.cost?.amount ?? 0), 0);
  return [last.agent.label, last.agent.model?.label, last.agent.effort?.label.toLowerCase(), total > 0 ? `answers $${total.toFixed(2)}` : null].filter(Boolean).join(" · ");
}
