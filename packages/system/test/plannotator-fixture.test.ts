import { describe, expect, test } from 'bun:test';
import { citations } from '../src/index.ts';
import { load } from '../src/node/index.ts';
import { drawingDir } from './helpers.ts';

describe('the plannotator fixture', () => {
  test('loads clean: system.yaml, every sheet, the schema, the ids and the refs between sheets', async () => {
    const r = await load(drawingDir);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.model).not.toBeNull();
    expect(r.model!.sources?.repos.self?.at).toMatch(/^[0-9a-f]{40}$/);
  });

  test('cites only plain relative paths: forward slashes, no empty, "." or ".." segment', async () => {
    const { model } = await load(drawingDir);
    const cited = citations(model!);
    expect(cited.length).toBeGreaterThan(0);
    const bad = cited.map((c) => c.path).filter((p) => p.includes('\\') || /^\s|\s$/.test(p) || p.split('/').some((s) => s === '' || s === '.' || s === '..'));
    expect(bad).toEqual([]);
  });
});
