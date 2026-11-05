/**
 * Named icons, logos and drawn things on a Shape board (`shape update` stamps them; see
 * apps/hook/server/shape-command.test.ts for the command). What regresses if these fail: a name draws
 * nothing (or something the board's checks then refuse), a logo loses its colour or trips the
 * fixed-colour note, a stamp points outside the board so showing it would fetch something, a board
 * stored again grows a second copy, a missing name goes unsaid, a label's words become markup or sit
 * over a server's slots, or the stamps' copy of the kit's marks drifts from the kit.
 */
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
    // A coloured mark keeps its colour inside.
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
    // The only reference in any stamp is Codex's own picture, inline.
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
});
