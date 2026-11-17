/**
 * The frame's behaviours a host relies on: versions fold by author and open
 * the fold that holds the version on screen, and the reserved rail column
 * reads the open flag from the storage the host passes, the ground opts
 * into theme colours only when asked, and the host requests on top: an
 * embedded ground, the rail tab in its own column, keyboard resize, a
 * controlled rail and its sheet, rail headings and rows, version decisions,
 * notes and footer, the reading line's placements, a path-less crumb and
 * the rail head's meta line; focus across the rail's collapse and open, a
 * stable version fold and a combined motion value that subscribes once.
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
const motionModule = hasDom ? await import('./lib/shellMotion') : null;
const motionValues = hasDom ? await import('motion/react') : null;

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
  test('a comparing pair marks both rows and opens the fold holding the "from" row; without it only the viewed row is marked', () => {
    const { VersionsPanel } = versionsModule!;
    const place = { rowLink: (row: FrameVersionEntry) => <a href={`#${row.version}`} /> };
    const entries = versions(5);
    const panel = (comparing: { from: string; to: string } | null) => (
      <VersionsPanel status="success" entries={entries} place={place} onRetry={() => {}} comparing={comparing} />
    );
    const frame = mount(panel(null));
    expect(frame.querySelectorAll('[data-version-compared]').length).toBe(0);
    const selectedBefore = frame.querySelector('[data-version="v5"] a')!.className;
    act(() => root!.render(panel({ from: 'v3', to: 'v5' })));
    const compared = [...frame.querySelectorAll('[data-version-compared]')].map((row) => row.getAttribute('data-version'));
    expect(compared.sort()).toEqual(['v3', 'v5']);
    expect(frame.querySelector('[data-version-fold]')!.hasAttribute('data-version-fold-open')).toBe(true);
    expect(frame.querySelector('[data-version="v3"] a')!.className).toBe(selectedBefore);
    expect(frame.querySelectorAll('[aria-current="true"]').length).toBe(1);
    expect(frame.querySelector('[data-version="v3"] a')!.getAttribute('aria-label')).toContain('Version 3, compared');
    expect(frame.querySelector('[data-version="v5"] a')!.getAttribute('aria-label')).not.toContain('compared');
    const toggle = frame.querySelector<HTMLButtonElement>('[data-version-fold-toggle]')!;
    expect(toggle.getAttribute('aria-label')).not.toContain('compared');
    act(() => toggle.click());
    expect(frame.querySelector('[data-version-fold]')!.hasAttribute('data-version-fold-open')).toBe(false);
    expect(frame.querySelector('[data-version-fold-toggle]')!.getAttribute('aria-label')).toContain('Version 3 compared');
  });

  test('an author of kind "none" draws no author line and is not named; "unnamed" still says so', () => {
    const { VersionsPanel } = versionsModule!;
    const place = { rowLink: (row: FrameVersionEntry) => <a href={`#${row.version}`} /> };
    const none = { ...entry(2, 60 * 26, 'Maya Chen', false), author: { kind: 'none' } as const };
    const unnamed = { ...entry(1, 60 * 30, 'Maya Chen', false), author: { kind: 'unnamed' } as const };
    const frame = mount(
      <VersionsPanel status="success" entries={[entry(5, 4, 'Maya Chen', true), none, unnamed]} place={place} onRetry={() => {}} />,
    );
    const row = frame.querySelector('[data-version="v2"]')!;
    expect(row.querySelector('[data-version-author]')).toBeNull();
    expect(row.querySelector('a')!.getAttribute('aria-label')).not.toMatch(/name|Maya/);
    expect(row.querySelector('a')!.children.length).toBe(1);
    expect(frame.querySelector('[data-version="v1"] [data-version-unnamed]')!.textContent).toBe('No name recorded');
  });

  test('an opened fold stays open when "Show older versions" adds an older save to it', () => {
    const { VersionsPanel } = versionsModule!;
    const place = { rowLink: (row: FrameVersionEntry) => <a href={`#${row.version}`} /> };
    const first = [entry(5, 4, 'Maya Chen', true), entry(4, 50, 'Alex Rivera', false), entry(3, 62, 'Alex Rivera', false)];
    const panel = (entries: FrameVersionEntry[]) => (
      <VersionsPanel status="success" entries={entries} place={place} onRetry={() => {}} />
    );
    const frame = mount(panel(first));
    const fold = frame.querySelector('[data-version-fold]')!;
    act(() => frame.querySelector<HTMLButtonElement>('[data-version-fold-toggle]')!.click());
    expect(fold.hasAttribute('data-version-fold-open')).toBe(true);
    act(() => root!.render(panel([...first, entry(2, 75, 'Alex Rivera', false)])));
    expect(frame.querySelector('[data-version-fold]')).toBe(fold);
    expect(fold.hasAttribute('data-version-fold-open')).toBe(true);
    expect(fold.querySelectorAll('[data-version-row]').length).toBe(3);
    act(() => frame.querySelector<HTMLButtonElement>('[data-version-fold-toggle]')!.click());
    expect(fold.hasAttribute('data-version-fold-open')).toBe(false);
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
    expect(frame.querySelector('[role="separator"]')!.getAttribute('aria-valuetext')).toBe('316 pixels wide');
    press(frame.querySelector('[role="separator"]')!, 'End');
    expect(frame.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('400');
  });

  async function withReducedMotion(run: () => Promise<void>) {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    try {
      await run();
    } finally {
      window.matchMedia = original;
    }
  }

  test('Enter on the edge collapses the rail and focus moves to the tab, not the page', () =>
    withReducedMotion(async () => {
      const { DocumentRailShell } = shellModule!;
      const frame = mount(
        <DocumentRailShell head={head} defaults={{ open: true }} storage={memoryStorage()}>
          rows
        </DocumentRailShell>,
      );
      const edge = frame.querySelector<HTMLElement>('[role="separator"]')!;
      act(() => edge.focus());
      press(edge, 'Enter');
      await act(async () => {});
      expect(frame.querySelector('[data-document-rail]')).toBeNull();
      expect(document.activeElement).toBe(frame.querySelector('[aria-label="Show files"]'));
    }));

  test('the Show files tab opens the rail and focus moves into it', () =>
    withReducedMotion(async () => {
      const { DocumentRailShell } = shellModule!;
      const frame = mount(
        <DocumentRailShell head={<button type="button">Filter</button>} defaults={{ open: false }} storage={memoryStorage()}>
          rows
        </DocumentRailShell>,
      );
      const tab = frame.querySelector<HTMLButtonElement>('[aria-label="Show files"]')!;
      act(() => tab.focus());
      act(() => tab.click());
      await act(async () => {});
      expect(frame.querySelector('[aria-label="Show files"]')).toBeNull();
      expect(document.activeElement?.textContent).toBe('Filter');
    }));

  test('a controlled host that ignores the open request leaves focus alone when it opens the rail later', () =>
    withReducedMotion(async () => {
      const { DocumentRailShell } = shellModule!;
      const rail = (open: boolean) => (
        <DocumentRailShell head={<button type="button">Filter</button>} defaults={{ open: false }} open={open} onOpenChange={() => {}} storage={memoryStorage()}>
          rows
        </DocumentRailShell>
      );
      const frame = mount(rail(false));
      const tab = frame.querySelector<HTMLButtonElement>('[aria-label="Show files"]')!;
      act(() => tab.focus());
      act(() => tab.click());
      await act(async () => {});
      expect(document.activeElement).toBe(tab);
      const elsewhere = document.createElement('button');
      document.body.appendChild(elsewhere);
      act(() => elsewhere.focus());
      act(() => root!.render(rail(true)));
      await act(async () => {});
      expect(frame.querySelector('[data-document-rail]')).not.toBeNull();
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    }));

  test('narrowRail="tab" (the default): a rail that does not fit keeps its tab; pressing it opens the rail anyway and focus moves into it', () =>
    withReducedMotion(async () => {
      const { DocumentRailShell } = shellModule!;
      const frame = mount(
        <DocumentRailShell head={<button type="button">Filter</button>} defaults={{ open: true }} fitsForWidth={() => false} storage={memoryStorage()}>
          rows
        </DocumentRailShell>,
      );
      expect(frame.querySelector('[data-document-rail]')).toBeNull();
      const tab = frame.querySelector<HTMLButtonElement>('[aria-label="Show files"]')!;
      expect(tab).not.toBeNull();
      act(() => tab.focus());
      act(() => tab.click());
      await act(async () => {});
      expect(frame.querySelector('[data-document-rail]')).not.toBeNull();
      expect(document.activeElement?.textContent).toBe('Filter');
      const edge = frame.querySelector<HTMLElement>('[role="separator"]')!;
      act(() => edge.focus());
      press(edge, 'Enter');
      await act(async () => {});
      expect(frame.querySelector('[data-document-rail]')).toBeNull();
      expect(document.activeElement).toBe(frame.querySelector('[aria-label="Show files"]'));
    }));

  test('narrowRail="host": no tab while the rail does not fit, and none for focus to land on; the tab returns when it fits', () =>
    withReducedMotion(async () => {
      const { DocumentRailShell } = shellModule!;
      const shell = (fit: boolean) => (
        <DocumentRailShell head={head} defaults={{ open: false }} fitsForWidth={() => fit} narrowRail="host" storage={memoryStorage()}>
          rows
        </DocumentRailShell>
      );
      const frame = mount(shell(false));
      expect(frame.querySelector('[aria-label="Show files"]')).toBeNull();
      expect(frame.querySelector('[data-document-rail]')).toBeNull();
      act(() => root!.render(shell(true)));
      expect(frame.querySelector('[aria-label="Show files"]')).not.toBeNull();
      expect(document.activeElement).not.toBe(frame.querySelector('[aria-label="Show files"]'));
    }));

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

  test('the newest reads "v6 · newest"; its name starts with those words and goes on as a sentence; no "Reading"', () => {
    const { ReadingLine } = readingModule!;
    const frame = mount(<ReadingLine shownNumber={6} currentNumber={6} versionsOpen={false} onToggleVersions={() => {}} />);
    const toggle = frame.querySelector('[data-reading-versions]')!;
    expect(toggle.textContent).toBe('v6 · newest');
    expect(toggle.getAttribute('aria-label')).toBe('v6 · newest, version 6, the newest. Versions');
    expect(toggle.getAttribute('aria-label')!.startsWith(toggle.textContent!)).toBe(true);
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
    expect(toggle.getAttribute('aria-label')).toBe('v1 of 6, version 1 of 6, an older version. Versions');
    expect(toggle.getAttribute('aria-label')!.startsWith(toggle.textContent!)).toBe(true);
    expect(toggle.parentElement!.textContent).toBe('v1 of 6·You are looking at an older version.');
    expect(frame.textContent).not.toContain('Reading');
  });

  test('an older version whose words carry the total shows no count beside them', () => {
    const { ReadingLine } = readingModule!;
    const frame = mount(
      <ReadingLine
        shownNumber={2}
        currentNumber={4}
        versionsOpen={false}
        onToggleVersions={() => {}}
        older={{ back: <a href="#v4" />, restore: null }}
        count={4}
      />,
    );
    const toggle = frame.querySelector('[data-reading-versions]')!;
    expect(toggle.textContent).toBe('v2 of 4');
    expect(toggle.querySelector('[data-reading-versions-count]')).toBeNull();
    expect(toggle.getAttribute('aria-label')).toBe('v2 of 4, version 2 of 4, an older version. Versions');
  });

  test('an older version with no number says it is older once, and its toggle reads "Versions"', () => {
    const { ReadingLine } = readingModule!;
    const frame = mount(
      <ReadingLine
        shownNumber={null}
        currentNumber={6}
        versionsOpen={false}
        onToggleVersions={() => {}}
        older={{ back: <a href="#v6" />, restore: null }}
        versionAt="start"
      />,
    );
    const toggle = frame.querySelector('[data-reading-versions]')!;
    expect(toggle.textContent).toBe('Versions');
    expect(toggle.getAttribute('aria-label')).toBe('Versions');
    expect(toggle.parentElement!.textContent).toBe('Versions·You are looking at an older version.');
    expect(frame.textContent!.match(/older version/g)!.length).toBe(1);
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
  test('only a link crumb underlines on hover; a plain-text crumb does not', async () => {
    const { Breadcrumbs } = crumbsModule!;
    const { compile } = await import('tailwindcss');
    const frame = mount(
      <>
        <Breadcrumbs collectionName="Linked" collectionLink={<a href="#linked" />} />
        <Breadcrumbs collectionName="Plain" collectionLink={<span />} />
      </>,
    );
    const linked = frame.querySelector<HTMLElement>('a[aria-label="Linked"]')!;
    const plain = frame.querySelector<HTMLElement>('span[aria-label="Plain"]')!;
    const underline = linked.className.split(' ').find((name) => name.endsWith('underline'))!;
    expect(underline).toBe('[&[href]]:hover:underline');
    expect(plain.className).toBe(linked.className);
    const css = (await compile('@tailwind utilities;')).build([underline]);
    expect(css).toContain('[href]');
    expect(css).toContain(':hover');
    expect(linked.matches('[href]')).toBe(true);
    expect(plain.matches('[href]')).toBe(false);
  });

  test('with a file, the file crumb is the current page and not a tab stop, since it does nothing', () => {
    const { Breadcrumbs } = crumbsModule!;
    const frame = mount(<Breadcrumbs collectionName="Porto launch plan" collectionLink={<a href="#porto" />} path="plans/brief.md" />);
    const current = frame.querySelectorAll<HTMLElement>('[aria-current="page"]');
    expect(current.length).toBe(1);
    expect(current[0]!.textContent).toBe('brief.md');
    expect(current[0]!.tabIndex).toBe(-1);
    expect(current[0]!.hasAttribute('tabindex')).toBe(false);
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

describe.skipIf(!hasDom)('useCombinedMotionValue', () => {
  test('subscribes once across renders, again only when the values change, and reads the latest combine', () => {
    const { useCombinedMotionValue } = motionModule!;
    const a = motionValues!.motionValue(2);
    const b = motionValues!.motionValue(3);
    const c = motionValues!.motionValue(5);
    let subscriptions = 0;
    for (const value of [a, b, c]) {
      const on = value.on.bind(value);
      value.on = ((event: Parameters<typeof on>[0], callback: Parameters<typeof on>[1]) => {
        subscriptions += 1;
        return on(event, callback);
      }) as typeof value.on;
    }
    let combined: { get: () => number } | null = null;
    function Harness({ scale, values }: { scale: number; values: (typeof a)[] }) {
      combined = useCombinedMotionValue(values, (latest) => latest.reduce((sum, next) => sum + next, 0) * scale);
      return null;
    }
    mount(<Harness scale={1} values={[a, b]} />);
    act(() => root!.render(<Harness scale={2} values={[a, b]} />));
    act(() => root!.render(<Harness scale={3} values={[a, b]} />));
    expect(subscriptions).toBe(2);
    expect(combined!.get()).toBe(15);
    act(() => root!.render(<Harness scale={1} values={[a, b, c]} />));
    expect(subscriptions).toBe(5);
    expect(combined!.get()).toBe(10);
  });
});
