/**
 * Worst-case data for the demo (dev only, `?data=…`). Every value is one a real
 * person or agent could produce, or the schema's own limit (`LIMITS`, model/codec.ts).
 * It enters through the same boundary as `sample.ts`: commands to a store, and a plan's text.
 *
 *   ?data=worst    the sample board's shape with worst values, and a 50-snapshot plan
 *   ?data=empty    an empty board, a plan with no snapshot
 *   ?data=one      one object, one snapshot
 *   ?data=huge     2,000 objects (rich), a snapshot of the whole board
 *   ?data=max      10,000 objects (LIMITS.objects), a snapshot of the whole board
 *   ?data=stacked  500 notes exactly on top of each other
 *   ?data=far      objects at ±1,000,000
 */
import { CanvasStore } from '../events/store';
import type { Command } from '../events/types';
import { parseDocument, serializeDocument } from '../model/codec';
import { createDocument } from '../model/document';
import type { CanvasObject } from '../model/types';
import { serializeSnapshotBlock } from '../snapshot/block';
import { createLargeStore } from './sample';

export type DataSet = 'demo' | 'worst' | 'empty' | 'one' | 'huge' | 'max' | 'stacked' | 'far';
export const DATA_SETS: { id: DataSet; label: string }[] = [
  { id: 'demo', label: 'Demo data' },
  { id: 'worst', label: 'Worst case' },
  { id: 'empty', label: 'Empty' },
  { id: 'one', label: 'One' },
  { id: 'huge', label: '2,000' },
  { id: 'max', label: '10,000' },
  { id: 'stacked', label: 'Stacked' },
  { id: 'far', label: '±1e6' },
];

export const WORST_CANVAS_ID = 'worst-case';

const AGENT = { kind: 'agent', id: 'planner-agent-eu-west-reconciliation' } as const;
const PERSON = { kind: 'person', id: 'aleksandra.wisniewska-kowalczyk' } as const;

type Loose = Record<string, unknown> & { id: string; type: string };
const shape = (id: string, kind: string, x: number, y: number, w: number, h: number, text: string, extra: Record<string, unknown> = {}): Loose => ({ id, type: 'box', shape: kind, x, y, w, h, text, ...extra });
const link = (id: string, from: string, to: string, extra: Record<string, unknown> = {}): Loose => ({ id, type: 'arrow', from: { object: from }, to: { object: to }, ...extra });

// ── Text values ────────────────────────────────────────────────────────────
const SERVICE = 'payments-reconciliation-service-for-the-eu-west-region';
const EMAIL = 'bartholomew.fitzgerald@northwind-industries-holdings.example.com';
const GERMAN = 'Zahlungsabgleichsverarbeitungsinfrastrukturüberwachungsdienst';
/** LIMITS.title is 300: a real heading-length sentence, padded with a real-looking suffix to the limit. */
const TITLE_300 = (
  'Architecture of the payments reconciliation pipeline for the EU-West region after the 14 March incident, ' +
  'including the dead-letter replay path, the ledger writer, the nightly sweep we are retiring, and the open question about one queue or two (draft 7, revised after review with the platform team and finance operations)'
).slice(0, 300);
const ARABIC = 'التحقق من الأدلة — لوحة مراقبة تأخير التنبيهات';
const HEBREW = 'יומן ההתראות של מערכת התשלומים';
const CJK = '緊急配送通知キュー（東京リージョン、優先度高）';
const VIETNAMESE = 'Hàng đợi thông báo số lượng lớn — ưu tiên thấp, xử lý theo lô';
const THAI = 'ผู้ให้บริการการแจ้งเตือนแบบพุชสำหรับลูกค้าที่ลงทะเบียนแล้ว';
const EMOJI = 'Notifier worker 👩🏽‍💻🧑‍🤝‍🧑🏳️‍🌈';

