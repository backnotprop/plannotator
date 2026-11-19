/**
 * Invented sample data for the demo and the benchmark: a small board about
 * a parcel alert service, the plan that refers to it, and generators for
 * the large cases. Built with commands, as an agent would build it.
 */
import { CanvasStore } from '../events/store';
import type { Command } from '../events/types';
import { createDocument } from '../model/document';
import type { CanvasObject, SnapshotInput } from '../model/types';
import { serializeSnapshotBlock } from '../snapshot/block';

const AGENT = { kind: 'agent', id: 'demo-agent' } as const;

/** A chart, as a picture an agent might add: a file the demo serves, referenced by its path. */
export const CHART_IMAGE = '/board/chart.svg';

/** Four frames of a blinking dot in one row: a sprite sheet. */
export const PULSE_SPRITE = '/pulse.svg';

/**
 * A custom HTML item on a transparent ground. No script: the sandbox does
 * not run any, so the figures are written and only the bars move, in CSS.
 */
const HTML_ITEM =
  '<style>.c{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;font-family:ui-monospace,SF Mono,Menlo,monospace;height:56px}' +
  '.c small{display:block;font:12px/1.2 system-ui,sans-serif;opacity:.7;margin-bottom:4px}.c b{font-size:26px;font-weight:650;letter-spacing:.5px}.c sub{font-size:11px;opacity:.7}' +
  '.bars{display:flex;align-items:flex-end;gap:3px;height:44px}.bars i{width:5px;border-radius:1.5px;background:currentColor;opacity:.16;animation:r 2.4s ease-in-out infinite alternate}' +
  '.bars i:last-child{opacity:1;color:#5b3fd6}@keyframes r{from{transform:scaleY(.82)}to{transform:scaleY(1)}}.bars i{transform-origin:bottom}' +
  '@media (prefers-reduced-motion:reduce){.bars i{animation:none}}</style>' +
  '<div class="c"><div><small>Cutover to the queue in</small><b>12<sub>d</sub> 04:31:06</b></div><div class="bars">' +
  [30, 62, 44, 70, 52, 80, 58, 66, 48, 74, 60, 86, 40].map((h, i) => `<i style="height:${h}%;animation-delay:${i * 90}ms"></i>`).join('') +
  '</div></div>';

/** Who made what on the sample board: a person and an agent, so the board shows both. */
const ANA = { kind: 'person', id: 'ana' } as const;

export const SAMPLE_CANVAS_ID = 'parcel-alerts';

export const SAMPLE_SNAPSHOTS: SnapshotInput[] = [
  { id: 'architecture', title: 'Architecture', source: { kind: 'frame', frame: 'fa' } },
  { id: 'queues', title: 'Two queues', source: { kind: 'objects', objects: ['dec', 'qs', 'qu', 'qb', 'a3', 'a4', 'n1'] } },
  { id: 'rollout', title: 'Rollout', source: { kind: 'frame', frame: 'fr' } },
];

type Loose = Record<string, unknown> & { id: string; type: string };
const shape = (id: string, kind: string, x: number, y: number, w: number, h: number, text: string, extra: Record<string, unknown> = {}): Loose => ({ id, type: 'box', shape: kind, x, y, w, h, text, ...extra });
const link = (id: string, from: string, to: string, extra: Record<string, unknown> = {}): Loose => ({ id, type: 'arrow', from: { object: from }, to: { object: to }, ...extra });

/**
 * The sample board: the same content and the same geometry as the design
 * reference (an architecture diagram, evidence, a rollout timeline, what
 * was measured, references), so the two can be compared side by side.
 * Built with commands, as an agent and a person would build it.
 */
