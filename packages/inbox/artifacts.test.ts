/**
 * A thread's artifact list (artifacts.ts; approval "inbox-thread-artifacts"):
 * the one list both the Artifacts grid and the viewer's stepping read. What
 * this catches: a kind left out of the grid (a download, a guided review, the
 * person's pasted file), the grid in thread order instead of newest first
 * (or messages split apart), an image shown in the text AND attached counted
 * twice, and the viewer's stepping drifting from the grid (a guide stepped
 * into, or a file missing from one of them).
 */
import { expect, test } from 'bun:test';
import type { InboxAttachmentState, InboxGuideRef, InboxMessageWire } from '@plannotator/core/inbox-types';
import { artifactKey, artifactOfFile, artifactsNewestFirst, threadArtifacts } from './artifacts';
import { attachmentSequence, stepIndexOf, stepsOf } from './stepping';
import { artifactChanged, artifactDetail, artifactLabel } from './components/ArtifactsView';
import { inboxHtmlArtifactKey, inboxHtmlBlockHash } from '@plannotator/core/inbox-html-blocks';

const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';
const M2 = 'msg_01K7M2MMMMMMMMMMMMMMMMMMMM';
const M3 = 'msg_01K7M3MMMMMMMMMMMMMMMMMMMM';
const M4 = 'msg_01K7M4MMMMMMMMMMMMMMMMMMMM';

function file(id: string, name: string, kind: string, messageId: string, extra: Partial<InboxAttachmentState> = {}): InboxAttachmentState {
  return {
    id,
    name,
    path: `/work/shop/${name}`,
    kind: kind as InboxAttachmentState['kind'],
    named_path: null,
    sent_sha256: 'a'.repeat(64),
    size: 1000,
    sent_at: '2026-10-10T10:42:00.000Z',
    sent_mtime: '2026-10-10T10:42:00.000Z',
    message_id: messageId,
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
    ...extra,
  };
}

const GUIDE: InboxGuideRef = { sha256: 'b'.repeat(64), input_sha256: 'c'.repeat(64), bytes: 900, title: 'Checkout drawer, file by file', sections: 3, files: 6, additions: 184, deletions: 62 };

