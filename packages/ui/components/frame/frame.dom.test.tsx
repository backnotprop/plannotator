/**
 * The frame's behaviours a host relies on: versions fold by author and open
 * the fold that holds the version on screen, and the reserved rail column
 * reads the open flag from the storage the host passes.
 * Requires DOM (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FrameVersionEntry } from './versions/versionsModel';
import type { RailStorage } from './railGeometry';

const hasDom = typeof document !== 'undefined';
const versionsModule = hasDom ? await import('./versions/VersionsPanel') : null;
const slotModule = hasDom ? await import('./RailSlot') : null;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function entry(number: number, minutesAgo: number, name: string, viewing: boolean): FrameVersionEntry {
  return {
    key: `v${number}`,
    version: `v${number}`,
    number,
    createdAt: at(minutesAgo),
    author: { kind: 'person', name, key: `name:${name}` },
    current: number === 5,
    viewing,
    linked: true,
    sameAsOlder: false,
    approval: null,
    canCompare: number !== 5,
  };
}

function versions(viewing: number) {
  return [
    entry(5, 4, 'Maya Chen', viewing === 5),
    entry(4, 50, 'Alex Rivera', viewing === 4),
    entry(3, 62, 'Alex Rivera', viewing === 3),
    entry(2, 60 * 26, 'Maya Chen', viewing === 2),
  ];
}

function renderPanel(viewing: number) {
  const { VersionsPanel } = versionsModule!;
  return mount(
    <VersionsPanel
      status="success"
      entries={versions(viewing)}
      place={{ rowLink: (row) => <a href={`#${row.version}`} /> }}
      onRetry={() => {}}
    />,
  );
}

describe.skipIf(!hasDom)('VersionsPanel folds', () => {
  test('two saves by one author within half an hour fold into one row; the newest and an older lone save stay rows', () => {
    const frame = renderPanel(5);
    const fold = frame.querySelector('[data-version-fold]');
    expect(fold).not.toBeNull();
    expect(fold!.hasAttribute('data-version-fold-open')).toBe(false);
    const rows = [...frame.querySelectorAll('[data-version-row]')].map((row) => row.getAttribute('data-version'));
    expect(rows).toEqual(['v5', 'v2']);
  });

  test('the fold holding the version on screen opens itself and marks that row current', () => {
    const frame = renderPanel(3);
    expect(frame.querySelector('[data-version-fold]')!.hasAttribute('data-version-fold-open')).toBe(true);
    const onScreen = frame.querySelector('[data-version-row][data-version="v3"] a');
    expect(onScreen?.getAttribute('aria-current')).toBe('true');
  });
});

describe.skipIf(!hasDom)('ReservedRailColumn storage', () => {
  function memory(values: Record<string, string>): RailStorage {
    return { getItem: (key) => values[key] ?? null, setItem: (key, value) => void (values[key] = value) };
  }

  test('a rail the host stored as closed reserves no column, under the host key', () => {
    const { ReservedRailColumn } = slotModule!;
    const frame = mount(
      <ReservedRailColumn storage={memory({ 'host-rail-open': '0' })} storageKeys={{ open: 'host-rail-open' }} />,
    );
    expect(frame.querySelector('[data-rail-reserved]')).toBeNull();
  });

  test('a flag under another key is not read: the column is reserved at the default width', () => {
    const { ReservedRailColumn } = slotModule!;
    const frame = mount(
      <ReservedRailColumn storage={memory({ 'plannotator-frame-rail-open': '0' })} storageKeys={{ open: 'host-rail-open' }} />,
    );
    const column = frame.querySelector<HTMLElement>('[data-rail-reserved]');
    expect(column?.style.width).toBe('306px');
  });
});
