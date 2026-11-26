/**
 * The window reads Reviews once more when a ship it drew turns merged (shipMergedRead.ts). What regresses: the merged
 * PR's row missing until the next timed read (about 2 minutes), or Reviews read again on every ships read.
 */
import { expect, test } from 'bun:test';
import type { InboxShipView } from '@plannotator/core/inbox-pull-handoff';
import { shipTurnedMerged } from './shipMergedRead';

const KEY = 'github.com/harbor/fern-api#614';
const ship = (state: InboxShipView['state']): Map<string, InboxShipView> =>
  new Map([[KEY, { id: 'shp_614', key: KEY, url: 'https://github.com/harbor/fern-api/pull/614', title: 'Send a receipt', number: 614, repo: 'harbor/fern-api', host: 'github.com', thread_id: 'thr_receipt', project_id: 'prj_fern', agent: { host: 'claude-code', session: 'ses_a', name: 'Claude Code' }, started_at: '2026-11-24T15:00:00.000Z', state, reason: null, ended_at: state === 'merged' ? '2026-11-24T17:00:00.000Z' : null, merged_at: null }]]);

test('a ship going, then merged: read Reviews once; merged already, or first seen merged: not again', () => {
  expect(shipTurnedMerged(ship('shipping'), ship('merged'))).toBe(true);
  expect(shipTurnedMerged(ship('stuck'), ship('merged'))).toBe(true);
  expect(shipTurnedMerged(ship('merged'), ship('merged'))).toBe(false);
  expect(shipTurnedMerged(new Map(), ship('merged'))).toBe(false);
  expect(shipTurnedMerged(ship('shipping'), ship('shipping'))).toBe(false);
  expect(shipTurnedMerged(ship('shipping'), ship('stopped'))).toBe(false);
});
