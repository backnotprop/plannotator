/**
 * `?board=charts`: twelve charts as chart objects, each rows and an encoding and nothing else. They are
 * the charts the exploration boards drew as hand-written markup or as pictures (a field synthesizer's
 * firmware release, a field test with eight players, an ideas wall), said again as data. Invented
 * numbers, worked out here so the charts agree with each other. Built with commands, as an agent would.
 */
import { CanvasStore } from '../events/store';
import type { Command } from '../events/types';
import { createDocument } from '../model/document';
import type { CanvasObject, ChartCell } from '../model/types';
import { serializeSnapshotBlock } from '../snapshot/block';

const AGENT = { kind: 'agent', id: 'demo-agent' } as const;
const ANA = { kind: 'person', id: 'ana' } as const;

/** The same small generator every time, so the board is the same board on every load. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Firmware 2.0: tests still failing at the end of each week. 180 at the start, 20 a week planned, week 6 is now.
const BURN = [180, 171, 150, 138, 110, 92, 76];
const RATE = Math.round((BURN[3] - BURN[6]) / 3);
const burnRows: ChartCell[][] = [
  ...BURN.map((failing, week) => [week, 'failing', failing]),
  ...Array.from({ length: 10 }, (_, week) => [week, 'plan', Math.max(0, 180 - week * 20)]),
  ...[6, 7, 8, 9].map((week) => [week, 'at this rate', Math.max(0, BURN[6] - (week - 6) * RATE)]),
];

// Four lanes over nine weeks: what is done, under way and waiting on a part.
const ladderRows: ChartCell[][] = [
  ['Firmware', 0, 6, 'done'], ['Firmware', 6, 7, 'under way'],
  ['Hardware', 0, 3, 'done'], ['Hardware', 5, 7, 'waiting on a part'],
  ['Test', 1, 6, 'done'], ['Test', 6, 7, 'under way'],
  ['Docs', 3, 5, 'done'], ['Docs', 5, 7, 'under way'],
];

// The field test: eight players, one hour each.
const KNOBS = ['Pitch', 'Fold', 'Cutoff', 'Res', 'Attack', 'Decay', 'Noise', 'Level', 'Rate', 'Depth', 'Swing', 'Wow', 'Pan', 'Send'];
const TOUCHES = [212, 388, 451, 97, 41, 163, 72, 304, 118, 66, 59, 23, 88, 9];
const PLAYERS = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08'];
const KINDS = ['keys', 'knobs', 'menu', 'idle'] as const;
/** One hour a player, minute by minute. Only p03 and p07 open the menu. */
const SESSIONS = PLAYERS.map((_player, p) => {
  const random = seeded(300 + p);
  let state: (typeof KINDS)[number] = 'keys';
  return Array.from({ length: 60 }, (_minute, m) => {
    const roll = random();
    if (roll < 0.34) state = roll < 0.05 ? 'idle' : roll < 0.19 ? 'keys' : 'knobs';
    if ((p === 2 || p === 6) && (m === 14 + p || m === 15 + p || m === 41)) return 'menu';
    return m < 2 ? 'keys' : state;
  });
});
const sessionRows: ChartCell[][] = SESSIONS.flatMap((minutes, p) => minutes.map((kind, m) => [m + 1, PLAYERS[p], kind]));
const heatRows: ChartCell[][] = SESSIONS.flatMap((minutes, p) =>
  Array.from({ length: 12 }, (_bin, b) => [`${b * 5}`, PLAYERS[p], minutes.slice(b * 5, b * 5 + 5).filter((kind) => kind === 'knobs').length]),
);
const multipleRows: ChartCell[][] = SESSIONS.flatMap((minutes, p) => KINDS.map((kind) => [PLAYERS[p], kind, minutes.filter((minute) => minute === kind).length]));

// The ideas wall: 28 notes in five clusters, 53 votes.
const CLUSTERS: [string, number, number][] = [['Play it live', 7, 16], ['Learn it fast', 6, 13], ['Carry it', 6, 11], ['Fix it yourself', 5, 8], ['Share a pattern', 4, 5]];
const voteRows: ChartCell[][] = CLUSTERS.map(([name, _ideas, votes]) => [name, votes]);
const ideaRows: ChartCell[][] = (() => {
  const random = seeded(53);
  const centres = [[24, 70], [62, 78], [78, 36], [36, 28], [56, 52]];
  return CLUSTERS.flatMap(([name, ideas, votes], c) => {
    // The cluster's votes shared among its notes, most to the first.
    const shares = Array.from({ length: ideas }, (_note, i) => ideas - i);
    const sum = shares.reduce((a, b) => a + b, 0);
    let left = votes;
    return shares.map((share, i) => {
      const own = i === ideas - 1 ? left : Math.round((votes * share) / sum);
      left -= own;
      return [Math.round(centres[c][0] + (random() - 0.5) * 26), Math.round(centres[c][1] + (random() - 0.5) * 22), name, Math.max(0, own)];
    });
  });
})();

