import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { ProjectFolder } from './api';
import { agentName, plural, shortAgentName } from './format';
import { offersRowMarkRead } from './markRead';

export type ProjectAction = 'read' | 'archive';

export function shownProjects(projects: readonly ProjectFolder[], held: string | null): ProjectFolder[] {
  return projects.filter((project) => project.listed === undefined || project.listed > 0 || project.id === held);
}

export function projectAllArchived(project: ProjectFolder | null): boolean {
  return project !== null && project.listed === 0 && (project.archived ?? 0) > 0;
}

export function projectsWithReadable(sections: readonly InboxListSection[]): Set<string> {
  const out = new Set<string>();
  for (const section of sections) for (const row of section.threads) if (offersRowMarkRead(row)) out.add(row.project.id);
  return out;
}

export interface ProjectBatchToast {
  lead: string;
  phoneLead: string;
  detail: string;
  phoneDetail?: string;
  speech: string;
  icon: 'warn' | 'check' | 'archive';
}

export function projectBatchToast(action: ProjectAction, projectName: string, taken: number, rows: readonly InboxListRow[]): ProjectBatchToast {
  const threads = plural(taken, 'thread');
  const questions = rows.reduce((sum, row) => sum + row.questions.open + row.questions.picked, 0);
  const stopped = rows.filter((row) => row.questions.stopped && row.questions.open > 0);
  const holds = rows.reduce((sum, row) => sum + (row.questions.open > 0 ? row.questions.holds_up.length : 0), 0);
  let warning = '';
  let said = '';
  let phoneDetail: string | undefined;
  if (stopped.length === 1) {
    warning = `${shortAgentName(agentName(stopped[0]!.author))} was stopped`;
    phoneDetail = `Stopped · ${shortAgentName(agentName(stopped[0]!.author))}`;
    said = `${agentName(stopped[0]!.author)} was stopped`;
  }
  else if (stopped.length > 1) warning = `${stopped.length} agents were stopped`;
  else if (holds > 0) warning = `Held up ${plural(holds, 'thing')}`;
  const closed = questions > 0 ? `Closed ${plural(questions, 'question')}` : '';
  const why = warning || closed;
  const back = action === 'read' ? 'Back when an agent writes' : 'Back when an agent writes there';
  const lead = action === 'read' ? `Marked ${threads} read` : `Archived ${threads}`;
  const detail = why || projectName;
  const speech = `${lead} in ${projectName}. ${said || why || back}.`;
  const phone = phoneDetail ? { phoneDetail } : {};
  if (action === 'read') return { lead, phoneLead: `${threads} read`, detail, ...phone, speech, icon: warning ? 'warn' : 'check' };
  return { lead, phoneLead: `Archived ${threads}`, detail, ...phone, speech, icon: warning ? 'warn' : 'archive' };
}

export function newBatchId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `b-${random}`;
}