/** A pasted log: what a 5,000-character note really looks like. */
const LOG_LINE = (i: number) => `2026-03-14T09:${String(i % 60).padStart(2, '0')}:07.${String((i * 37) % 1000).padStart(3, '0')}Z WARN ${SERVICE} parcel=${(1284003 + i * 7).toLocaleString('en-US')} status=OUT_FOR_DELIVERY retry=${i % 4} queue=urgent latency_ms=${(4000 + i * 131) % 9000}\n`;
const LOG = (chars: number) => {
  let out = '';
  for (let i = 0; out.length < chars; i++) out += LOG_LINE(i);
  return out.slice(0, chars);
};
const NOTE_5000 = `Things I checked before the replay (Aleksandra):\n${LOG(4950)}`;
const TEXT_LIMIT = LOG(20_000); // LIMITS.text

/** 64,000 characters of HTML (HTML_ITEM_MAX_LENGTH): a table an agent rendered. */
function bigTable(): string {
  let rows = '';
  for (let i = 0; rows.length < 63_000; i++) rows += `<tr><td>${SERVICE}</td><td>${(1284003.5 + i).toLocaleString('en-US')}</td><td>p95 ${(i % 90) + 4} s</td></tr>`;
  return `<table style="font:12px system-ui">${rows}</table>`.slice(0, 64_000);
}
const HTML_ESCAPE =
  '<meta http-equiv="refresh" content="0;url=https://phishing.example/">' +
  '<div style="position:fixed;inset:-2000px;background:#e11d48;color:#fff;font:700 40px system-ui;z-index:99999">ESCAPED THE BOX</div>' +
  '<img src="https://tracker.example/pixel.gif" alt="">';
const HTML_TALL = '<div style="font:14px system-ui;color:#111">' + Array.from({ length: 60 }, (_, i) => `<p>Step ${i + 1}: reconcile batch ${(1284003 + i).toLocaleString('en-US')}</p>`).join('') + '</div>';

function fanIn(): Loose[] {
  // Forty services all writing to one ledger: 40 arrows into one node.
  const names = ['billing-ledger-writer', 'refunds-api', 'chargeback-intake', 'payouts-scheduler', 'fx-rates-sync', 'kyc-review-queue', 'invoice-renderer', 'dunning-mailer'];
  const out: Loose[] = [];
  out.push({ id: 'ffan', type: 'frame', x: 0, y: 1320, w: 2260, h: 560, title: 'Fan-in: forty writers, one ledger' });
  out.push(shape('ledger', 'database', 1060, 1700, 140, 140, 'ledger', { color: '#0e9aa7' }));
  for (let i = 0; i < 40; i++) {
    const id = `w${i}`;
    out.push(shape(id, 'process', 20 + (i % 20) * 111, 1360 + Math.floor(i / 20) * 110, 104, 64, `${names[i % names.length]}-${String(i).padStart(2, '0')}`));
    out.push(link(`fan${i}`, id, 'ledger', { label: 'write' }));
  }
  return out;
}