export function createSampleStore(): CanvasStore {
  const store = new CanvasStore(createDocument(SAMPLE_CANVAS_ID, 'Parcel alerts: moving off the nightly sweep'), { actor: ANA });
  const byAgent: Loose[] = [
    { id: 'fa', type: 'frame', x: 0, y: 0, w: 1320, h: 780, title: 'Architecture' },
    { id: 'fe', type: 'frame', x: 1400, y: 0, w: 860, h: 780, title: 'Evidence' },
    { id: 'fr', type: 'frame', x: 0, y: 880, w: 860, h: 340, title: 'Rollout', color: 'violet' },
    { id: 'fm', type: 'frame', x: 920, y: 880, w: 400, h: 340, title: 'What we measured' },
    { id: 'ff', type: 'frame', x: 1400, y: 880, w: 860, h: 340, title: 'References' },
    shape('qs', 'container', 610, 190, 250, 390, 'Queue service', { lanes: ['urgent', 'bulk'] }),
    shape('ac', 'actor', 36, 352, 104, 138, 'Courier app'),
    shape('api', 'process', 190, 362, 170, 76, 'Orders API', { detail: 'emits a scan event' }),
    shape('dec', 'decision', 420, 338, 130, 124, 'Urgent?', { color: 'amber' }),
    shape('qu', 'queue', 662, 276, 170, 68, 'urgent', { detail: 'under 5 s', color: 'red' }),
    shape('qb', 'queue', 662, 456, 170, 68, 'bulk', { detail: 'best effort', color: 'blue' }),
    shape('wk', 'process', 930, 362, 170, 76, 'Notifier worker', { detail: 'picks a channel, sends', color: 'violet' }),
    shape('cl', 'cloud', 1128, 140, 166, 112, 'Push provider', { color: 'green' }),
    shape('db', 'database', 1150, 338, 124, 124, 'Alert log', { color: '#0e9aa7' }),
    shape('doc', 'document', 667, 650, 160, 92, 'Dropped alerts', { detail: 'daily report' }),
    { id: 's1', type: 'stamp', kind: 'check', x: 1076, y: 344, w: 34, h: 34, color: 'green' },
    { id: 'ct', type: 'text', x: 904, y: 520, w: 236, h: 36, size: 'small', text: 'At-least-once delivery.\nDedupe on parcel id + status.' },
    { id: 'n2', type: 'note', x: 266, y: 92, w: 184, h: 158, color: 'violet', text: 'Bulk spikes at 09:00. In the replay a shared queue held urgent alerts for 4 min.' },
    link('a1', 'ac', 'api', { label: 'scan' }),
    link('a2', 'api', 'dec'),
    link('a3', 'dec', 'qu', { label: 'yes', style: { fromSide: 'n', toSide: 'w', labelAt: 0.3 } }),
    link('a4', 'dec', 'qb', { label: 'no', style: { fromSide: 's', toSide: 'w', labelAt: 0.3 } }),
    link('a5', 'qu', 'wk'),
    link('a6', 'qb', 'wk'),
    link('a7', 'wk', 'cl', { label: 'send', color: 'green', style: { fromSide: 'n', toSide: 'w', labelAt: 0.62 } }),
    link('a8', 'wk', 'db', { label: 'write' }),
    link('a9', 'wk', 'qu', { label: 'retry ×3', color: 'red', style: { fromSide: 'n', toSide: 'n', dash: true } }),
    link('a10', 'qb', 'doc', { label: 'expired', style: { fromSide: 's', toSide: 'n', labelAt: 0.72 } }),
    link('a11', 'api', 'db', { label: 'audit', style: { fromSide: 's', toSide: 's', labelAt: 0.42 } }),
    link('a12', 'ct', 'wk', { routing: 'straight', style: { ends: 'dot', dash: true } }),
    { id: 'i1', type: 'image', x: 1440, y: 64, w: 500, h: 312, src: '/board/dash.svg', alt: 'Alert delay, staging dashboard' },
    { id: 'i2', type: 'image', x: 1440, y: 432, w: 500, h: 300, src: '/board/term.svg', alt: 'Shadow run, last 24 hours' },
    { id: 'sp', type: 'sprite', x: 2050, y: 612, w: 110, h: 110, src: '/board/sprite.svg', alt: 'A parcel on its way', frames: 6, fps: 8 },
    shape('b1', 'pill', 40, 944, 250, 46, 'Shadow mode', { color: 'green' }),
    shape('b2', 'pill', 290, 1002, 130, 46, '5%, one region', { color: 'blue' }),
    shape('b3', 'pill', 420, 944, 130, 46, '50%', { color: 'amber' }),
    shape('b4', 'pill', 550, 1002, 270, 46, 'Everyone', { color: 'violet' }),
    { id: 'ax', type: 'arrow', from: { x: 40, y: 1084 }, to: { x: 828, y: 1084 }, routing: 'straight' },
    ...[['2 Dec', 40], ['16 Dec', 290], ['23 Dec', 420], ['6 Jan', 550], ['20 Jan', 778]].map(([text, x], i) => ({ id: `tk${i}`, type: 'text', x, y: 1094, w: 60, h: 18, size: 'small', text })),
    shape('m1', 'decision', 279, 1073, 22, 22, '', { color: 'red', style: { fill: 'solid' } }),
    shape('m2', 'decision', 539, 1073, 22, 22, '', { color: 'red', style: { fill: 'solid' } }),
    { id: 'tg', type: 'text', x: 566, y: 1056, w: 90, h: 18, size: 'small', text: 'go / no-go', color: 'red' },
    { id: 'dm', type: 'arrow', from: { x: 40, y: 1158 }, to: { x: 820, y: 1158 }, label: '7 weeks', routing: 'straight', style: { ends: 'bar-arrow' } },
    { id: 'i4', type: 'image', x: 948, y: 912, w: 344, h: 200, src: '/board/chart.svg', alt: 'Scan to alert, cron against queue' },
    { id: 'hw', type: 'html', x: 948, y: 1146, w: 344, h: 60, html: HTML_ITEM, alt: 'Cutover to the queue in 12 days' },
    { id: 'r2', type: 'reference', x: 1702, y: 930, w: 252, h: 240, target: { kind: 'web', url: 'https://runbooks.example/dead-letter-queues' }, title: 'Dead-letter queues: a runbook', description: 'What to replay, what to drop, who to wake.', site: 'runbooks.example', image: '/board/og2.svg', icon: '/board/fav2.svg' },
    { id: 'r3', type: 'reference', x: 1974, y: 930, w: 256, h: 112, target: { kind: 'artifact', artifact: 'replay-report', artifactKind: 'html' }, title: 'Replay report', description: 'HTML, 3 charts', image: '/board/chart.svg' },
  ];
  const byAna: Loose[] = [
    shape('pr', 'process', 40, 612, 206, 84, 'One queue,\npriority field?', { color: 'amber', style: { look: 'sketch', fill: 'hachure' } }),
    { id: 'n1', type: 'note', x: 52, y: 60, w: 184, h: 158, text: 'Why two queues? One queue with a priority field would do.' },
    { id: 's2', type: 'stamp', kind: 'thumb', count: 2, x: 192, y: 202, w: 54, h: 32, color: 'violet' },
    { id: 'i3', type: 'image', x: 1990, y: 64, w: 230, h: 488, src: '/board/phone.svg', alt: 'What the customer sees' },
    { id: 'r1', type: 'reference', x: 1430, y: 930, w: 252, h: 240, target: { kind: 'web', url: 'https://fieldnotes.example/queues-or-a-sweep' }, title: 'Queues or a sweep? Timing alert pipelines', description: 'Why a nightly sweep ages badly once alerts matter.', site: 'fieldnotes.example', image: '/board/og1.svg', icon: '/board/fav1.svg' },
    { id: 'r4', type: 'reference', x: 1974, y: 1058, w: 256, h: 112, target: { kind: 'plan', anchor: 'Rollout' }, title: 'Rollout, step 2', description: 'Five percent of parcels in one region for a week. Roll back if p95 passes 5 min.' },
  ];
  const run = (command: Command, actor: typeof AGENT | typeof ANA) => {
    const result = store.dispatch(command, { actor });
    if (!result.ok) throw new Error(`sample canvas: ${result.error}`);
  };
  run({ type: 'add', objects: byAgent as unknown as CanvasObject[] }, AGENT);
  run({ type: 'add', objects: byAna as unknown as CanvasObject[] }, ANA);
  for (const snapshot of SAMPLE_SNAPSHOTS) run({ type: 'add-snapshot', snapshot }, AGENT);
  // The board as it is handed over: nothing of the building is the person's to undo.
  return new CanvasStore(store.getDocument(), { actor: ANA });
}

