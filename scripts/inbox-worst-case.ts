import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { extractDirName, extractRepoName } from '../packages/core/project';
import { INBOX_BRIDGE_POLL_PATH } from '../packages/shared/inbox/connection';
import { recordInboxAttachments, writeBlob } from '../packages/shared/inbox/attachments';
import { FIXTURE_V1_LOCAL } from '../packages/core/guide-format-fixtures';
import { checkInboxGuide, describeInboxGuide, inboxGuideInputHash } from '../packages/server/inbox-guides';
import { InboxStore } from '../packages/shared/inbox/store';
import { refuseRealDataDir } from '../tests/helpers/real-data-dir';

type Agent = { kind: 'agent'; host: string; session: string; name: string | null };

const CLAUDE: Agent = { kind: 'agent', host: 'claude-code', session: 'ses_wc_claude', name: 'Claude Code' };
const PI: Agent = { kind: 'agent', host: 'pi', session: 'ses_wc_pi', name: 'Pi' };
const CODEX: Agent = { kind: 'agent', host: 'codex', session: 'ses_wc_codex', name: 'Codex (northwind-industries-holdings platform reviewer)' };

export const WORST_CASE_FOLDERS = {
  japanese: '請求サービス',
  arabic: 'خدمة-الفواتير',
  vietnamese: 'dịch-vụ-thanh-toán',
  russian: 'платёжный-сервис',
  apiWork: 'work/api',
  apiHome: 'personal/api',
  long: 'northwind-industries-holdings-platform-billing-service',
  billing: 'billing-svc',
} as const;

export type WorstCaseThread =
  | 'emojiCut'
  | 'arabic'
  | 'vietnamese'
  | 'russian'
  | 'apiWork'
  | 'apiHome'
  | 'multiDay'
  | 'files'
  | 'lastYear'
  | 'thisYear'
  | 'kitchen'
  | 'replaced'
  | 'ended'
  | 'ended2'
  | 'storageUrl'
  | 'archived'
  | 'longFile'
  | 'pill'
  | 'centered'
  | 'kinds'
  | 'guide'
  | 'cards'
  | 'closedCard';

export interface WorstCaseWorld {
  dataDir: string;
  src: string;
  projects: Record<keyof typeof WORST_CASE_FOLDERS, string>;
  threads: Record<WorstCaseThread, string>;
  files: { a: string; b: string; arabic: string; long: string; changed: string };
  kinds: { log: string; yaml: string; csv: string; json: string; pdf: string; pano: string; dot: string; minified: string };
}

const METRICS_TABLE = [
  '| Region | Captures | Refunds | Refund rate | p95 latency | Notes |',
  '| --- | ---: | ---: | ---: | ---: | --- |',
  '| North America | 1,284,112 | 18,402 | 1.43% | 412 ms | steady |',
  '| Europe (incl. UK) | 902,551 | 14,877 | 1.65% | 498 ms | `refund_partial_capture` spikes on Mondays |',
  '| Asia Pacific | 455,020 | 9,912 | 2.18% | 731 ms | processor timeouts in ap-southeast-2 |',
].join('\n');

export function stripedPng(width: number, height: number): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    const band = Math.floor(y / 120) % 3;
    const [r, g, b] = band === 0 ? [99, 102, 241] : band === 1 ? [236, 239, 244] : [16, 185, 129];
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function repo(src: string, folder: string): string {
  const dir = join(src, folder);
  mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return realpathSync(dir);
}

const question = (prompt: string, options: string[], extra: string[] = []) => [':::question', prompt, ...extra, '', ...options.map((o) => `- [ ] ${o}`), ':::'].join('\n');

