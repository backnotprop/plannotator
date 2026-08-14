import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { loadConfig, saveConfig } from './config';

const previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
let dataDir = '';

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = '';
});

test('typography reset replaces the saved profile', () => {
  dataDir = mkdtempSync(`${tmpdir()}/plannotator-typography-`);
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  saveConfig({ typography: { review: { mono: { source: 'catalog', family: 'fira-code' } } } });
  saveConfig({ typography: {} });
  expect(loadConfig().typography).toEqual({});
});

test('invalid typography cannot erase saved preferences', () => {
  dataDir = mkdtempSync(`${tmpdir()}/plannotator-typography-`);
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  saveConfig({ typography: { plan: { display: { source: 'catalog', family: 'inter' } } } });
  saveConfig({ typography: { plan: { display: { source: 'catalog', family: 'fira-code' } } } as never });
  expect(loadConfig().typography).toEqual({ plan: { display: { source: 'catalog', family: 'inter' } } });
});