/** The worst board: the sample's geometry, worst values in every field. */
export function createWorstStore(): CanvasStore {
  const store = new CanvasStore(createDocument(WORST_CANVAS_ID, TITLE_300), { actor: PERSON });
  const byAgent: Loose[] = [
    // Frames: the 300-character title, RTL, one character with a near-white colour, an empty title, nested, tiny.
    { id: 'fa', type: 'frame', x: 0, y: 0, w: 1320, h: 780, title: TITLE_300 },
    { id: 'fe', type: 'frame', x: 1400, y: 0, w: 860, h: 780, title: ARABIC },
    { id: 'fr', type: 'frame', x: 0, y: 880, w: 860, h: 340, title: 'J', color: '#fdfdfd' },
    { id: 'fm', type: 'frame', x: 920, y: 880, w: 400, h: 340, title: '' },
    { id: 'ff', type: 'frame', x: 1400, y: 880, w: 860, h: 340, title: `${GERMAN} – Referenzen` },
    { id: 'fin', type: 'frame', x: 1430, y: 600, w: 300, h: 150, title: 'Nested inside “Evidence”', color: 'red' },
    { id: 'ftiny', type: 'frame', x: 1300, y: 860, w: 1, h: 1, title: 'Tiny frame, one pixel' },
    // Shapes.
    shape('qs', 'container', 610, 190, 250, 390, `${SERVICE} (queue)`, { lanes: Array.from({ length: 12 }, (_, i) => (i === 0 ? SERVICE.slice(0, 80) : `lane-${i + 1}-${['urgent', 'bulk', 'retry', 'dlq'][i % 4]}`)) }),
    shape('ac', 'actor', 36, 352, 104, 138, 'Aleksandra Wiśniewska-Kowalczyk (Kurierin, Schichtleitung Nord)'),
    shape('api', 'process', 190, 362, 170, 76, SERVICE, { detail: EMAIL }),
    shape('dec', 'decision', 420, 338, 130, 124, 'Ist die Sendung dringend und der Empfänger erreichbar?', { color: 'amber' }),
    shape('qu', 'queue', 662, 276, 170, 68, CJK, { detail: '5 s 未満', color: 'red' }),
    shape('qb', 'queue', 662, 456, 170, 68, VIETNAMESE, { detail: 'best effort', color: '#0a0a0a' }),
    shape('wk', 'process', 930, 362, 170, 76, EMOJI, { detail: '1,284,003.5 messages/day', color: 'rgb(0 0 0 / 0)' }),
    shape('cl', 'cloud', 1128, 140, 166, 112, THAI, { color: 'green' }),
    shape('db', 'database', 1150, 338, 124, 124, HEBREW, { color: '#ffffff' }),
    shape('doc', 'document', 667, 650, 160, 92, TEXT_LIMIT, { detail: 'daily report' }),
    shape('solid', 'decision', 1180, 620, 110, 110, 'Ledger frozen?', { color: '#101010', style: { fill: 'solid' } }),
    { id: 'ct', type: 'text', x: 904, y: 520, w: 236, h: 36, size: 'small', text: `See https://runbooks.northwind-industries-holdings.example.com/payments/reconciliation/eu-west/dead-letter-replay?from=2026-03-14T09:00:00Z&to=2026-03-14T11:00:00Z` },
    { id: 'n2', type: 'note', x: 266, y: 92, w: 184, h: 158, color: 'violet', text: NOTE_5000 },
    // Arrows: a 300-character label, a self-loop, a zero-length arrow, an invisible colour.
    link('a1', 'ac', 'api', { label: TITLE_300 }),
    link('a2', 'api', 'dec'),
    link('a3', 'dec', 'qu', { label: 'ja' }),
    link('a4', 'dec', 'qb', { label: 'nein' }),
    link('a5', 'qu', 'wk'),
    link('a6', 'qb', 'wk'),
    link('a7', 'wk', 'cl', { label: 'إرسال', color: 'rgb(0 0 0 / 0)' }),
    link('a8', 'wk', 'db', { label: '1,284,003.5 / day' }),
    link('a9', 'wk', 'wk', { label: 'retry ×3 (self)', color: 'red' }),
    link('a10', 'qb', 'doc', { label: 'expired' }),
    link('a11', 'api', 'db', { label: 'audit', color: '#fefefe' }),
    { id: 'zero', type: 'arrow', from: { x: 520, y: 600 }, to: { x: 520, y: 600 }, label: 'zero-length' },
    // Pictures: extreme aspect, missing, broken host, ink with no ground, animated, one pixel, native 6K.
    { id: 'i1', type: 'image', x: 1440, y: 64, w: 500, h: 312, src: '/worst/panorama.svg', alt: 'Latency, 30 days, one row per hour' },
    { id: 'i2', type: 'image', x: 1440, y: 400, w: 500, h: 180, src: '/board/term-v2-final.svg', alt: TITLE_300 },
    { id: 'i3', type: 'image', x: 1990, y: 64, w: 230, h: 488, src: 'https://cdn.northwind-industries-holdings.example.com/screens/what-the-customer-sees@3x.png', alt: 'What the customer sees' },
    { id: 'i4', type: 'image', x: 948, y: 912, w: 344, h: 200, src: '/worst/ink-only.svg', alt: 'Ingest, ledger, reconcile (exported with no background)' },
    { id: 'spin', type: 'image', x: 1760, y: 620, w: 100, h: 100, src: '/worst/spinner.svg', alt: 'Loading spinner' },
    { id: 't1', type: 'image', x: 1900, y: 650, w: 1, h: 1, src: '/board/chart.svg', alt: 'A one-pixel picture' },
    { id: 'big', type: 'image', x: 0, y: 1960, w: 6016, h: 3384, src: '/worst/huge.svg', alt: 'Grafana, full-size screenshot' },
    // Sprites: the most frames and the fastest rate on a 4-frame sheet; a sprite whose sheet is missing.
    { id: 'sp', type: 'sprite', x: 2050, y: 612, w: 110, h: 110, src: '/pulse.svg', alt: 'A parcel on its way', frames: 512, fps: 60 },
    { id: 'sp2', type: 'sprite', x: 1900, y: 690, w: 60, h: 60, src: '/board/sprite-missing.png', alt: 'A parcel on its way (sheet missing)', frames: 6, fps: 8 },
    // HTML items: 64,000 characters, empty, trying to escape, taller than its box.
    { id: 'hw', type: 'html', x: 948, y: 1146, w: 344, h: 60, html: bigTable(), alt: 'Reconciliation table, 1,000 rows' },
    // An HTML item with nothing in it used to be accepted and drawn as nothing. It is refused now
    // (`hostile.test.ts`), so the fixture holds the nearest thing still allowed: one space-filled tag.
    { id: 'hempty', type: 'html', x: 40, y: 1240, w: 200, h: 60, html: '<p></p>' },
    { id: 'hesc', type: 'html', x: 260, y: 1240, w: 200, h: 60, html: HTML_ESCAPE, alt: 'Agent widget' },
    { id: 'htall', type: 'html', x: 480, y: 1240, w: 200, h: 60, html: HTML_TALL, alt: 'Steps' },
    // Cards: 300-char title + 600-char description + very long domain + broken pictures; no title; artifact file name; RTL; punycode; one character.
    { id: 'r1', type: 'reference', x: 1430, y: 930, w: 252, h: 240, target: { kind: 'web', url: `https://${SERVICE}.internal.northwind-industries-holdings.example.com/runbooks/dead-letter` }, title: TITLE_300, description: `${TITLE_300} ${TITLE_300}`.slice(0, 600), site: `${SERVICE}.internal.northwind-industries-holdings.example.com`, image: 'https://cdn.northwind-industries-holdings.example.com/og/dead-letter.png', icon: 'https://cdn.northwind-industries-holdings.example.com/favicon.ico' },
    { id: 'r2', type: 'reference', x: 1702, y: 930, w: 252, h: 240, target: { kind: 'web', url: 'https://runbooks.example/payments/reconciliation/eu-west/dead-letter-replay?from=2026-03-14T09%3A00%3A00Z&to=2026-03-14T11%3A00%3A00Z&utm_source=slack' } },
    { id: 'r3', type: 'reference', x: 1974, y: 930, w: 256, h: 112, target: { kind: 'artifact', artifact: 'reports/2026/Q3-Abschlussbericht-Zahlungsabgleich-EU-West-final-v12-wirklich-final.html', artifactKind: 'html' } },
    { id: 'r4', type: 'reference', x: 1974, y: 1058, w: 256, h: 112, target: { kind: 'plan', anchor: 'خطة الطرح' }, title: 'خطة الطرح، الخطوة الثانية: خمسة بالمئة من الطرود', description: 'خمسة بالمئة من الطرود في منطقة واحدة لمدة أسبوع.' },
    { id: 'r5', type: 'reference', x: 2280, y: 930, w: 252, h: 120, target: { kind: 'web', url: 'https://xn--mnchen-3ya.example/fahrplan/zustellung' } },
    { id: 'r6', type: 'reference', x: 2280, y: 1070, w: 60, h: 60, target: { kind: 'web', url: 'https://q.example/' }, title: 'Q' },
    // Bare text: one character, a number, an emoji sequence, colours the ground already is.
    { id: 'tj', type: 'text', x: 566, y: 1056, w: 20, h: 18, size: 'small', text: 'J' },
    { id: 'tn', type: 'text', x: 40, y: 1094, w: 120, h: 18, size: 'small', text: '1,284,003.5' },
    { id: 'te', type: 'text', x: 290, y: 1094, w: 120, h: 18, size: 'small', text: '👩🏽‍💻👨‍👩‍👧‍👦🏳️‍⚧️' },
    { id: 'tw', type: 'text', x: 420, y: 1094, w: 120, h: 18, size: 'small', text: 'white on white', color: 'white' },
    shape('b1', 'pill', 40, 944, 250, 46, 'Schattenbetrieb für alle Zahlungsabgleichsdienste', { color: 'green' }),
    shape('b2', 'pill', 290, 1002, 130, 46, '5 %, eine Region (eu-west-1)', { color: 'blue' }),
    shape('b3', 'pill', 420, 944, 130, 46, '50%', { color: 'amber' }),
    shape('b4', 'pill', 550, 1002, 270, 46, 'Everyone', { color: 'violet' }),
    { id: 'ax', type: 'arrow', from: { x: 40, y: 1084 }, to: { x: 828, y: 1084 }, routing: 'straight' },
    { id: 'dm', type: 'arrow', from: { x: 40, y: 1158 }, to: { x: 820, y: 1158 }, label: '7 Wochen', routing: 'straight', style: { ends: 'bar-arrow' } },
    // Targets that will be deleted, so arrows and a snapshot point at nothing.
    shape('gone1', 'process', 2300, 200, 170, 76, 'Legacy sweep (to be deleted)'),
    shape('gone2', 'process', 2300, 360, 170, 76, 'Cron host (to be deleted)'),
    link('ag1', 'wk', 'gone1', { label: 'old path' }),
    // Straddling the Architecture frame's edge.
    { id: 'straddle', type: 'note', x: 1240, y: 40, w: 184, h: 120, text: 'Half in Architecture, half in Evidence.' },
    ...fanIn(),
  ];
  const byPerson: Loose[] = [
    shape('pr', 'process', 40, 612, 206, 84, 'One queue,\npriority field?', { color: 'amber', style: { look: 'sketch', fill: 'hachure' } }),
    { id: 'n1', type: 'note', x: 52, y: 60, w: 184, h: 158, color: '#fffffe', text: 'Near-white note on a white board. Why two queues? One queue with a priority field would do.' },
    { id: 'n3', type: 'note', x: 52, y: 240, w: 140, h: 90, color: 'rgb(255 255 255 / 0)', text: 'A transparent note: can you read this?' },
    { id: 'n4', type: 'note', x: 2280, y: 600, w: 160, h: 90, color: '#000000', text: 'A black note.' },
  ];
  const run = (command: Command, actor: typeof AGENT | typeof PERSON) => {
    const result = store.dispatch(command, { actor });
    if (!result.ok) throw new Error(`worst canvas: ${result.error}`);
  };
  run({ type: 'add', objects: byAgent as unknown as CanvasObject[] }, AGENT);
  run({ type: 'add', objects: byPerson as unknown as CanvasObject[] }, PERSON);
  run({ type: 'group', id: 'grp', ids: ['b1', 'b2', 'b3', 'b4'], label: TITLE_300 }, PERSON);

  // Snapshots: every hard case once.
  const snaps: { id: string; title: string; source: unknown }[] = [
    { id: 'architecture', title: TITLE_300, source: { kind: 'frame', frame: 'fa' } },
    { id: 'evidence', title: ARABIC, source: { kind: 'frame', frame: 'fe' } },
    { id: 'rollout', title: 'J', source: { kind: 'frame', frame: 'fr' } },
    // A region with nothing in it is refused by the planner ("there is nothing there to capture"): held up.
    { id: 'tiny', title: 'One pixel', source: { kind: 'objects', objects: ['t1'] } },
    { id: 'wide', title: 'Timeline, the whole year', source: { kind: 'region', rect: { x: -9000, y: 1060, w: 20_000, h: 40 } } },
    { id: 'tall', title: 'One column, top to bottom', source: { kind: 'region', rect: { x: 600, y: -9000, w: 40, h: 20_000 } } },
    { id: 'whole', title: 'Everything on the board', source: { kind: 'region', rect: { x: -40, y: -60, w: 6100, h: 5420 } } },
    { id: 'gone', title: 'The legacy sweep', source: { kind: 'objects', objects: ['gone1', 'gone2'] } },
    { id: 'one', title: '', source: { kind: 'objects', objects: ['tj'] } },
    { id: 'emoji', title: '🧑‍🤝‍🧑 Fan-in 👩🏽‍💻 (40 → 1)', source: { kind: 'frame', frame: 'ffan' } },
    { id: 'cards', title: `${GERMAN}`, source: { kind: 'frame', frame: 'ff' } },
  ];
  // And enough small ones to make 50 in one plan, each soon behind.
  for (let i = 0; i < 38; i++) snaps.push({ id: `fan-${i}`, title: `Writer ${String(i + 1).padStart(2, '0')}: ${['billing-ledger-writer', 'refunds-api', 'chargeback-intake', 'payouts-scheduler'][i % 4]}`, source: { kind: 'objects', objects: [`w${i}`, `fan${i}`, 'ledger'] } });
  for (const snapshot of snaps) run({ type: 'add-snapshot', snapshot: snapshot as never }, AGENT);

  // After the snapshots: things change, so most of them are behind, and two sources go away.
  run({ type: 'edit', id: 'b3', patch: { text: '50 % (verschoben)' } }, PERSON);
  run({ type: 'move', ids: ['ledger'], dx: 0, dy: 10 }, PERSON);
  run({ type: 'delete', ids: ['gone1', 'gone2'] }, PERSON);

  // Arrows whose ends name objects that are not there (two people deleting and connecting at once).
  const saved = JSON.parse(serializeDocument(store.getDocument())) as { objects: Record<string, unknown> };
  saved.objects.orphan1 = { id: 'orphan1', type: 'arrow', from: { object: 'api' }, to: { object: 'deleted-by-peer' }, label: 'to a deleted object' };
  saved.objects.orphan2 = { id: 'orphan2', type: 'arrow', from: { object: 'deleted-a' }, to: { object: 'deleted-b' } };
  const parsed = parseDocument(saved);
  if (!parsed.ok) throw new Error(`worst canvas: ${parsed.error}`);
  return new CanvasStore(parsed.value, { actor: PERSON });
}