const block = (snapshot: string, title?: string) => serializeSnapshotBlock({ canvas: SAMPLE_CANVAS_ID, snapshot, ...(title ? { title } : {}) });

export const SAMPLE_PLAN = `# Tell people where their parcel is, within a minute

Today a sweep looks for new scans every ten minutes, so the median alert is nine minutes late. This plan replaces the sweep with events on a queue.

## How it fits together

The Orders API emits one event per scan. Urgent events (out for delivery, failed delivery) go to their own queue so a marketing burst cannot hold them up.

${block('architecture')}

One worker reads both queues and decides who should hear. A send that fails three times goes to the dead-letter list, which support can replay.

## Open question: one queue or two

${block('queues', 'The part in question')}

- Two queues are simpler to reason about under load.
- One queue with a priority field is one less thing to run.

## Rollout

${block('rollout')}

1. Shadow mode for a week: the queue runs, nothing is sent.
2. Five percent of parcels in one region.
3. Everyone, then switch the sweep off.

\`\`\`ts
export async function send(alert: Alert): Promise<void> {
  await provider.deliver(alert, { timeoutMs: 4000 });
}
\`\`\`

## What could go wrong

A provider outage fills the dead-letter list. The replay tool takes a time range, so nothing is lost; it is only late.
`;

/** A deterministic pseudo-random number generator, so every benchmark run draws the same board. */
function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLORS = ['blue', 'green', 'amber', 'red', 'violet'] as const;