// The teardown: what becomes of the old instrument's twelve parts.
const partRows: ChartCell[][] = [['parts', 'kept', 8], ['parts', 'changed', 2], ['parts', 'dropped', 2]];

// Three engines: what each costs to build. The gate is the most the bill of materials allows.
const engineRows: ChartCell[][] = [['Wavefold', 9.4], ['Phase', 12.8], ['Sample', 17.1]];

// The night the relay was heard: who was on which task, hour by hour after 18:00.
const nightRows: ChartCell[][] = [
  ['Dish', 0, 4.5, 'listening'], ['Dish', 4.5, 6, 'locked'], ['Dish', 6, 13, 'listening'],
  ['Decode', 4.5, 9, 'working'], ['Decode', 8, 9.5, 'locked'],
  ['Log', 0, 13, 'listening'],
  ['Crew', 2, 3, 'working'], ['Crew', 4.5, 10, 'working'],
];

export const CHARTS_CANVAS_ID = 'charts';

const block = (snapshot: string) => serializeSnapshotBlock({ canvas: CHARTS_CANVAS_ID, snapshot });

export const CHARTS_PLAN = `# Charts as data

Every chart on the board behind this plan is a small table and an encoding. Nobody drew one.

## The release

Tests still failing, against the plan and against the rate of the last three weeks.

${block('release')}

## The field test

Eight players, one hour each: what they touched, and when.

${block('field-test')}
`;

const W = 520;
const H = 320;
const at = (col: number, row: number) => ({ x: 60 + col * (W + 40), y: 110 + row * (H + 40), w: W, h: H });

export function createChartsStore(): CanvasStore {
  const store = new CanvasStore(createDocument(CHARTS_CANVAS_ID, 'Charts as data'));
  const add = (objects: unknown[], actor: { kind: 'agent' | 'person'; id: string } = AGENT) => {
    const result = store.dispatch({ type: 'add', objects: objects as CanvasObject[] } as Command, { actor });
    if (!result.ok) throw new Error(result.error);
  };
  add([
    { id: 'f-release', type: 'frame', x: 20, y: 60, w: 3 * (W + 40) + 40, h: 2 * (H + 40) + 50, title: 'Firmware 2.0: the release' },
    { id: 'f-test', type: 'frame', x: 20, y: 60 + 2 * (H + 40) + 110, w: 3 * (W + 40) + 40, h: 2 * (H + 40) + 50, title: 'The field test: eight players, one hour each' },
    { id: 'burn', type: 'chart', ...at(0, 0), mark: 'line', title: 'Tests still failing', fields: ['week', 'line', 'tests'], rows: burnRows, encode: { x: 'week', y: 'tests', series: 'line' }, dash: ['plan', 'at this rate'], rules: [{ at: 6, on: 'x', label: 'today' }] },
    { id: 'ladder', type: 'chart', ...at(1, 0), mark: 'span', title: 'Four lanes, nine weeks', fields: ['lane', 'from', 'to', 'state'], rows: ladderRows, encode: { x: 'from', x2: 'to', y: 'lane', series: 'state' }, rules: [{ at: 6, on: 'x', label: 'today' }], color: 'green' },
    { id: 'engines', type: 'chart', ...at(2, 0), mark: 'bar', title: 'Cost to build, by engine', unit: 'USD', fields: ['engine', 'cost'], rows: engineRows, encode: { x: 'engine', y: 'cost' }, rules: [{ at: 14, label: 'the most the bill allows' }] },
    { id: 'parts', type: 'chart', x: 60, y: 110 + H + 40, w: W, h: 150, mark: 'bar', title: 'The old unit, twelve parts', fields: ['unit', 'fate', 'parts'], rows: partRows, encode: { x: 'unit', y: 'parts', series: 'fate' }, stack: true, flip: true, color: 'green' },
    { id: 'night', type: 'chart', ...at(1, 1), mark: 'span', title: 'The night it was heard, hours after 18:00', fields: ['lane', 'from', 'to', 'state'], rows: nightRows, encode: { x: 'from', x2: 'to', y: 'lane', series: 'state' }, rules: [{ at: 4.5, on: 'x', label: 'first lock' }], color: 'amber' },
    { id: 'votes', type: 'chart', ...at(2, 1), mark: 'bar', title: 'Votes by cluster', fields: ['cluster', 'votes'], rows: voteRows, encode: { x: 'cluster', y: 'votes' }, flip: true },
    { id: 'knobs', type: 'chart', ...at(0, 2.35), mark: 'bar', title: 'Touches by knob', fields: ['knob', 'touches'], rows: KNOBS.map((knob, i) => [knob, TOUCHES[i]]), encode: { x: 'knob', y: 'touches' } },
    { id: 'heat', type: 'chart', ...at(1, 2.35), mark: 'cell', title: 'Minutes on the knobs, in five-minute bins', unit: 'min', fields: ['from minute', 'player', 'minutes'], rows: heatRows, encode: { x: 'from minute', y: 'player', value: 'minutes' } },
    { id: 'sessions', type: 'chart', ...at(2, 2.35), mark: 'cell', title: 'The hour, minute by minute', fields: ['minute', 'player', 'doing'], rows: sessionRows, encode: { x: 'minute', y: 'player', series: 'doing' } },
    { id: 'multiples', type: 'chart', ...at(0, 3.35), w: W + 40 + W, mark: 'bar', title: 'What each player spent the hour on', unit: 'min', fields: ['player', 'doing', 'minutes'], rows: multipleRows, encode: { x: 'doing', y: 'minutes', facet: 'player' } },
    { id: 'ideas', type: 'chart', ...at(2, 3.35), mark: 'dot', title: '28 ideas, placed by likeness, sized by votes', fields: ['x', 'y', 'cluster', 'votes'], rows: ideaRows, encode: { x: 'x', y: 'y', series: 'cluster', size: 'votes' } },
    { id: 'a1', type: 'arrow', from: { object: 'burn' }, to: { object: 'ladder' }, label: 'why' },
  ]);
  add([{ id: 'n1', type: 'note', x: 60 + W - 150, y: 110 + H + 40 + 170, w: 200, h: 120, text: 'At this rate it lands a week late. Jack J3 is the part.', color: 'violet' }], ANA);
  for (const [id, title, frame] of [['release', 'The release', 'f-release'], ['field-test', 'The field test', 'f-test']] as const) {
    const result = store.dispatch({ type: 'add-snapshot', snapshot: { id, title, source: { kind: 'frame', frame } } }, { actor: AGENT });
    if (!result.ok) throw new Error(result.error);
  }
  return store;
}

