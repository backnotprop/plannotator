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

const svgUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** A small chart, as a picture an agent might add. */
export const CHART_IMAGE = svgUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 140"><rect width="320" height="140" rx="8" fill="#ffffff"/>' +
    '<g stroke="#e3e5ea"><path d="M24 24H300M24 64H300M24 104H300"/></g>' +
    '<polyline fill="none" stroke="#8a8f9c" stroke-width="2" points="24,58 60,50 96,62 132,36 168,52 204,30 240,54 276,44 300,56"/>' +
    '<polyline fill="none" stroke="#5b3fd6" stroke-width="2.5" points="24,108 60,109 96,107 132,108 168,105 204,108 240,107 276,108 300,107"/>' +
    '<g font-family="system-ui,sans-serif" font-size="11" fill="#474b57"><text x="28" y="18">minutes from scan to alert</text><text x="252" y="38">sweep</text><text x="252" y="98" fill="#5b3fd6">queue</text></g></svg>',
);

/** Four frames of a blinking dot in one row: a sprite sheet. */
export const PULSE_SPRITE = svgUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 24">' +
    [4, 7, 10, 7].map((r, i) => `<circle cx="${12 + i * 24}" cy="12" r="${r}" fill="#2a8050"/>`).join('') +
    '</svg>',
);

const HTML_ITEM =
  '<style>.t{display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;font:12.5px/1.4 system-ui,sans-serif;padding:6px 2px}.t b{font-weight:600}.t i{font-style:normal;opacity:.65}' +
  '.bar{height:6px;border-radius:3px;background:#5b3fd6;align-self:center;animation:grow 1.6s ease-out both}@keyframes grow{from{transform:scaleX(0)}}.bar{transform-origin:left}</style>' +
  '<div class="t"><b>urgent</b><span class="bar" style="width:22%"></span><i>0.7 min</i><b>bulk</b><span class="bar" style="width:58%"></span><i>3.1 min</i><b>sweep</b><span class="bar" style="width:96%"></span><i>9.1 min</i></div>';

const box = (id: string, x: number, y: number, text: string, detail?: string, extra: Partial<CanvasObject> = {}): CanvasObject =>
  ({ id, type: 'box', x, y, w: 196, h: 60, text, ...(detail ? { detail } : {}), ...extra }) as CanvasObject;

const arrow = (id: string, from: string, to: string, label?: string): CanvasObject => ({ id, type: 'arrow', from: { object: from }, to: { object: to }, ...(label ? { label } : {}) });

export const SAMPLE_CANVAS_ID = 'parcel-alerts';

export const SAMPLE_SNAPSHOTS: SnapshotInput[] = [
  { id: 'architecture', title: 'Architecture', source: { kind: 'frame', frame: 'f-arch' } },
  { id: 'queues', title: 'Two queues', source: { kind: 'objects', objects: ['orders', 'q-urgent', 'q-bulk', 'a-orders-urgent', 'a-orders-bulk', 'why-two'] } },
  { id: 'rollout', title: 'Rollout', source: { kind: 'frame', frame: 'f-rollout' } },
];

