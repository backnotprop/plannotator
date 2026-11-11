/** Named icons, logos and drawn things on a Shape board: names draw real SVG, a re-stored board is left alone, edits redraw, missing names are reported, and the stamps' copy of the kit's marks stays in sync. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkShapeBoard, shapeBoardNotes, shapeHtmlProblems } from '@plannotator/core/shape';
import { STAMP_CODEX, STAMP_ICONS, STAMP_LOGOS, STAMP_MARKS } from './stamp-data';
import { expandBoardStamps, expandShapeStamps, SHAPE_DRAWN_OBJECTS } from './stamps';
// @ts-expect-error the kit is plain JavaScript, with no types
import { icon, logo, thing } from '@plannotator/core/shape-kit.mjs';

const board = (html: string) => ({ title: 'T', claim: 'C', views: { picture: { html: `<svg viewBox="0 0 900 500">${html}</svg>`, width: 900, height: 500 } }, refs: [] });

describe('stamps', () => {
  test("an icon by name becomes its drawing, keeps what the agent wrote on it, and passes the board's checks", () => {
    const { html, missing } = expandShapeStamps('<svg data-icon="server" data-mark="api" x="10" y="20" width="28" height="28" style="color:var(--blue)"/>');
    expect(missing).toEqual([]);
    expect(html).toMatch(/viewBox="0 0 24 24"><rect /);
    expect(html).toContain('data-mark="api"');
    expect(html).toContain('style="color:var(--blue)"');
    expect(html).toContain('stroke="currentColor"');
    expect(shapeHtmlProblems(html)).toEqual([]);
  });

  test("Lucide's old names and a few plain words still find the icon", () => {
    for (const name of ['alert-triangle', 'db', 'phone', 'home']) expect(expandShapeStamps(`<svg data-icon="${name}"/>`).html).toContain('<path');
  });

  test('a logo keeps its own colour and is not counted as a fixed colour', () => {
    const r = checkShapeBoard(expandBoardStamps(board('<svg data-logo="stripe" x="0" y="0"/><svg data-logo="github" x="50" y="0"/><rect x="0" y="0" width="900" height="500"/>')).board);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const html = r.value.views.picture!.html;
    expect(html).toContain('fill="#635BFF"');
    expect(html).toContain('<svg data-brand');
    expect(shapeBoardNotes(r.value).some((n) => n.includes('fixed colours'))).toBe(false);
  });

  test('a near-black logo follows the ink, so it shows on a dark board', () => {
    for (const name of ['x', 'github']) expect(expandShapeStamps(`<svg data-logo="${name}"/>`).html).toContain('fill:var(--ink)');
    expect(expandShapeStamps('<svg data-logo="claude"/>').html).toContain('fill="#d97757"');
  });

  test('a drawn thing fills its box, with its label as words, not markup', () => {
    const { html } = expandShapeStamps('<svg data-draw="database" x="0" y="0" width="160" height="120" data-label="<b>Postgres</b>"/>');
    expect(html).toContain('viewBox="0 0 160 120"');
    expect(html).toContain('&lt;b&gt;Postgres&lt;/b&gt;</text>');
    expect(shapeHtmlProblems(html)).toEqual([]);
  });

  test('data-to sends it along: the move is the distance from where it starts', () => {
    const { html } = expandShapeStamps('<svg data-draw="envelope" x="100" y="40" width="56" height="40" data-to="400 90"/>');
    expect(html).toMatch(/^<g class="shp-go" style="--dx:300px;--dy:50px"><svg /);
  });

  test('a name we lack draws nothing, and the note names it and what is close', () => {
    const stamped = expandBoardStamps(board('<svg data-icon="serverr" x="0" y="0"/><svg data-logo="typesense" x="40" y="0"/>'));
    expect(stamped.missing.length).toBe(2);
    const r = checkShapeBoard(stamped.board);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const notes = shapeBoardNotes(r.value);
    expect(notes.some((n) => n.startsWith('data-icon="serverr"') && n.includes('server'))).toBe(true);
    expect(notes.some((n) => n.startsWith('data-logo="typesense"'))).toBe(true);
  });

  test('storing a board read back does not draw it twice; a fixed name is drawn the next time', () => {
    const once = expandShapeStamps('<svg data-icon="key" x="0" y="0"/><svg data-icon="keyy" x="0" y="0"/>').html;
    expect(expandShapeStamps(once).html).toBe(once);
    const fixed = expandShapeStamps(once.replace('data-icon="keyy"', 'data-icon="lock"'));
    expect(fixed.missing).toEqual([]);
    expect(fixed.html).not.toContain('data-missing');
  });

  test('nothing is fetched when a board is shown: every icon, logo, mark and drawn thing is plain SVG the checks accept', () => {
    const named = [
      ...Object.keys(STAMP_ICONS).map((n) => `<svg data-icon="${n}"/>`),
      ...[...Object.keys(STAMP_LOGOS), ...Object.keys(STAMP_MARKS), 'codex'].map((n) => `<svg data-logo="${n}"/>`),
      ...SHAPE_DRAWN_OBJECTS.map((n) => `<svg data-draw="${n}" x="0" y="0" data-label="L" data-to="10 10"/>`),
    ];
    const { html, missing } = expandShapeStamps(named.join(''));
    expect(missing).toEqual([]);
    expect(html).not.toMatch(/data-(icon|logo|draw)="[^"]*"[^>]*\/>/);
    expect(shapeHtmlProblems(html)).toEqual([]);
    expect([...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]!.slice(0, 22))).toEqual(['data:image/png;base64,']);
    expect(html).not.toMatch(/url\(|https?:/);
  });

  test("the stamps draw the kit's own marks exactly as `plannotator shape kit` does", () => {
    const kit = readFileSync(join(import.meta.dir, '../../core/shape-kit.mjs'), 'utf8');
    expect(STAMP_MARKS).toEqual(JSON.parse(kit.match(/^const MARKS = (\{.*\});$/m)![1]!));
    expect(STAMP_CODEX).toBe(kit.match(/^const CODEX = "([^"]+)";$/m)![1]!);
  });

  test("the kit's helpers write what shape update fills in", () => {
    const r = expandShapeStamps(icon('server', 0, 0) + logo('stripe', 40, 0) + thing('envelope', 0, 40, 56, 40, { to: [200, 40], label: 'Event' }));
    expect(r.missing).toEqual([]);
    expect(r.html).toContain('<svg data-brand');
    expect(r.html).toContain('class="shp-go"');
    expect(r.html).toContain('>Event</text>');
  });

  test('a label on a server or queue sits under it, not over its slots', () => {
    const { html } = expandShapeStamps('<svg data-draw="queue" x="100" y="50" width="200" height="60" data-label="jobs"/>');
    expect(html).toMatch(/<\/svg><text x="200" y="133[^"]*"[^>]*>jobs<\/text><\/g>$/);
  });
  test('an ampersand, a < or a quote in a label shows once, however often the board is stored', () => {
    const once = expandShapeStamps(thing('database', 0, 0, 160, 120, { label: 'R&D' }) + thing('queue', 0, 200, 200, 60, { label: 'a < b "c"' })).html;
    expect(once).toContain('>R&amp;D</text>');
    expect(once).toContain('data-label="R&amp;D"');
    expect(once).toContain('>a &lt; b &quot;c&quot;</text></g>');
    expect(expandShapeStamps(once).html).toBe(once);
    // A name we lack is redrawn empty on every store: what the agent wrote on it stays as written.
    const missing = '<svg data-icon="serverr" aria-label="R&amp;D" style="font-family:&quot;Inter&quot;" x="1" y="2"/>';
    const first = expandShapeStamps(missing).html;
    expect(first).toContain('aria-label="R&amp;D"');
    expect(first).toContain('style="font-family:&quot;Inter&quot;"');
    const third = expandShapeStamps(expandShapeStamps(first).html).html;
    expect(third).toBe(first);
  });

  test('an edited name, label, size, place or move on a filled element is drawn again; one drawn by hand is left alone', () => {
    const fresh = (el: string) => expandShapeStamps(el).html;
    const around = (el: string) => `<g data-mark="a">${el}<rect x="0" y="0" width="9" height="9"/></g>`;
    const edits: [string, string][] = [
      ['<svg data-icon="key" x="0" y="0"/>', '<svg data-icon="lock" x="0" y="0"/>'],
      ['<svg data-logo="stripe" x="0" y="0"/>', '<svg data-logo="redis" x="0" y="0"/>'],
      ['<svg data-draw="database" x="0" y="0" width="160" height="120" data-label="Postgres"/>', '<svg data-draw="database" x="0" y="0" width="160" height="120" data-label="MySQL"/>'],
      ['<svg data-draw="database" x="0" y="0" width="160" height="120" data-label="Postgres"/>', '<svg data-draw="database" x="0" y="0" width="200" height="120" data-label="Postgres"/>'],
      ['<svg data-draw="queue" x="100" y="50" width="200" height="60" data-label="jobs" data-to="300 50"/>', '<svg data-draw="queue" x="120" y="50" width="200" height="60" data-label="jobs" data-to="300 50"/>'],
      ['<svg data-draw="queue" x="100" y="50" width="200" height="60" data-label="jobs" data-to="300 50"/>', '<svg data-draw="queue" x="100" y="50" width="200" height="60" data-label="jobs" data-to="400 90"/>'],
      ['<svg data-draw="envelope" x="0" y="0" width="56" height="40" data-label="Event" data-to="300 0"/>', '<svg data-draw="server" x="0" y="0" width="56" height="40" data-label="Event"/>'],
    ];
    for (const [before, after] of edits) {
      const stored = fresh(around(before));
      const read = stored.replace(/^(<g data-mark="a">)(<g[^>]*>)*<svg[^>]*>/, (open) => {
        const was = new Map([...before.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
        const now = new Map([...after.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
        let edited = open;
        for (const [k, v] of was) edited = edited.replace(` ${k}="${v}"`, now.has(k) ? ` ${k}="${now.get(k)}"` : '');
        for (const [k, v] of now) if (!was.has(k)) edited = edited.replace(/ data-stamped=/, ` ${k}="${v}" data-stamped=`);
        return edited;
      });
      expect(read).not.toBe(stored);
      expect(expandShapeStamps(read).html).toBe(fresh(around(after)));
    }
    const byHand = '<svg data-icon="key" viewBox="0 0 24 24"><circle r="3"/></svg>';
    expect(expandShapeStamps(byHand).html).toBe(byHand);
  });

  test("Object's own names are names we lack, for icons, logos and drawn things", () => {
    for (const attr of ['data-icon', 'data-logo', 'data-draw'])
      for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        const r = expandShapeStamps(`<svg ${attr}="${name}" x="0" y="0"/>`);
        expect(r.missing.length).toBe(1);
        expect(r.html).toMatch(/^<svg [^>]*data-missing="[^"]*"\/>$/);
      }
  });

  test('a name past 64 characters gets no close names, so a long one costs nothing', () => {
    expect(expandShapeStamps(`<svg data-icon="${'x'.repeat(64)}"/>`).missing[0]).toContain('; close: x');
    expect(expandShapeStamps(`<svg data-icon="${'x'.repeat(65)}"/>`).missing[0]).not.toContain('close:');
  });

  test('a missing name in the phone drawing or More is a note too, and each name once', () => {
    const b = board('<svg data-icon="serverr" x="0" y="0"/><svg data-icon="serverr" x="40" y="0"/><rect x="0" y="0" width="900" height="500"/>') as { views: { picture: Record<string, unknown> } };
    b.views.picture.tall = { html: '<svg viewBox="0 0 400 800"><svg data-icon="serverr" x="0" y="0"/><svg data-logo="typesensee" x="0" y="40"/></svg>' };
    const r = checkShapeBoard(expandBoardStamps(b).board);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const notes = shapeBoardNotes(r.value);
    expect(notes.filter((n) => n.startsWith('data-icon="serverr"')).length).toBe(1);
    expect(notes.filter((n) => n.startsWith('data-logo="typesensee"')).length).toBe(1);
  });

  test('a board of the wrong shape reaches the checks as written', () => {
    for (const odd of [['a'], { title: 'T', views: ['a'] }, { title: 'T', views: { picture: ['<svg data-icon="key"/>'] } }]) {
      const r = expandBoardStamps(odd);
      expect(JSON.stringify(r.board)).toBe(JSON.stringify(odd));
    }
  });
});