const block = (canvas: string, snapshot: string, title?: string) => serializeSnapshotBlock({ canvas, snapshot, ...(title ? { title } : {}) });

export function worstPlan(): string {
  const parts = [
    `# ${GERMAN}: Umstellung der Benachrichtigungen von der nächtlichen Abfrage auf Ereignisse in einer Warteschlange`,
    '',
    `Owner: ${EMAIL}. Today a sweep looks for new scans every ten minutes, so the median alert is nine minutes late; 1,284,003.5 alerts a day.`,
    '',
    `## ${TITLE_300}`,
    '',
    block(WORST_CANVAS_ID, 'architecture'),
    '',
    `## ${ARABIC}`,
    '',
    block(WORST_CANVAS_ID, 'evidence'),
    '',
    '## J',
    '',
    block(WORST_CANVAS_ID, 'rollout'),
    '',
    '## A snapshot of one pixel',
    '',
    block(WORST_CANVAS_ID, 'tiny'),
    '',
    '## Very wide, then very tall',
    '',
    block(WORST_CANVAS_ID, 'wide'),
    '',
    block(WORST_CANVAS_ID, 'tall'),
    '',
    '## The whole board',
    '',
    block(WORST_CANVAS_ID, 'whole'),
    '',
    '## Its source was deleted',
    '',
    block(WORST_CANVAS_ID, 'gone'),
    '',
    '## One object, no name',
    '',
    block(WORST_CANVAS_ID, 'one'),
    '',
    '## A caption written in the plan wins',
    '',
    block(WORST_CANVAS_ID, 'emoji', `${SERVICE} → ${EMAIL} → https://runbooks.northwind-industries-holdings.example.com/payments/reconciliation/eu-west/dead-letter-replay`),
    '',
    block(WORST_CANVAS_ID, 'cards'),
    '',
    '## A snapshot that is not on this canvas',
    '',
    block(WORST_CANVAS_ID, 'never-existed', 'Removed before you opened the plan'),
    '',
    block('another-canvas', 'architecture', 'From a canvas this page does not have'),
    '',
    '## Thirty-eight writers',
    '',
  ];
  for (let i = 0; i < 38; i++) parts.push(block(WORST_CANVAS_ID, `fan-${i}`), '');
  return parts.join('\n');
}