export function createSampleStore(): CanvasStore {
  const store = new CanvasStore(createDocument(SAMPLE_CANVAS_ID, 'Parcel alerts'), { actor: { kind: 'person', id: 'demo-person' } });
  const commands: Command[] = [
    {
      type: 'add',
      objects: [
        { id: 'f-arch', type: 'frame', x: 40, y: 80, w: 924, h: 300, title: 'Architecture' },
        { id: 'f-rollout', type: 'frame', x: 40, y: 470, w: 420, h: 250, title: 'Rollout' },
        { id: 'f-measure', type: 'frame', x: 500, y: 470, w: 464, h: 250, title: 'What we measured' },
        box('orders', 64, 196, 'Orders API', 'emits a parcel event per scan'),
        box('q-urgent', 300, 132, 'Queue: urgent', 'out for delivery, failed', { color: 'blue' }),
        box('q-bulk', 300, 262, 'Queue: bulk', 'everything else', { color: 'blue' }),
        box('worker', 524, 196, 'Notifier worker', 'decides who should hear'),
        box('push', 744, 112, 'Push provider', undefined, { color: 'green', h: 44 } as Partial<CanvasObject>),
        box('email', 744, 204, 'Email provider', undefined, { color: 'green', h: 44 } as Partial<CanvasObject>),
        box('dead', 744, 292, 'Dead-letter list', 'after 3 failed tries', { color: 'amber' }),
        arrow('a-orders-urgent', 'orders', 'q-urgent'),
        arrow('a-orders-bulk', 'orders', 'q-bulk'),
        arrow('a-urgent-worker', 'q-urgent', 'worker'),
        arrow('a-bulk-worker', 'q-bulk', 'worker'),
        arrow('a-worker-push', 'worker', 'push'),
        arrow('a-worker-email', 'worker', 'email'),
        arrow('a-worker-dead', 'worker', 'dead', 'fails'),
        { id: 'why-two', type: 'note', x: 286, y: 400, w: 190, h: 64, text: 'Why two queues? One queue with a priority field would do.', by: 'person' },
        box('r1', 64, 494, '1. Shadow mode', 'The queue runs beside the sweep. Nothing is sent.', { w: 372 } as Partial<CanvasObject>),
        box('r2', 64, 566, '2. Five percent, one region', 'Compare the alert log with the sweep for a week.', { w: 372 } as Partial<CanvasObject>),
        box('r3', 64, 638, '3. Everyone', 'Switch the sweep off a week later.', { w: 372 } as Partial<CanvasObject>),
        { id: 'chart', type: 'image', x: 524, y: 494, w: 250, h: 110, src: CHART_IMAGE, alt: 'Minutes from scan to alert, sweep and queue' },
        { id: 'pulse', type: 'sprite', x: 790, y: 500, w: 24, h: 24, src: PULSE_SPRITE, alt: 'Shadow mode is running', frames: 4, fps: 4 },
        { id: 'pulse-label', type: 'text', x: 820, y: 502, w: 90, h: 20, text: 'shadow mode', size: 'small' },
        { id: 'timings', type: 'html', x: 524, y: 618, w: 372, h: 84, html: HTML_ITEM },
        { id: 'f-refs', type: 'frame', x: 1004, y: 80, w: 328, h: 640, title: 'References' },
        {
          id: 'ref-web',
          type: 'reference',
          x: 1028,
          y: 104,
          w: 280,
          h: 236,
          target: { kind: 'web', url: 'https://example.org/notes/late-alerts' },
          title: 'Queues or a sweep? Notes on late alerts',
          description: 'Why a ten-minute sweep makes the median alert nine minutes late, and what a queue changes.',
          site: 'example.org',
          image: CHART_IMAGE,
        },
        {
          id: 'ref-artifact',
          type: 'reference',
          x: 1028,
          y: 364,
          w: 280,
          h: 196,
          target: { kind: 'artifact', artifact: 'shots/alert-log-week-1.png', artifactKind: 'image' },
          title: 'alert-log-week-1.png',
          description: 'The alert log beside the sweep, first week of shadow mode.',
          image: CHART_IMAGE,
        },
        { id: 'ref-plan', type: 'reference', x: 1028, y: 584, w: 280, h: 104, target: { kind: 'plan', anchor: 'Rollout' }, title: 'Rollout', description: 'Shadow mode for a week, then five percent of parcels in one region.' },
      ],
    },
    ...SAMPLE_SNAPSHOTS.map((snapshot): Command => ({ type: 'add-snapshot', snapshot })),
  ];
  for (const command of commands) {
    const result = store.dispatch(command, { actor: AGENT });
    if (!result.ok) throw new Error(`sample canvas: ${result.error}`);
  }
  return store;
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
export function createLargeStore(count: number, snapshots = 0): CanvasStore {
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
    objects.push({
      id,
      type: 'box',
      x: col * 230 + Math.round(random() * 24),
      y: row * 120 + Math.round(random() * 20),
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
    objects.push({ id: `n${i}`, type: 'note', x: near.x + 40, y: near.y + 62, w: 150, h: 44, text: `Note ${i}: check this` });
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
