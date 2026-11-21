import type { SearchModel } from '../api';
import { machineOf, selfMachineId } from '../inboxUrl';
import type { SearchFilters, SearchOption } from './model';

export type SearchPasses = 'local' | 'merged' | 'both';

export function searchPasses(filters: Pick<SearchFilters, 'project' | 'tags'>): SearchPasses {
  if (!selfMachineId()) return 'local';
  if (filters.project) return machineOf(filters.project) ? 'merged' : 'local';
  return filters.tags.length > 0 ? 'local' : 'both';
}

export function optionKey(option: SearchOption): string {
  switch (option.kind) {
    case 'row':
      return `row-${option.group}-${option.row.type}-${option.row.id}`;
    case 'more':
      return `more-${option.group}`;
    case 'recent-q':
      return `q-${option.q}`;
    case 'shape':
      return `shape-${option.shape.id}`;
    case 'action':
      return option.action.kind !== 'message' ? `action-${option.action.kind}` : `action-${option.action.target.session}`;
  }
}

export function keepingRow(model: SearchModel, option: SearchOption | undefined, before: SearchModel): SearchModel {
  if (option?.kind !== 'row') return model;
  const { group, row } = option;
  const same = (one: { id: string; type: string }) => one.id === row.id && one.type === row.type;
  const kept = <T extends { id: string; type: string }>(rows: readonly T[], was: readonly T[] | null | undefined): T[] => {
    if (rows.some(same)) return [...rows];
    const at = Math.max(0, (was ?? []).findIndex(same));
    return [...rows.slice(0, at), row as T, ...rows.slice(at)];
  };
  if (group === 'recent') return model.recent && row.type === 'thread' ? { ...model, recent: kept(model.recent, before.recent) } : model;
  if (!model.groups) return model;
  return { ...model, groups: { ...model.groups, [group]: kept(model.groups[group] ?? [], before.groups?.[group]) } };
}

export function unansweredWords(names: readonly string[]): string {
  const list = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} didn’t answer`;
}