export async function seedWorstCase(options: { dataDir: string; src?: string; now?: Date; bulk?: number }): Promise<WorstCaseWorld> {
  const dataDir = resolve(refuseRealDataDir(options.dataDir, 'inbox-worst-case'));
  if (existsSync(join(dataDir, 'inbox', 'inbox.json'))) throw new Error(`${dataDir} already has an Inbox: seed a fresh scratch data dir, before the Inbox starts`);
  mkdirSync(dataDir, { recursive: true });
  const src = resolve(options.src ?? join(dirname(dataDir), 'src'));
  const today = options.now ?? new Date();
  let clock = new Date(today.getTime() - 60 * 60_000);
  const store = InboxStore.open(dataDir, { now: () => new Date(clock) });
  const at = (date: Date) => {
    clock = date;
  };
  const tick = () => {
    clock = new Date(clock.getTime() + 5_000);
  };
  const daysAgo = (days: number, hour = 20, minute = 22) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - days, hour, minute);

  const roots = Object.fromEntries(Object.entries(WORST_CASE_FOLDERS).map(([role, folder]) => [role, repo(src, folder)])) as Record<keyof typeof WORST_CASE_FOLDERS, string>;
  const project = (root: string) => store.ensureProject({ root, name: extractRepoName(root) ?? extractDirName(root) ?? 'project' });
  const ids = Object.fromEntries(Object.entries(roots).map(([role, root]) => [role, project(root).id])) as Record<keyof typeof WORST_CASE_FOLDERS, string>;
  let sessions = 0;
  const send = (projectRole: keyof typeof WORST_CASE_FOLDERS, author: Agent, body: string, extra: { subject?: string; thread?: string; reply_to?: string; wakes?: boolean } = {}) => {
    tick();
    const own = extra.thread || extra.reply_to ? author : { ...author, session: `${author.session}_${++sessions}` };
    return store.sendMessage({ project_id: ids[projectRole], author: own, body, ...extra }).message;
  };

  const threads = {} as Record<WorstCaseThread, string>;

  at(new Date(today.getFullYear() - 1, 8, 2, 16, 40));
  threads.lastYear = send('billing', CLAUDE, 'The ledger export from last year is archived in `exports/2025`. Nothing to do.', { subject: 'Ledger export archived (last year)' }).thread_id;
  at(new Date(today.getFullYear(), 8, 10, 9, 15));
  threads.thisYear = send('billing', PI, 'September close is done; the ledger balances.', { subject: 'September close' }).thread_id;

  at(daysAgo(3));
  const day1 = send('long', CLAUDE, 'Started the reconciliation job for the holdings ledger. I will report each day.', { thread: 'reconciliation-run' });
  threads.multiDay = day1.thread_id;
  at(daysAgo(2));
  send('long', CLAUDE, 'Day two: 14 mismatches, all rounding on partial captures.', { thread: 'reconciliation-run' });
  at(daysAgo(1));
  send('long', CLAUDE, 'Day three: mismatches down to 3.', { thread: 'reconciliation-run' });
  at(daysAgo(0, today.getHours() > 0 ? today.getHours() - 1 : 0, 5));
  send('long', CLAUDE, ['Today: the last three mismatches are a currency rounding rule.', '', question('Round half-even or half-up for JPY refunds?', ['Half-even', 'Half-up'])].join('\n'), { thread: 'reconciliation-run' });

  at(new Date(today.getTime() - 50 * 60_000));
  const emojiLead = 'Should the refund worker retry the captures that the processor marked as pending for longer than the retry window, then '.slice(0, 117);
  const emojiPrompt = `${emojiLead}x🧾 and keep the original idempotency key on every retry?`;
  threads.emojiCut = send('japanese', CLAUDE, [question(emojiPrompt, ['Retry with the same key', 'Fail to the dead-letter queue'], ['Stopped: the retry worker cannot ship without this.'])].join('\n')).thread_id;

  threads.arabic = send(
    'arabic',
    PI,
    [
      'تمت مراجعة الفواتير المعلقة لهذا الشهر. وجدنا ثلاث فواتير مكررة في نظام الفوترة القديم، وسنقوم بإلغائها بعد موافقتك.',
      '',
      'The duplicates are in `invoices/legacy`; the English note stays left to right.',
      '',
      question('هل نلغي الفواتير المكررة الآن أم ننتظر حتى نهاية الشهر؟', ['نلغيها الآن', 'ننتظر حتى نهاية الشهر']),
    ].join('\n'),
    { subject: 'مراجعة الفواتير المكررة في نظام الفوترة القديم قبل إغلاق الشهر وإرسال التقرير المالي', thread: 'مراجعة-الفواتير' },
  ).thread_id;
  threads.vietnamese = send('vietnamese', CLAUDE, question('Có nên gửi lại hoá đơn cho khách hàng ở Hà Nội không?', ['Có', 'Không'])).thread_id;
  threads.russian = send('russian', CODEX, 'Платёжный сервис обновлён; миграция прошла без ошибок.', { subject: 'Миграция платёжного сервиса завершена' }).thread_id;
  threads.apiWork = send('apiWork', CLAUDE, 'The API rate limits are raised for the partner tier.', { subject: 'Partner rate limits raised' }).thread_id;
  threads.apiHome = send('apiHome', PI, 'The home API now serves the weather widget again.', { subject: 'Weather widget back' }).thread_id;

  at(daysAgo(2, 15, 10));
  const docs = join(roots.long, 'docs');
  mkdirSync(docs, { recursive: true });
  const files = {
    a: 'SPIKE-claude-code-mobile-annotations-20261011.md',
    b: 'SPIKE-claude-code-mobile-annotations-20261012.md',
    arabic: 'تقرير-المبيعات-الربعي-للمنطقة-الشمالية-٢٠٢٦.md',
    long: `${'quarterly-revenue-reconciliation-for-northwind-industries-holdings-'.repeat(3)}final-v3.md`.slice(-220),
    changed: 'retry-policy-for-partial-captures-and-refunds.md',
  };
  for (const [role, name] of Object.entries(files)) {
    writeFileSync(join(docs, name), `# ${name}\n\nThe ${role} file. Failed refunds are retried with exponential backoff.\n\n${'- A line of notes.\n'.repeat(12)}`);
  }
  const recorded = await recordInboxAttachments(store.dir, Object.values(files).map((name) => join(docs, name)), { base: roots.long, at: clock.toISOString() });
  tick();
  const filesMessage = store.sendMessage({
    project_id: ids.long,
    author: { ...CLAUDE, session: 'ses_wc_files' },
    body: 'Here are the spike notes for both days, the Arabic sales report, the long reconciliation file, and the retry policy.',
    subject: 'Spike notes and reports for review',
    attachments: recorded,
  }).message;
  threads.files = filesMessage.thread_id;
  const changedAttachment = recorded.find((a) => a.name === files.changed)!;
  for (const n of [1, 2]) {
    tick();
    store.saveAnnotation({
      attachment_id: changedAttachment.id,
      version: 'current',
      annotation: { id: `ann-wc-${n}`, type: 'COMMENT', blockId: 'block-0', startOffset: 0, endOffset: 7, originalText: 'Failed', text: `Comment ${n} on the retry policy.`, createdA: clock.getTime() },
    });
  }
  const changedPath = join(docs, files.changed);
  writeFileSync(changedPath, `${readFileSync(changedPath, 'utf8')}\n\nEdited after it was sent: retries stop after five attempts.\n`);
  const edited = daysAgo(1, 11, 4);
  utimesSync(changedPath, edited, edited);

  at(new Date(today.getTime() - 40 * 60_000));
  const [longOnly] = await recordInboxAttachments(store.dir, [join(docs, files.long)], { base: roots.long, at: clock.toISOString() });
  tick();
  threads.longFile = store.sendMessage({ project_id: ids.long, author: { ...PI, session: 'ses_wc_longfile' }, body: 'The reconciliation file, final version.', subject: 'Reconciliation file', attachments: [longOnly!] }).message.thread_id;

  const first = send('long', CODEX, 'Load test started against the holdings ledger.', { thread: 'load-test' });
  threads.pill = first.thread_id;
  store.markSeen(first.thread_id, store.messageCursor(first.id) ?? undefined);
  for (let n = 1; n <= 8; n++) send('long', CODEX, `Load test step ${n}: ${'p95 latency held under 400 ms while the refund worker drained its queue. '.repeat(3)}`, { thread: 'load-test' });

  const shots = join(roots.billing, 'shots');
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, 'checkout-mobile-full-page.png'), stripedPng(390, 4000));
  threads.kitchen = send(
    'billing',
    CLAUDE,
    [
      'Refund metrics for the last 30 days, and the full checkout page as a phone shows it.',
      '',
      METRICS_TABLE,
      '',
      '![The checkout page on a phone](shots/checkout-mobile-full-page.png)',
      '',
      'Dashboard: https://northwind-industries-holdings.atlassian.net/wiki/spaces/BILLING/pages/123456789/Refund+metrics+for+partial+captures+and+chargebacks',
    ].join('\n'),
    { subject: 'Refund metrics and the checkout page on a phone', thread: 'refund-metrics-for-partial-captures-and-chargebacks-q4' },
  ).thread_id;

  const old = send('billing', CLAUDE, question('Should the partial-capture refund worker retry against the processor with the original idempotency key when the processor answers 409?', ['Yes', 'No']), {
    subject: 'Retry rule for partial-capture refunds',
  });
  threads.replaced = old.thread_id;
  const oldKey = store.questionsOf(old.id)[0]!.key;
  send(
    'billing',
    CLAUDE,
    ['I narrowed the question.', '', question('Retry a 409 from the processor with the original idempotency key, but only for captures under 24 hours old?', ['Yes', 'No'], [`Replaces: ${old.id}/${oldKey}`])].join('\n'),
    { reply_to: old.id },
  );

  threads.ended = send('billing', { ...CLAUDE, session: 'ses_wc_gone' }, question('Ship the ledger migration tonight?', ['Yes, tonight', 'Wait for Monday']), { subject: 'Ledger migration tonight?', wakes: true }).thread_id;
  threads.ended2 = send('billing', { ...CLAUDE, session: 'ses_wc_gone2' }, question('Rotate the processor API key this week?', ['Yes', 'Next week']), { subject: 'Rotate the processor key?', wakes: true }).thread_id;

  threads.centered = send('billing', PI, ['A release banner in HTML.', '', '<p align="center">Centered by its own attribute.</p>', '', '<div align="center">', '<p>Centered by its parent.</p>', '</div>'].join('\n'), { subject: 'Release banner' }).thread_id;

  threads.storageUrl = send('billing', PI, 'The incident write-up is published.', {
    subject: 'https://northwind-industries-holdings.atlassian.net/wiki/spaces/BILLING/pages/987654321/Incident+2026-10-04+partial+capture+refunds+double+posted',
  }).thread_id;

  const archived = send('billing', CLAUDE, 'Archived after the review.', {
    subject: 'Refund worker: retry policy for partial captures and the dead-letter queue for processor timeouts',
    thread: 'refund-worker-retry-policy-review',
  });
  threads.archived = archived.thread_id;
  tick();
  store.resolveThread(archived.id, true);

  tick();
  send('billing', CLAUDE, question('Which ledger owns reversal entries?', ['The refunds ledger', 'The main ledger']), { subject: 'Ledger ownership' });

  at(new Date(today.getTime() - 30 * 60_000));
  const artifacts = join(roots.billing, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const kinds = {
    log: 'refund-worker.log',
    yaml: 'deploy.yaml',
    csv: 'refunds-by-region.csv',
    json: 'processor-settings.json',
    pdf: 'payments-api-reference.pdf',
    pano: 'checkout-funnel-panorama.png',
    dot: 'tracking-pixel.png',
    minified: 'checkout.bundle.min.js',
  };
  writeFileSync(
    join(artifacts, kinds.log),
    [
      '# refund-worker, run 4412',
      '2026-10-12T20:21:58Z INFO  worker started (queue=refunds, concurrency=8)',
      '2026-10-12T20:22:03Z WARN  capture cap_9Hd2 pending for 26m, retrying with key idem_77a1',
      '    at RefundWorker.retry (src/worker.ts:88)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95)',
      '2026-10-12T20:22:04Z ERROR processor answered 409 for cap_9Hd2',
      '2026-10-12T20:22:09Z INFO  dead-lettered cap_9Hd2 after 5 attempts',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(artifacts, kinds.yaml),
    ['# deploy settings for the refund worker', 'services:', '  refund-worker:', '    image: registry.internal/refund-worker:1.4.2', '    replicas: 3', '    env:', '      RETRY_LIMIT: "5"', '      DEAD_LETTER_QUEUE: refunds-dlq', ''].join('\n'),
  );
  writeFileSync(join(artifacts, kinds.csv), ['region,captures,refunds,refund_rate', 'North America,1284112,18402,1.43%', 'Europe,902551,14877,1.65%', 'Asia Pacific,455020,9912,2.18%', ''].join('\n'));
  writeFileSync(join(artifacts, kinds.json), `${JSON.stringify({ processor: { retries: { limit: 5, backoff: 'exponential', keys: ['idempotency', 'capture_id'] } }, deadLetter: { queue: 'refunds-dlq' } }, null, 2)}\n`);
  writeFileSync(join(artifacts, kinds.pdf), '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  writeFileSync(join(artifacts, kinds.pano), stripedPng(8000, 300));
  writeFileSync(join(artifacts, kinds.dot), stripedPng(1, 1));
  writeFileSync(join(artifacts, kinds.minified), `!function(){${Array.from({ length: 6000 }, (_, n) => `var r${n}=t.refund(${n},"cap_${n}");`).join('')}}();\n`);
  const kindsRecorded = await recordInboxAttachments(store.dir, Object.values(kinds).map((name) => join(artifacts, name)), { base: roots.billing, at: clock.toISOString() });
  tick();
  threads.kinds = store.sendMessage({
    project_id: ids.billing,
    author: { ...CLAUDE, session: 'ses_wc_kinds' },
    body: 'The worker log, the deploy settings, the refund figures, the processor settings, the API reference, the funnel panorama, the tracking pixel and the minified checkout bundle.',
    subject: 'Refund worker artifacts',
    attachments: kindsRecorded,
  }).message.thread_id;

  tick();
  const guideSnapshot = {
    ...FIXTURE_V1_LOCAL,
    guide: {
      ...FIXTURE_V1_LOCAL.guide,
      sections: [{ ...FIXTURE_V1_LOCAL.guide.sections[0]!, overview: '## Why it matters\n\nThe refresh function now rejects a missing token instead of echoing it back.' }],
      unplacedFiles: ['package.json'],
      reviewed: [false],
    },
  };
  const checkedGuide = checkInboxGuide({ snapshot: guideSnapshot }, roots.billing);
  if (!checkedGuide.ok) throw new Error(`the seed's guided review is invalid: ${checkedGuide.error}`);
  const described = describeInboxGuide(checkedGuide.snapshot, inboxGuideInputHash({ snapshot: guideSnapshot }));
  const guideMessage = store.sendMessage({
    project_id: ids.billing,
    author: { ...CLAUDE, session: 'ses_wc_guide' },
    body: 'A guided review of the token refresh change.',
    subject: 'Guided review: token refresh',
    guide: described.ref,
  }).message;
  writeBlob(store.dir, described.ref.sha256, Buffer.from(described.text, 'utf8'));
  threads.guide = guideMessage.thread_id;

  const cardsMessage = send(
    'billing',
    PI,
    [
      [':::question', 'Which store backs the refund idempotency cache?', '', '- [ ] Redis', '- [ ] Memcached', '', 'Recommended: SQLite on the worker box', ':::'].join('\n'),
      '',
      question('Page the on-call for dead-lettered refunds?', ['Yes, every one', 'Only above 10 an hour']),
    ].join('\n'),
    { subject: 'Idempotency cache and paging' },
  );
  threads.cards = cardsMessage.thread_id;
  const paging = store.questionsOf(cardsMessage.id)[1]!;
  tick();
  store.savePicks(cardsMessage.id, [{ key: paging.key, revision: paging.revision, answer: { v: 1, key: paging.key, kind: 'single', prompt: paging.prompt, selected: ['Only above 10 an hour'] } }]);
  const closed = send('billing', CODEX, question('Keep the legacy refund endpoint for one more release?', ['Keep it', 'Remove it']), { subject: 'Legacy refund endpoint' });
  threads.closedCard = closed.thread_id;
  tick();
  store.markRead(closed.thread_id, true);

  for (let n = 1; n <= 38; n++) {
    const root = repo(src, `client-portal-${String(n).padStart(2, '0')}`);
    tick();
    const sent = store.sendMessage({ project_id: project(root).id, author: PI, body: 'Nightly build is green.', subject: 'Nightly build green' }).message;
    store.markSeen(sent.thread_id);
  }

  if (options.bulk && options.bulk > 0) {
    const root = repo(src, 'bulk-load');
    const bulk = project(root).id;
    for (let n = 0; n < options.bulk; n++) {
      tick();
      store.sendMessage({ project_id: bulk, author: { ...PI, session: `ses_wc_bulk_${n}` }, body: question(`Approve batch ${n + 1}?`, ['Yes', 'No']), subject: `Batch ${n + 1}` });
    }
  }

  return { dataDir, src, projects: roots, threads, files, kinds };
}

export class LiveSessions {
  private stopped = false;
  private readonly loops: Promise<void>[] = [];
  constructor(
    private readonly dataDir: string,
    projectPath: string,
    count: number,
    host = 'claude-code',
  ) {
    const started = Date.now() - 60 * 60_000;
    for (let n = 0; n < count; n++) this.loops.push(this.run(`ses_wc_live_${String(n).padStart(2, '0')}`, projectPath, host, started + n * 60_000));
  }

  private async run(session: string, projectPath: string, host: string, startedAt: number): Promise<void> {
    while (!this.stopped) {
      const { port, token } = JSON.parse(readFileSync(join(this.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
      await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session, host, waitMs: 1_000, project_path: projectPath, started_at: startedAt, busy: false, idle_since: startedAt }),
      }).catch(() => new Promise((r) => setTimeout(r, 250)));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.loops);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dataDir = flag('--data-dir');
  if (!dataDir) {
    process.stderr.write('Usage: bun scripts/inbox-worst-case.ts --data-dir <scratch data dir> [--src <folder>] [--bulk <n>] [--now <ISO date>]\n');
    process.exit(2);
  }
  const now = flag('--now');
  const world = await seedWorstCase({ dataDir, src: flag('--src'), bulk: Number(flag('--bulk') ?? 0), ...(now ? { now: new Date(now) } : {}) });
  process.stdout.write(`${JSON.stringify(world, null, 2)}\n`);
}

if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' && process.argv[1] && /inbox-worst-case\.ts$/.test(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