function agent(id: string, createdAt: string, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return { id, created_at: createdAt, author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' }, ...extra } as unknown as InboxMessageWire;
}
function person(id: string, createdAt: string): InboxMessageWire {
  return { id, created_at: createdAt, author: { kind: 'person' } } as unknown as InboxMessageWire;
}

const messages = [
  agent(M1, '2026-10-10T09:12:00.000Z'),
  person(M2, '2026-10-10T09:40:00.000Z'),
  agent(M3, '2026-10-10T11:30:00.000Z', { guide: GUIDE }),
  agent(M4, '2026-10-10T13:52:00.000Z'),
];
// In the text of M1 and also attached to it: one file on disk, two records.
const beforeInline = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'checkout-before.png', 'image', M1, { ref: 'design/checkout-before.png', media_type: 'image/png', width: 1280, height: 800 });
const beforeAttached = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'checkout-before.png', 'image', M1, { media_type: 'image/png', width: 1280, height: 800 });
const spec = file('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'checkout-spec.md', 'markdown', M1, { changed_since_sent: true, current: { sha256: 'd'.repeat(64), size: 1200, mtime: '2026-10-10T14:14:00.000Z' } });
const sketch = file('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'mobile-pay-sketch.png', 'image', M2, { media_type: 'image/png', width: 900, height: 1300 });
const video = file('att_01K7EEEEEEEEEEEEEEEEEEEEEE', 'walkthrough.webm', 'video', M3, { media_type: 'video/webm' });
const pdf = file('att_01K7FFFFFFFFFFFFFFFFFFFFFF', 'checkout-perf.pdf', 'pdf', M3, { media_type: 'application/pdf' });
const sql = file('att_01K7GGGGGGGGGGGGGGGGGGGGGG', '0042_checkout_sessions.sql', 'code', M4, { size: 331, current: { sha256: 'a'.repeat(64), size: 331, mtime: '2026-10-10T13:52:00.000Z' } });
const zip = file('att_01K7HHHHHHHHHHHHHHHHHHHHHH', 'e2e-traces.zip', 'file', M4);

// The model lists the records in any order; the thread's order decides.
const ARTIFACTS = threadArtifacts(messages, [video, sql, spec, beforeAttached, pdf, zip, sketch], [beforeInline]);

test('every kind counts: attachments of every kind, images in the text, the person\'s pasted file, one guided review per message', () => {
  expect(ARTIFACTS.map(artifactKey)).toEqual([beforeInline.id, spec.id, sketch.id, video.id, pdf.id, `guide:${M3}`, sql.id, zip.id]);
  expect(ARTIFACTS.map((a) => a.type)).toEqual(['file', 'file', 'file', 'file', 'file', 'guide', 'file', 'file']);
  const mine = ARTIFACTS.find((a) => a.type === 'file' && a.attachment.id === sketch.id)!;
  expect(mine.sender).toBe('You');
  expect(mine.fromPerson).toBe(true);
  expect(mine.host).toBeNull();
  expect(ARTIFACTS[0]!.host).toBe('claude-code');
});

test('an image shown in the text and attached to the same message is one artifact, opened by either record', () => {
  const before = ARTIFACTS.filter((a) => a.type === 'file' && a.attachment.name === 'checkout-before.png');
  expect(before).toHaveLength(1);
  expect(before[0]!.type === 'file' && before[0]!.inline).toBe(true);
  expect(before[0]!.type === 'file' && before[0]!.alsoIds).toEqual([beforeAttached.id]);
  expect(artifactOfFile(ARTIFACTS, beforeAttached.id)?.attachment.id).toBe(beforeInline.id);
  // The same image in two different messages stays two artifacts.
  const later = file('att_01K7JJJJJJJJJJJJJJJJJJJJJJ', 'checkout-before.png', 'image', M4, { ref: 'design/checkout-before.png' });
  expect(threadArtifacts(messages, [beforeAttached], [beforeInline, later]).filter((a) => a.type === 'file')).toHaveLength(2);
});

test('the grid is newest message first, each message keeping its own order', () => {
  expect(artifactsNewestFirst(ARTIFACTS).map(artifactKey)).toEqual([sql.id, zip.id, video.id, pdf.id, `guide:${M3}`, sketch.id, beforeInline.id, spec.id]);
});

test('the viewer steps through the same list in thread order, its files only; a twin record finds its step', () => {
  const steps = stepsOf(ARTIFACTS);
  expect(steps.map((s) => s.attachment.id)).toEqual(ARTIFACTS.filter((a) => a.type === 'file').map(artifactKey));
  // The grid counts the guide; the viewer does not (it opens its own reader).
  expect(ARTIFACTS.length - steps.length).toBe(1);
  expect(attachmentSequence(messages, [video, sql, spec, beforeAttached, pdf, zip, sketch], [beforeInline])).toEqual(steps);
  expect(stepIndexOf(steps, beforeAttached.id)).toBe(0);
  expect(stepIndexOf(steps, spec.id)).toBe(1);
  expect(stepIndexOf(steps, 'att_01K7ZZZZZZZZZZZZZZZZZZZZZZ')).toBe(-1);
});

test('a file whose message is not in the thread still counts, last', () => {
  const stray = file('att_01K7KKKKKKKKKKKKKKKKKKKKKK', 'stray.md', 'markdown', 'msg_gone');
  expect(threadArtifacts([messages[0]!], [stray, spec]).map(artifactKey)).toEqual([spec.id, stray.id]);
});

test('a tile says everything it shows in its name, in the Inbox\'s own words', () => {
  const at = (id: string) => ARTIFACTS.find((a) => artifactKey(a) === id)!;
  expect(artifactDetail(at(beforeInline.id))).toBe('PNG image, 1280 × 800, 1000 B');
  expect(artifactDetail(at(sql.id))).toBe('Code (.sql), 331 B');
  expect(artifactDetail(at(`guide:${M3}`))).toBe('Guided review, 3 sections, 6 files');
  expect(artifactLabel(at(beforeInline.id), 1)).toMatch(/^checkout-before\.png, PNG image, 1280 × 800, 1000 B, from Claude Code at .+, shown in the message text, 1 comment$/);
  expect(artifactLabel(at(sketch.id), 0)).toMatch(/^mobile-pay-sketch\.png, PNG image, 900 × 1300, 1000 B, from you at /);
  expect(artifactLabel(at(spec.id), 2)).toMatch(/, changed since it was sent, 2 comments$/);
  expect(artifactLabel(at(zip.id), 0)).toMatch(/^Download e2e-traces\.zip, ZIP file, /);
  expect(artifactLabel(at(pdf.id), 0)).toMatch(/^Download checkout-perf\.pdf, PDF, /);
  expect(artifactLabel(at(`guide:${M3}`), 0)).toMatch(/^Guided review: Checkout drawer, file by file, 3 sections, 6 files, 184 lines added, 62 removed, from Claude Code at /);
  expect(artifactChanged(spec)?.short).toBe('Changed since sent');
  expect(artifactChanged({ ...spec, captured: 'on_open' })?.short).toBe('Changed since opened');
  expect(artifactChanged({ ...spec, unavailable: { code: 'attachment_missing', message: 'gone' } })?.short).toBe('No longer on disk');
  expect(artifactChanged(sql)).toBeNull();
});

const TIDES = '<h2>Harbor · tide table</h2><table><tr><td>06:12</td></tr></table>';
const BERTHS = '<div id="chart"></div><script src="https://cdn.example/chart.js"></script>';
const pageBody = (first: string) => ['The berths:', '', '![Berth plan](berths.png)', '', '![Walkthrough](walkthrough.webm)', '', '```html', first, '```', '', '```html', BERTHS, '```'].join('\n');

test('an agent\'s html blocks are artifacts in its text, after its picture and film: their own keys, never the viewer\'s steps', () => {
  const picture = file('att_01K7PPPPPPPPPPPPPPPPPPPPPP', 'berths.png', 'image', M1, { ref: 'berths.png', media_type: 'image/png', width: 960, height: 600 });
  const film = file('att_01K7QQQQQQQQQQQQQQQQQQQQQQ', 'walkthrough.webm', 'video', M1, { ref: 'walkthrough.webm', media_type: 'video/webm' });
  const notes = file('att_01K7RRRRRRRRRRRRRRRRRRRRRR', 'notes.md', 'markdown', M1);
  const read = (body: string) => threadArtifacts([agent(M1, '2026-10-10T09:12:00.000Z', { body })], [notes], [picture, film]);
  const list = read(pageBody(TIDES));
  const tides = inboxHtmlArtifactKey(M1, inboxHtmlBlockHash(TIDES));
  const berths = inboxHtmlArtifactKey(M1, inboxHtmlBlockHash(BERTHS));
  expect(list.map(artifactKey)).toEqual([picture.id, film.id, tides, berths, notes.id]);
  expect(list.map((a) => a.type)).toEqual(['file', 'file', 'html', 'html', 'file']);
  // The tile's words: the page's heading (else "HTML block"), an attached page's kind and size, in the text.
  const pages = list.filter((a) => a.type === 'html');
  expect(pages.map((a) => artifactLabel(a, 0))).toEqual([
    expect.stringMatching(/^Harbor · tide table, HTML, \d+ B, from Claude Code at .+, shown in the message text$/),
    expect.stringMatching(/^HTML block, HTML, \d+ B, from Claude Code at .+, shown in the message text$/),
  ]);
  // The viewer steps through the files only.
  expect(stepsOf(list).map((s) => s.attachment.id)).toEqual([picture.id, film.id, notes.id]);
  // A second read (new objects), and the other block edited: the berths block keeps its key, so its pin stays on it.
  expect(read(pageBody(TIDES)).map(artifactKey)).toEqual(list.map(artifactKey));
  const edited = read(pageBody('<h2>Harbor · tide table, revised</h2>')).map(artifactKey);
  expect(edited).toContain(berths);
  expect(edited).not.toContain(tides);
  expect(edited.indexOf(berths)).toBe(3);
  // The person's own text holds none.
  expect(threadArtifacts([{ ...person(M2, '2026-10-10T09:40:00.000Z'), body: pageBody(TIDES) } as InboxMessageWire], [], []).length).toBe(0);
});
