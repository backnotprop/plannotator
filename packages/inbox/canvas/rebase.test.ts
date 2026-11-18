/**
 * The person's canvas edits survive a scene that changed somewhere else meanwhile (rebase.ts, used by
 * useThreadCanvas.ts on a stale save and on every save).
 */
import { describe, expect, test } from 'bun:test';
import type { CanvasElement } from '@plannotator/core/canvas-scene';
import { personEdits, rebaseScene, sameScene } from './rebase';

const el = (id: string, version: number, extra: Partial<CanvasElement> = {}): CanvasElement => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version, versionNonce: version * 7, ...extra });
const stamp = (elements: readonly CanvasElement[]) => elements.map((e) => `${e.id}@${e.version}${e.isDeleted ? '-' : ''}`);

describe('rebaseScene', () => {
  const base = [el('a', 1, { customData: { part: 'a' } }), el('b', 1, { customData: { part: 'b' } }), el('mine', 1)];

  test('a stroke the person added while the agent changed the board is kept, on top', () => {
    const local = [...base, el('stroke', 3)];
    const server = [el('a', 2, { customData: { part: 'a' } }), el('b', 1, { customData: { part: 'b' } }), el('mine', 1), el('c', 1, { customData: { part: 'c' } })];
    expect(stamp(rebaseScene(base, local, server))).toEqual(['a@2', 'b@1', 'mine@1', 'c@1', 'stroke@3']);
  });

  test('an agent part the person moved keeps the person’s copy; the ones the person left take the server’s', () => {
    const local = [el('a', 4, { customData: { part: 'a' }, x: 300 }), base[1]!, base[2]!];
    const server = [el('a', 2, { customData: { part: 'a' }, x: 40 }), el('b', 2, { customData: { part: 'b' } }), el('mine', 1)];
    const out = rebaseScene(base, local, server);
    expect(stamp(out)).toEqual(['a@4', 'b@2', 'mine@1']);
    expect(out[0]!.x).toBe(300);
  });

  test('a deletion of the person’s wins over the server’s copy', () => {
    const local = [base[0]!, el('b', 2, { customData: { part: 'b' }, isDeleted: true }), base[2]!];
    const server = [el('a', 1, { customData: { part: 'a' } }), el('b', 5, { customData: { part: 'b' } }), el('mine', 1)];
    expect(stamp(rebaseScene(base, local, server))).toEqual(['a@1', 'b@2-', 'mine@1']);
  });

  test('the same version with another nonce is an edit (two windows, one version number)', () => {
    const local = [base[0]!, base[1]!, { ...el('mine', 1), versionNonce: 999 }];
    const out = rebaseScene(base, local, base);
    expect(out[2]!.versionNonce).toBe(999);
  });

  test('an element the person left alone and the server dropped is dropped', () => {
    const server = [base[0]!, base[2]!];
    expect(stamp(rebaseScene(base, base, server))).toEqual(['a@1', 'mine@1']);
  });

  test('an element the canvas never held (only the server has it) is filled in from the server', () => {
    // The open canvas was not given the newest scene yet: its elements are older copies, not edits.
    const shown = [el('a', 1)];
    const local = [el('a', 1), el('p', 1)];
    const server = [el('a', 6), el('z', 1)];
    expect(stamp(rebaseScene(shown, local, server))).toEqual(['a@6', 'z@1', 'p@1']);
  });

  test('nothing changed anywhere: the scene comes back as it was', () => {
    const out = rebaseScene(base, base, base);
    expect(sameScene(out, base)).toBe(true);
    expect(personEdits(base, base).size).toBe(0);
  });
});

describe('sameScene', () => {
  test('a version, a deletion or an order difference makes two scenes differ', () => {
    const a = [el('x', 1), el('y', 1)];
    expect(sameScene(a, [el('x', 1), el('y', 1)])).toBe(true);
    expect(sameScene(a, [el('x', 1), el('y', 2)])).toBe(false);
    expect(sameScene(a, [el('y', 1), el('x', 1)])).toBe(false);
    expect(sameScene(a, [el('x', 1), el('y', 1, { isDeleted: true })])).toBe(false);
    expect(sameScene(a, [el('x', 1)])).toBe(false);
  });
});