// ── The other states ────────────────────────────────────────────────────────

export function createEmptyStore(): CanvasStore {
  return new CanvasStore(createDocument(WORST_CANVAS_ID, ''), { actor: PERSON });
}
export const EMPTY_PLAN = '# A plan with no snapshot\n\nNothing on the canvas yet.\n';

export function createOneStore(): CanvasStore {
  const store = new CanvasStore(createDocument(WORST_CANVAS_ID, 'J'), { actor: PERSON });
  store.dispatch({ type: 'add', objects: [{ id: 'only', type: 'note', x: 0, y: 0, w: 184, h: 158, text: 'J' } as CanvasObject] });
  store.dispatch({ type: 'add-snapshot', snapshot: { id: 'only-snap', title: '', source: { kind: 'objects', objects: ['only'] } } });
  return new CanvasStore(store.getDocument(), { actor: PERSON });
}
export const ONE_PLAN = `# One\n\n${block(WORST_CANVAS_ID, 'only-snap')}\n`;

/** The bench board, plus a snapshot of all of it. */
export function createBigStore(count: number): CanvasStore {
  const store = createLargeStore(count, 0, true);
  const doc = store.getDocument();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of Object.values(doc.objects)) {
    if (!('w' in o)) continue;
    x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x + o.w); y1 = Math.max(y1, o.y + o.h);
  }
  const w = Math.min(20_000, Math.ceil(x1 - x0) + 40);
  const h = Math.min(20_000, Math.ceil(y1 - y0) + 40);
  const r = store.dispatch({ type: 'add-snapshot', snapshot: { id: 'everything', title: `All ${count.toLocaleString('en-US')} objects`, source: { kind: 'region', rect: { x: Math.floor(x0) - 20, y: Math.floor(y0) - 20, w, h } } } });
  if (!r.ok) throw new Error(r.error);
  store.dispatch({ type: 'move', ids: ['b0'], dx: 30, dy: 0 });
  return new CanvasStore(store.getDocument());
}
export const bigPlan = (count: number) => `# ${count.toLocaleString('en-US')} objects\n\nThe whole board, in one figure.\n\n${block('large-board', 'everything')}\n\nText after the figure.\n`;

