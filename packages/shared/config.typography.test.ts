import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
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

// The other direction: the value ON DISK is the unparsable one (a hand edit,
// or a profile written by a newer build). saveConfig runs for every unrelated
// setting, so if it dropped what it could not parse, the next theme toggle
// would silently delete the user's typography block instead of leaving it
// there to be corrected.
test('an unparsable typography block on disk survives unrelated config writes', () => {
  dataDir = mkdtempSync(`${tmpdir()}/plannotator-typography-`);
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const handEdited = { plan: { dispaly: { source: 'catalog', family: 'inter' } } };
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ typography: handEdited }));

  saveConfig({ displayName: 'someone' });

  const after = loadConfig();
  expect(after.displayName).toBe('someone');
  expect(after.typography).toEqual(handEdited as never);
});