/**
 * A board of about `count` objects: boxes in a loose grid, a note now and
 * then, and an arrow from most boxes to the next. Laid out about four
 * screens wide so panning has somewhere to go.
 */
const LONG_NOTE = 'Check this before the rollout: the replay tool takes a time range, the dead-letter list fills during an outage, and support has no night rota yet. '.repeat(3);

/**
 * `rich`: the same board with the heavy kinds mixed in, the way a real one
 * has them: every twelfth box is a picture, every thirtieth an HTML item,
 * every fortieth a card with a picture, and the notes are long.
 */
const SHAPES = ['process', 'decision', 'database', 'queue', 'document', 'cloud', 'pill'] as const;

/**
 * `typed`: `count` shapes of every kind and `connectors` routed connectors
 * between neighbours (to the right, and down), for the router's rows.
 * `sketchEvery`: one shape in that many is drawn in the sketch look.
 */
export function createTypedStore(count: number, connectors: number, sketchEvery = 0): CanvasStore {
  const store = new CanvasStore(createDocument('typed-board', `${count} shapes`));
  const random = mulberry(11);
  const columns = Math.ceil(Math.sqrt(count * 1.8));
  const objects: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const kind = SHAPES[i % SHAPES.length];
    objects.push({
      id: `b${i}`,
      type: 'box',
      shape: kind,
      x: (i % columns) * 280 + Math.round(random() * 30),
      y: Math.floor(i / columns) * 210 + Math.round(random() * 24),
      text: `Step ${i}`,
      ...(kind === 'decision' || kind === 'pill' ? {} : { detail: 'detail line' }),
      ...(random() < 0.6 ? { color: COLORS[i % COLORS.length] } : {}),
      // Every so many, a shape in the sketch look, hatched: the costly one to draw.
      ...(sketchEvery && i % sketchEvery === 1 ? { style: { look: 'sketch', fill: i % 2 ? 'hachure' : 'cross' } } : {}),
    });
  }
  let made = 0;
  for (let i = 0; i < count && made < connectors; i++) {
    if ((i + 1) % columns !== 0 && i + 1 < count) objects.push({ id: `a${made++}`, type: 'arrow', from: { object: `b${i}` }, to: { object: `b${i + 1}` }, ...(made % 5 === 0 ? { label: 'next' } : {}) });
    if (made < connectors && i + columns < count && i % 2 === 0) objects.push({ id: `a${made++}`, type: 'arrow', from: { object: `b${i}` }, to: { object: `b${i + columns}` } });
  }
  const added = store.dispatch({ type: 'add', objects: objects as unknown as CanvasObject[] });
  if (!added.ok) throw new Error(added.error);
  return new CanvasStore(store.getDocument());
}

