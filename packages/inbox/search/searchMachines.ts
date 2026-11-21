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

export function keepingRow(model: SearchModel, option: SearchOption | undefined): SearchModel {
  if (option?.kind !== 'row') return model;
  const { group, row } = option;
  const has = (rows: readonly { id: string; type: string }[] | null | undefined) => (rows ?? []).some((one) => one.id === row.id && one.type === row.type);
  if (group === 'recent') return !model.recent || has(model.recent) || row.type !== 'thread' ? model : { ...model, recent: [...model.recent, row] };
  if (!model.groups || has(model.groups[group])) return model;
  return { ...model, groups: { ...model.groups, [group]: [...(model.groups[group] ?? []), row] } };
}

export function unansweredWords(names: readonly string[]): string {
  const list = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} didn’t answer`;
}
