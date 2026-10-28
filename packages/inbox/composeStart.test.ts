/**
 * Compose's "New Grok Build session" rows (the ACP runner): which
 * agents and folders the To picker offers, and how To names one.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxRunAgentsModel } from '@plannotator/core/inbox-acp';
import { findStartChoice, isStartChoiceId, START_CHOICES_SHOWN, startChoiceId, startChoices } from './compose/model';

const place = (n: number) => ({ project_id: `prj_${n}`, name: `proj-${n}`, root: `/code/proj-${n}`, root_display: `~/code/proj-${n}` });
const model = (over: Partial<InboxRunAgentsModel['agents'][number]> = {}): InboxRunAgentsModel => ({
  agents: [{ id: 'grok', label: 'Grok Build', installed: true, reason: null, enabled: true, install_command: 'curl …', self_updates: true, ...over }],
  places: [1, 2, 3, 4, 5, 6].map(place),
});

describe('start choices', () => {
  test('the current project first, then the most recent, a few before typing; a filter searches every folder', () => {
    const rows = startChoices(model(), { id: 'prj_5', root: null });
    expect(rows.map((r) => r.place.project_id)).toEqual(['prj_5', 'prj_1', 'prj_2', 'prj_3']);
    expect(rows).toHaveLength(START_CHOICES_SHOWN);
    expect(startChoices(model(), null, 'proj-6').map((r) => r.id)).toEqual([startChoiceId('grok', 'prj_6')]);
    expect(startChoices(model(), null, 'grok').length).toBe(6);
  });

  test('an agent not installed, or turned off, offers nothing; an older Inbox (no model) neither', () => {
    expect(startChoices(model({ installed: false }), null)).toEqual([]);
    expect(startChoices(model({ enabled: false }), null)).toEqual([]);
    expect(startChoices(null, null)).toEqual([]);
  });

  test('To names a start row by its own id, never a live session id', () => {
    const id = startChoiceId('grok', 'prj_2');
    expect(isStartChoiceId(id)).toBe(true);
    expect(isStartChoiceId('run_01HZY3T5R4M2Q8W9X6V7B1N0KP')).toBe(false);
    expect(findStartChoice(model(), id)?.place.name).toBe('proj-2');
    expect(findStartChoice(model({ enabled: false }), id)).toBeNull();
  });
});