export function createLargeStore(count: number, snapshots = 0, rich = false): CanvasStore {
  const store = new CanvasStore(createDocument('large-board', `${count} objects`));
  const random = mulberry(7);
  const objects: CanvasObject[] = [];
  const boxes = Math.round(count * 0.62);
  const columns = Math.ceil(Math.sqrt(boxes * 1.8));
  const ids: string[] = [];
  for (let i = 0; i < boxes; i++) {
    const id = `b${i}`;
    ids.push(id);
    const col = i % columns;
    const row = Math.floor(i / columns);
    const tinted = random() < 0.3;
    const x = col * 230 + Math.round(random() * 24);
    const y = row * 120 + Math.round(random() * 20);
    if (rich && i % 12 === 5) {
      objects.push({ id, type: 'image', x, y, w: 176, h: 78, src: CHART_IMAGE, alt: `Chart ${i}` });
      continue;
    }
    if (rich && i % 30 === 7) {
      objects.push({ id, type: 'html', x, y, w: 176, h: 78, html: HTML_ITEM, alt: 'Timings' });
      continue;
    }
    if (rich && i % 40 === 9) {
      objects.push({ id, type: 'reference', x, y, w: 176, h: 96, target: { kind: 'web', url: `https://example.org/notes/${i}` }, title: `Note on service ${i}`, description: 'Why the sweep is late, and what a queue changes.', site: 'example.org', image: CHART_IMAGE });
      continue;
    }
    objects.push({
      id,
      type: 'box',
      x,
      y,
      w: 176,
      h: 56,
      text: `Service ${i}`,
      detail: i % 3 === 0 ? 'handles one kind of event' : 'reads, decides, writes',
      ...(tinted ? { color: COLORS[i % COLORS.length] } : {}),
    });
  }
  const notes = Math.round(count * 0.08);
  for (let i = 0; i < notes; i++) {
    const near = objects[Math.floor(random() * boxes)] as { x: number; y: number };
    objects.push({ id: `n${i}`, type: 'note', x: near.x + 40, y: near.y + 62, w: 150, h: rich ? 110 : 44, text: rich ? `Note ${i}: ${LONG_NOTE}` : `Note ${i}: check this` });
  }
  const arrows = count - boxes - notes;
  for (let i = 0; i < arrows; i++) {
    const from = i % boxes;
    const to = from + 1 < boxes && (from + 1) % columns !== 0 ? from + 1 : Math.min(boxes - 1, from + columns);
    if (to === from) continue;
    objects.push({ id: `a${i}`, type: 'arrow', from: { object: ids[from] }, to: { object: ids[to] } });
  }
  const added = store.dispatch({ type: 'add', objects });
  if (!added.ok) throw new Error(added.error);
  const rows = Math.ceil(boxes / columns);
  for (let i = 0; i < snapshots; i++) {
    const col = Math.floor(random() * Math.max(1, columns - 4));
    const row = Math.floor(random() * Math.max(1, rows - 3));
    const result = store.dispatch({
      type: 'add-snapshot',
      snapshot: { id: `s${i}`, title: `Part ${i + 1}`, source: { kind: 'region', rect: { x: col * 230 - 20, y: row * 120 - 20, w: 230 * 4, h: 120 * 3 } } },
    });
    if (!result.ok) throw new Error(result.error);
  }
  return store;
}

/** A plan with `count` snapshots of the large board, with prose between them. */
export function createLongPlan(count: number): string {
  const parts = ['# A plan with many snapshots', '', 'Each figure below is a live window onto one shared canvas.', ''];
  for (let i = 0; i < count; i++) {
    parts.push(`## Step ${i + 1}`, '', 'This step changes how one part of the system talks to the next. The figure shows the part it touches.', '');
    parts.push(serializeSnapshotBlock({ canvas: 'large-board', snapshot: `s${i}` }), '');
    parts.push('- It keeps the current behaviour behind a flag.', '- It is safe to roll back.', '');
  }
  return parts.join('\n');
}
