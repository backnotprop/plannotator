/** Test fixtures: a routine's row as `GET /api/inbox/scheduled` answers it. Tests only. */
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';

export function scheduledRow(id: string, change: Partial<InboxScheduledRow> = {}): InboxScheduledRow {
  return {
    id,
    name: `Scheduled ${id}`,
    enabled: true,
    approved_at: '2026-11-01T09:00:00.000Z',
    prompt: 'Summarize the open pull requests.',
    schedule: { cron: '0 9 * * 1-5', tz: 'America/New_York' },
    if_missed: 'run_once',
    runs_on: 'this_computer',
    folder: { project_id: 'prj_api' },
    agent: 'claude-code',
    attachments: [],
    thread_id: null,
    handled_through: null,
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-01T09:00:00.000Z',
    state: 'on',
    schedule_words: 'Every weekday at 9:00 AM',
    tz_short: 'EST',
    next_run: '2026-11-16T14:00:00.000Z',
    runs: 0,
    last_run: null,
    running_since: null,
    folder_shown: '~/code/acme-api',
    project_name: 'acme-api',
    thread_name: null,
    last_change: null,
    ...change,
  };
}

export const lastRun = (run: number, startedAt: string, outcome: NonNullable<InboxScheduledRow['last_run']>['outcome'] = 'replied'): NonNullable<InboxScheduledRow['last_run']> => ({
  message_id: `msg_run${run}`,
  run,
  due_at: startedAt,
  started_at: startedAt,
  late: false,
  outcome,
});
