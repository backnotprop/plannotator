/**
 * `views.changed` through the store: once What's changed, now kept but never shown (approval
 * "shape-whats-changed-removed"). What regresses if these fail:
 * - a board that still sends it is refused, or it is lost or rewritten on its way to disk and back;
 * - it is stored as parts again (a change in it would then light a dot);
 * - a board without it is stored differently than before (an older agent's board, every board on disk today).
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShapeStore } from './store';
import { KETTLE_CHANGED, KETTLE_OLD_BOARD, kettleBoard } from '../../../tests/fixtures/shape-whats-changed';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'shape-changed-'));
  dirs.push(dir);
  return { dir, store: createShapeStore({ dataDir: join(dir, 'data') }) };
}
const project = (dir: string) => ({ name: 'kettle', root: dir });

test('views.changed is stored and read back as written, version after version, and is not a part', () => {
  const { dir, store: s } = store();
  const made = s.update({ board: kettleBoard(), project: project(dir) });
  if (!made.ok) throw new Error(JSON.stringify(made));
  expect(s.read(made.id)!.views.changed).toEqual(KETTLE_CHANGED);
  expect(s.read(made.id)!.parts.some((p) => p.view === 'changed')).toBe(false);
  // A new version that drops one change: the stored one has exactly the rest.
  const fewer = { ...KETTLE_CHANGED, items: KETTLE_CHANGED.items.slice(1) };
  const next = s.update({ id: made.id, base: 1, board: kettleBoard(fewer), project: project(dir) });
  if (!next.ok) throw new Error(JSON.stringify(next));
  expect(s.read(made.id)!.views.changed).toEqual(fewer);
  expect(s.read(made.id, 1)!.views.changed).toEqual(KETTLE_CHANGED);
});

test('a board without What\'s changed is stored as it always was', () => {
  const { dir, store: s } = store();
  const made = s.update({ board: KETTLE_OLD_BOARD, project: project(dir) });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const shapes = join(dir, 'data', 'shapes');
  const file = readdirSync(shapes, { recursive: true }).map(String).find((p) => p.endsWith(`${made.id}/versions.jsonl`))!;
  const line = readFileSync(join(shapes, file), 'utf8').trim();
  const stored = JSON.parse(line) as Record<string, unknown>;
  expect(line).not.toContain('changed');
  expect({ title: stored.title, claim: stored.claim, views: stored.views }).toEqual(KETTLE_OLD_BOARD as never);
  // Its views.know is kept as written, but is not a part: nothing shows it.
  expect((stored.parts as { view: string }[]).map((p) => p.view)).toEqual(['header', 'header', 'picture']);
});
