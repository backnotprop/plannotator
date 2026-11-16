/**
 * The frame's behaviours a host relies on: versions fold by author and open
 * the fold that holds the version on screen, and the reserved rail column
 * reads the open flag from the storage the host passes, the ground opts
 * into theme colours only when asked, and the host requests on top: an
 * embedded ground, the rail tab in its own column, keyboard resize, a
 * controlled rail and its sheet, rail headings and rows, version decisions,
 * notes and footer, the reading line's placements, a path-less crumb and
 * the rail head's meta line.
 * Requires DOM (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { fileIcon } from './rail/fileIcons';
import { createRoot, type Root } from 'react-dom/client';
import type { FrameVersionEntry } from './versions/versionsModel';
import type { RailStorage } from './railGeometry';

const hasDom = typeof document !== 'undefined';
const versionsModule = hasDom ? await import('./versions/VersionsPanel') : null;
const slotModule = hasDom ? await import('./RailSlot') : null;
const boxModule = hasDom ? await import('./FrameBox') : null;
const shellModule = hasDom ? await import('./DocumentRailShell') : null;
const sheetModule = hasDom ? await import('./sheets/RailSheet') : null;
const railModule = hasDom ? await import('./rail/FilesRail') : null;
const readingModule = hasDom ? await import('./page/ReadingLine') : null;
const crumbsModule = hasDom ? await import('./Breadcrumbs') : null;
const headModule = hasDom ? await import('./rail/PagesRailHead') : null;

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

describe.skipIf(!hasDom)('FrameGround colors', () => {
  test('fixed colours unless the host asks for theme colours', () => {
    const { FrameGround } = boxModule!;
    const ground = () => document.querySelector('[data-frame-ground]')!.getAttribute('data-frame-colors');
    mount(<FrameGround>page</FrameGround>);
    expect(ground()).toBe('fixed');
    act(() => root!.render(<FrameGround colors="theme">page</FrameGround>));
    expect(ground()).toBe('theme');
  });
});

function memoryStorage(values: Record<string, string> = {}): RailStorage & { values: Record<string, string> } {
  return { values, getItem: (key) => values[key] ?? null, setItem: (key, value) => void (values[key] = value) };
}

function press(element: Element, key: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe.skipIf(!hasDom)('FrameGround embedded', () => {
  test('as="div" renders no <main>, fills its container, and keeps tone and colours', () => {
    const { FrameGround } = boxModule!;
    const frame = mount(
      <FrameGround as="div" tone="tinted" colors="theme">
        page
      </FrameGround>,
    );
    const ground = frame.querySelector<HTMLElement>('[data-frame-ground]')!;
    expect(frame.querySelector('main')).toBeNull();
    expect(ground.querySelector('[data-frame-pane]')?.tagName).toBe('DIV');
    expect(ground.className).toContain('h-full');
    expect(ground.className).not.toContain('h-svh');
    expect(ground.getAttribute('data-frame-tone')).toBe('tinted');
    expect(ground.getAttribute('data-frame-colors')).toBe('theme');
  });

  test('the default still holds the page main at the viewport height', () => {
    const { FrameGround } = boxModule!;
    const frame = mount(<FrameGround>page</FrameGround>);
    expect(frame.querySelector('main[data-frame-pane]')).not.toBeNull();
    expect(frame.querySelector('[data-frame-ground]')!.className).toContain('h-svh');
  });
});

describe.skipIf(!hasDom)('DocumentRailShell', () => {
  const head = <span>head</span>;

  test('a closed rail shows its tab in its own column, not over the page; a controlled rail asks the host and stores nothing', () => {
    const { DocumentRailShell } = shellModule!;
    const storage = memoryStorage();
    const changes: boolean[] = [];
    const frame = mount(
      <div data-frame-row="">
        <DocumentRailShell head={head} defaults={{ open: true }} open={false} onOpenChange={(next) => changes.push(next)} storage={storage}>
          rows
        </DocumentRailShell>
      </div>,
    );
    const flags = frame.querySelector<HTMLElement>('[data-rail-flags]')!;
    expect(flags.parentElement?.hasAttribute('data-frame-row')).toBe(true);
    expect(flags.className.split(' ')).not.toContain('absolute');
    expect(frame.querySelector('[data-document-rail]')).toBeNull();
    act(() => frame.querySelector<HTMLButtonElement>('[aria-label="Show files"]')!.click());
    expect(changes).toEqual([true]);
    expect(storage.values).toEqual({});
  });

  test('arrow keys on the edge resize the rail, within its limits', () => {
    const { DocumentRailShell } = shellModule!;
    const frame = mount(
      <DocumentRailShell head={head} defaults={{ open: true }} storageKeys={{ width: 'test-frame-rail-width' }} storage={memoryStorage()}>
        rows
      </DocumentRailShell>,
    );
    const edge = frame.querySelector('[role="separator"]')!;
    expect(edge.getAttribute('aria-valuenow')).toBe('306');
    press(edge, 'ArrowRight');
    expect(frame.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('316');
    press(frame.querySelector('[role="separator"]')!, 'End');
    expect(frame.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('400');
  });

  test('a rail that does not fit says so, and the rail sheet is then offered at a desktop width', () => {
    const { DocumentRailShell } = shellModule!;
    const { RailSheet } = sheetModule!;
    const fits: boolean[] = [];
    mount(
      <DocumentRailShell head={head} defaults={{ open: true }} fitsForWidth={() => false} onFitChange={(value) => fits.push(value)} storage={memoryStorage()}>
        rows
      </DocumentRailShell>,
    );
    expect(fits.at(-1)).toBe(false);
    act(() => root!.unmount());
    host!.remove();
    const wide = mount(<RailSheet head={head} closeKey="a">rows</RailSheet>);
    expect(wide.querySelector('[aria-label="Open the sidebar"]')).toBeNull();
    act(() => root!.render(<RailSheet head={head} closeKey="a" docked={false}>rows</RailSheet>));
    expect(wide.querySelector('[aria-label="Open the sidebar"]')).not.toBeNull();
  });
});

describe.skipIf(!hasDom)('rail heading and rows', () => {
  test('a heading without a filter handler draws no Filter button', () => {
    const { FilesRailHeading } = railModule!;
    const frame = mount(<FilesRailHeading label="Artifacts" count={2} countTitle={(n) => `${n} artifacts`} />);
    expect(frame.querySelector('[aria-label="Filter files"]')).toBeNull();
    expect(frame.querySelector('[title="2 artifacts"]')).not.toBeNull();
  });

  test("a row's trailing mark sits at its right end, after the comment count", () => {
    const { FileRow } = railModule!;
    const frame = mount(
      <FileRow
        id="p1"
        name="porto-launch-plan.md"
        title="porto-launch-plan.md"
        depth={0}
        active={false}
        icon={fileIcon({ path: 'porto-launch-plan.md' })}
        link={<a href="#p1" />}
        openCommentCount={2}
        trailing={<span>Main</span>}
      />,
    );
    const link = frame.querySelector('[data-file-row-link]')!;
    expect(link.lastElementChild?.hasAttribute('data-file-row-trailing')).toBe(true);
    expect(link.lastElementChild?.previousElementSibling?.hasAttribute('data-page-comment-count')).toBe(true);
  });
});

describe.skipIf(!hasDom)('versions: decisions, notes, footer, no authors', () => {
  test('a decision shows with its tone and is read in the row name; a note and the footer show outside the rows', () => {
    const { VersionsPanel } = versionsModule!;
    const entries = versions(5).map((row) =>
      row.number === 4 ? { ...row, decision: { label: 'Changes asked', tone: 'negative' as const } } : row,
    );
    const frame = mount(
      <VersionsPanel
        status="success"
        entries={[entries[0]!, entries[1]!]}
        place={{ rowLink: (row) => <a href={`#${row.version}`} />, note: (row) => (row.number === 5 ? 'Sent to the venue' : null) }}
        onRetry={() => {}}
        footer={<span data-test-footer="">Older versions are kept for a year</span>}
      />,
    );
    const decision = frame.querySelector('[data-version-decision]')!;
    expect(decision.getAttribute('data-version-decision')).toBe('negative');
    expect(decision.closest('a')!.getAttribute('aria-label')).toContain('Changes asked');
    const note = frame.querySelector('[data-version-note]')!;
    expect(note.closest('a')).toBeNull();
    expect(note.closest('[data-version-row]')!.getAttribute('data-version')).toBe('v5');
    expect(frame.querySelector('[data-versions-footer] [data-test-footer]')).not.toBeNull();
  });

  test('without authors no author line shows, unnamed included; by default an unnamed author still says so', () => {
    const { VersionsPanel } = versionsModule!;
    const unnamed = versions(5).map((row) => ({ ...row, author: { kind: 'unnamed' as const } }));
    const frame = mount(
      <VersionsPanel status="success" entries={unnamed} place={{ rowLink: (row) => <a href={`#${row.version}`} />, authors: false }} onRetry={() => {}} />,
    );
    expect(frame.querySelector('[data-version-author]')).toBeNull();
    expect(frame.textContent).not.toContain('No name recorded');
    act(() =>
      root!.render(<VersionsPanel status="success" entries={unnamed} place={{ rowLink: (row) => <a href={`#${row.version}`} /> }} onRetry={() => {}} />),
    );
    expect(frame.textContent).toContain('No name recorded');
  });

  test("the host's version actions sit between Compare and Copy link", () => {
    const { VersionActions } = versionsModule!;
    const frame = mount(
      <VersionActions version="v4" number={4} currentNumber={5} canCompare onCompare={() => {}} onCopyLink={() => {}} actions={<button type="button" data-test-action="">Restore</button>} />,
    );
    const order = [...frame.querySelector('[data-version-actions]')!.children].map((child) =>
      child.hasAttribute('data-version-compare') ? 'compare' : child.hasAttribute('data-test-action') ? 'host' : 'copy',
    );
    expect(order).toEqual(['compare', 'host', 'copy']);
  });
});

describe.skipIf(!hasDom)('ReadingLine', () => {
  function order(frame: HTMLElement): string[] {
    const line = frame.querySelector('[data-reading-line]')!;
    const marks = line.querySelectorAll('[data-reading-start], [data-reading-versions], [data-test-approved]');
    return [...marks].map((mark) =>
      mark.hasAttribute('data-reading-start') ? 'start' : mark.hasAttribute('data-reading-versions') ? 'version' : 'approved',
    );
  }

  test('the newest reads "v6 · newest", named as a sentence; no "Reading"', () => {
    const { ReadingLine } = readingModule!;
    const frame = mount(<ReadingLine shownNumber={6} currentNumber={6} versionsOpen={false} onToggleVersions={() => {}} />);
    const toggle = frame.querySelector('[data-reading-versions]')!;
    expect(toggle.textContent).toBe('v6 · newest');
    expect(toggle.getAttribute('aria-label')).toBe('Version 6, the newest');
  });

  test('an older version reads "v1 of 6 · You are looking at an older version."', () => {
    const { ReadingLine } = readingModule!;
    const frame = mount(
      <ReadingLine
        shownNumber={1}
        currentNumber={6}
        versionsOpen={false}
        onToggleVersions={() => {}}
        older={{ back: <a href="#v6" />, restore: null }}
        versionAt="start"
      />,
    );
    const toggle = frame.querySelector('[data-reading-versions]')!;
    expect(toggle.getAttribute('aria-label')).toBe('Version 1 of 6, an older version');
    expect(toggle.parentElement!.textContent).toBe('v1 of 6·You are looking at an older version.');
    expect(frame.textContent).not.toContain('Reading');
  });

  test('comparing words and a count replace and join the version words on the toggle', () => {
    const { ReadingLine } = readingModule!;
    const frame = mount(
      <ReadingLine shownNumber={6} currentNumber={6} versionsOpen={false} onToggleVersions={() => {}} comparing="Comparing v2 with v6" count={6} />,
    );
    const toggle = frame.querySelector('[data-reading-versions]')!;
    expect(toggle.querySelector('[data-reading-comparing]')!.textContent).toBe('Comparing v2 with v6');
    expect(toggle.querySelector('[data-reading-versions-count]')!.textContent).toBe('6');
    expect(toggle.getAttribute('aria-label')).toBe('Comparing v2 with v6. 6 versions');
  });

  test('start placement: the version first, the approval after it', () => {
    const { ReadingLine } = readingModule!;
    const frame = mount(
      <ReadingLine shownNumber={5} currentNumber={5} versionsOpen={false} onToggleVersions={() => {}} approved={<span data-test-approved="">Approved</span>} start={<span>Porto launch plan</span>} versionAt="start" />,
    );
    expect(order(frame)).toEqual(['start', 'version', 'approved']);
    expect(frame.querySelector('[data-reading-version-end]')).toBeNull();
  });

  test('end placement, the default: the start slot and the approval on the start side, the version at the end', () => {
    const { ReadingLine } = readingModule!;
    const frame = mount(
      <ReadingLine shownNumber={5} currentNumber={5} versionsOpen={false} onToggleVersions={() => {}} approved={<span data-test-approved="">Approved</span>} start={<span>Porto launch plan</span>} />,
    );
    expect(order(frame)).toEqual(['start', 'approved', 'version']);
    const end = frame.querySelector('[data-reading-version-end]')!;
    expect(end.querySelector('[data-reading-versions]')).not.toBeNull();
    expect(end.className).toContain('ml-auto');
    expect(frame.querySelector('[data-reading-line]')!.lastElementChild).toBe(end);
  });
});

describe.skipIf(!hasDom)('Breadcrumbs without a file', () => {
  test('the collection is the current page and no file crumb is drawn', () => {
    const { Breadcrumbs } = crumbsModule!;
    const frame = mount(<Breadcrumbs collectionName="Porto launch plan" collectionLink={<a href="#porto" />} />);
    const current = frame.querySelectorAll('[aria-current="page"]');
    expect(current.length).toBe(1);
    expect(current[0]!.tagName).toBe('A');
    expect([...frame.querySelectorAll('span')].some((span) => span.textContent === '/')).toBe(false);
  });
});

describe.skipIf(!hasDom)('PagesRailHead meta', () => {
  test('a meta line shows under the back link, outside it; none by default and none while loading', () => {
    const { PagesRailHead } = headModule!;
    const meta = <span title="Shared with Alex Rivera">Shared with Alex Rivera</span>;
    const frame = mount(<PagesRailHead label="Porto launch plan" backLink={<a href="#porto" />} meta={meta} />);
    const line = frame.querySelector('[data-pages-rail-meta]')!;
    expect(line.textContent).toBe('Shared with Alex Rivera');
    expect(line.closest('a')).toBeNull();
    expect(line.previousElementSibling?.hasAttribute('data-pages-back-link')).toBe(true);
    act(() => root!.render(<PagesRailHead label="Porto launch plan" backLink={<a href="#porto" />} />));
    expect(frame.querySelector('[data-pages-rail-meta]')).toBeNull();
    act(() => root!.render(<PagesRailHead label={null} backLink={<a href="#porto" />} meta={meta} />));
    expect(frame.querySelector('[data-pages-rail-meta]')).toBeNull();
  });
});
