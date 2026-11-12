import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const VIDEO = /\.(mp4|webm|mov|m4v)$/i;
const here = import.meta.dir;

describe('marketing videos live outside the repository', () => {
  test('public/ holds no video files', () => {
    const files = readdirSync(join(here, 'public'), { recursive: true }) as string[];
    expect(files.filter((f) => VIDEO.test(f))).toEqual([]);
  });

  test("the deploy's sync never deletes the uploaded videos", () => {
    const workflow = readFileSync(join(here, '../../.github/workflows/deploy.yml'), 'utf8');
    const sync = workflow.match(/aws s3 sync apps\/marketing\/dist\/[^\n]*(?:\n\s+--[^\n]*)*/)?.[0] ?? '';
    expect(sync).toContain('--delete');
    expect(sync).toContain('--exclude "assets/*.mp4"');
    expect(sync).toContain('--exclude "assets/*.webm"');
  });

  test('pages point at the hosted videos, not at public/', () => {
    const pages = readdirSync(join(here, 'src'), { recursive: true }) as string[];
    const relative = pages
      .filter((f) => /\.(astro|tsx?|mdx?)$/.test(f))
      .filter((f) => /["'(]\/assets\/[^"')]+\.(mp4|webm)/.test(readFileSync(join(here, 'src', f), 'utf8')));
    expect(relative).toEqual([]);
  });
});
