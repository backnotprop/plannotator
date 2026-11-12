/**
 * What regresses: tags land on an arrow's label, on another part's edge or on a line, as on a
 * real agent's board, where a second tag on the same part was pushed up onto the box above.
 */
import { describe, expect, test } from 'bun:test';
import { besideOf, bestSpot, type Box } from './followPainter';

const box = (left: number, top: number, w: number, h: number): Box => ({ left, top, right: left + w, bottom: top + h });
const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const at = (t: Box, go: { dx: number; dy: number }): Box => ({ left: t.left + go.dx, top: t.top + go.dy, right: t.right + go.dx, bottom: t.bottom + go.dy });
const anywhere = () => true;
const beside = (part: Box) => besideOf(part, 'mark');

const part = box(300, 300, 240, 64);
const tag = box(358, 270, 170, 26);

describe('a step tag that covers something', () => {
  test('steps off an arrow label to the nearest free spot over its own part', () => {
    const label = box(420, 276, 70, 14);
    const go = bestSpot([tag], [label], [], anywhere, beside(part))!;
    const r = at(tag, go);
    expect(meets(r, label)).toBe(false);
    expect(beside(part)(r)).toBe(true);
    expect(go).toMatchObject({ spot: 0, dx: 0, dy: -24 });
  });

  test('a second tag on the same part never lands on the part above it', () => {
    const placed = box(354, 266, 178, 34);
    const above = box(300, 172, 240, 64);
    const go = bestSpot([tag], [placed, above], [], anywhere, beside(part))!;
    const r = at(tag, go);
    expect(meets(r, above)).toBe(false);
    expect(meets(r, placed)).toBe(false);
    expect(beside(part)(r)).toBe(true);
  });

  test("takes its part's other edge when the first has no room", () => {
    const crowd = box(0, 0, 2000, 300);
    const under = box(358, 351, 170, 26);
    const go = bestSpot([tag, under], [crowd], [], anywhere, beside(part))!;
    expect(go.spot).toBe(1);
    expect(meets(at(under, go), crowd)).toBe(false);
  });

  test('never floats off its own part, even when that spot is nearer', () => {
    const overTop = box(250, 256, 400, 44);
    const nearBottom = box(300, 340, 140, 60);
    const under = box(358, 351, 170, 26);
    // The middle of its own part is taken too, as the painter passes it: a tag sits on an edge, never across the box.
    const middle = box(300, 313.5, 240, 37);
    const go = bestSpot([tag, under], [overTop, nearBottom, middle], [], anywhere, beside(part))!;
    expect(go.spot).toBe(1);
    expect(beside(part)(at(under, go))).toBe(true);
  });

  test("a crowded phone: a tag meets another tag before it covers the drawing's words", () => {
    const label = box(250, 240, 400, 60);
    const placed = box(250, 340, 400, 100);
    const under = box(358, 351, 170, 26);
    const middle = box(300, 313.5, 240, 37);
    const go = bestSpot([tag, under], [placed, middle], [], anywhere, beside(part), [label])!;
    expect(go.spot).toBe(1);
    expect(meets(at(under, go), label)).toBe(false);
    expect(beside(part)(at(under, go))).toBe(true);
  });

  test('crosses no line where a free spot nearby crosses none', () => {
    const line = Array.from({ length: 12 }, (_, i) => box(448, 240 + i * 5, 4, 4));
    const go = bestSpot([tag], [], line, anywhere, beside(part))!;
    const r = at(tag, go);
    expect(line.some((p) => meets(r, p))).toBe(false);
    expect(beside(part)(r)).toBe(true);
  });

  test('stays inside what shows of the drawing', () => {
    const label = box(420, 276, 70, 14);
    const view = (r: Box) => r.left > 330 && r.right < 560 && r.top >= 200;
    const go = bestSpot([tag], [label], [], view, beside(part))!;
    expect(view(at(tag, go))).toBe(true);
    expect(meets(at(tag, go), label)).toBe(false);
  });

  test('with no free spot beside its part, the one that covers least, still in view', () => {
    const crowd = box(-1000, -1000, 4000, 4000);
    const label = box(420, 276, 70, 14);
    const view = (r: Box) => r.top >= 200;
    const go = bestSpot([box(358, 180, 170, 26)], [crowd, label], [], view, beside(part))!;
    const r = at(box(358, 180, 170, 26), go);
    expect(view(r)).toBe(true);
    expect(meets(r, label)).toBe(false);
  });

  test('null when no spot within reach is both in view and beside its part: the tag stays where it was put', () => {
    expect(bestSpot([tag], [], [], () => false, beside(part))).toBeNull();
  });
});