/**
 * `?bench=canvas&charts=200`: a board of nothing but charts, every mark in turn, each with a table of a
 * size a real one has. For the benchmark's chart rows.
 */
export function createChartBenchStore(count: number): CanvasStore {
  const store = new CanvasStore(createDocument('chart-bench', `${count} charts`));
  const random = seeded(29);
  const columns = Math.ceil(Math.sqrt(count * 2));
  const objects: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const place = { id: `c${i}`, type: 'chart', x: (i % columns) * 420, y: Math.floor(i / columns) * 280, w: 380, h: 240, title: `Series ${i + 1}` };
    const walk = (length: number, from: number) => {
      let value = from;
      return Array.from({ length }, () => (value = Math.max(1, Math.round(value + (random() - 0.45) * from * 0.2))));
    };
    const kind = i % 6;
    if (kind === 0) objects.push({ ...place, mark: 'bar', fields: ['week', 'a', 'b'], rows: walk(24, 60).map((a, w) => [`W${w + 1}`, a, Math.round(a * 0.6)]), encode: { x: 'week', y: ['a', 'b'] }, stack: true });
    else if (kind === 1) objects.push({ ...place, mark: 'line', unit: 'ms', fields: ['day', 'p50', 'p95'], rows: walk(60, 120).map((p50, d) => [d + 1, p50, Math.round(p50 * 2.4)]), encode: { x: 'day', y: ['p50', 'p95'] }, dash: ['p95'], rules: [{ at: 200, label: 'limit' }] });
    else if (kind === 2) objects.push({ ...place, mark: 'area', fields: ['hour', 'waiting'], rows: walk(48, 90).map((waiting, h) => [`${h}h`, waiting]), encode: { x: 'hour', y: 'waiting' }, color: 'amber' });
    else if (kind === 3) objects.push({ ...place, mark: 'dot', fields: ['x', 'y', 'kind', 'votes'], rows: walk(40, 50).map((y, d) => [Math.round(random() * 100), y, `k${d % 4}`, d % 9]), encode: { x: 'x', y: 'y', series: 'kind', size: 'votes' } });
    else if (kind === 4) objects.push({ ...place, mark: 'cell', fields: ['bin', 'player', 'minutes'], rows: Array.from({ length: 96 }, (_cell, c) => [`${(c % 12) * 5}`, `p0${Math.floor(c / 12) + 1}`, Math.round(random() * 5)]), encode: { x: 'bin', y: 'player', value: 'minutes' } });
    else objects.push({ ...place, mark: 'span', fields: ['lane', 'from', 'to', 'state'], rows: Array.from({ length: 12 }, (_span, s) => [`Lane ${(s % 4) + 1}`, s, s + 1 + Math.round(random() * 3), `s${s % 3}`]), encode: { x: 'from', x2: 'to', y: 'lane', series: 'state' }, color: 'green' });
  }
  const result = store.dispatch({ type: 'add', objects: objects as CanvasObject[] } as Command, { actor: AGENT });
  if (!result.ok) throw new Error(result.error);
  return store;
}
