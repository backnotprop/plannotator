import type { InboxSearchRow } from '@plannotator/core/inbox-search';
import { machineOf, selfMachineId } from '../inboxUrl';
import { awayLine } from '../machines';
import type { MachineView, SearchModel } from '../api';
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
  const same = (one: InboxSearchRow) => one.id === row.id && one.type === row.type;
  const kept = <T extends InboxSearchRow>(rows: readonly T[], was: readonly T[] | null | undefined, mine: T): T[] => {
    if (rows.some(same)) return [...rows];
    const at = Math.max(0, (was ?? []).findIndex(same));
    return [...rows.slice(0, at), mine, ...rows.slice(at)];
  };
  if (group === 'recent') return model.recent && row.type === 'thread' ? { ...model, recent: kept(model.recent, before.recent, row) } : model;
  if (!model.groups) return model;
  return { ...model, groups: { ...model.groups, [group]: kept(model.groups[group] ?? [], before.groups?.[group], row) } };
}

export function unansweredWords(missing: readonly { id: string; name: string }[], linked: readonly MachineView[] = []): string {
  const away = missing.map((one) => linked.find((machine) => machine.id === one.id)).map((machine) => (machine ? awayLine(machine, null) : null));
  const silent = missing.filter((_, at) => !away[at]).map((one) => one.name);
  const list = silent.length < 2 ? silent.join('') : `${silent.slice(0, -1).join(', ')} and ${silent.at(-1)}`;
  return [...away.filter((words): words is string => Boolean(words)), ...(list ? [`${list} didn’t answer`] : [])].join(' · ');
}