export function createStackedStore(): CanvasStore {
  const store = new CanvasStore(createDocument(WORST_CANVAS_ID, '500 notes on one spot'), { actor: PERSON });
  const objects = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, type: 'note', x: 200, y: 200, w: 184, h: 158, text: `Note ${i + 1} of 500: imported from the retro board` }));
  store.dispatch({ type: 'add', objects: objects as unknown as CanvasObject[] });
  store.dispatch({ type: 'add-snapshot', snapshot: { id: 'pile', title: '', source: { kind: 'region', rect: { x: 180, y: 180, w: 224, h: 198 } } } });
  return new CanvasStore(store.getDocument(), { actor: PERSON });
}
export const STACKED_PLAN = `# 500 notes on one spot\n\n${block(WORST_CANVAS_ID, 'pile')}\n`;

export function createFarStore(): CanvasStore {
  const store = new CanvasStore(createDocument(WORST_CANVAS_ID, 'Far apart'), { actor: PERSON });
  const at = (id: string, x: number, y: number, text: string) => ({ id, type: 'note', x, y, w: 184, h: 158, text });
  store.dispatch({
    type: 'add',
    objects: [at('nw', -1_000_000, -1_000_000, 'North-west, at −1,000,000'), at('ne', 1_000_000, -1_000_000, 'North-east'), at('c', 0, 0, 'The middle'), at('se', 1_000_000, 1_000_000, 'South-east, at +1,000,000')] as unknown as CanvasObject[],
  });
  store.dispatch({ type: 'add-snapshot', snapshot: { id: 'corners', title: 'Two corners', source: { kind: 'objects', objects: ['nw', 'se'] } } });
  return new CanvasStore(store.getDocument(), { actor: PERSON });
}
export const FAR_PLAN = `# Far apart\n\n${block(WORST_CANVAS_ID, 'corners')}\n`;
