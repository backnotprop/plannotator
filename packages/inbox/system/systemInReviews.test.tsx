/**
 * System in Settings and Reviews (approval "system-inbox", screens 1, 3, 4a and 4b), the server calls stubbed.
 * What regresses:
 *  - Settings: the System switch shown while Code review is off, or missing under it while on; its click not asking
 *    to flip it; the projects listed while System is off; a project's Set up not opening its setup;
 *  - Reviews: anything of System in the head while System does not show (today's Reviews unchanged); the menu listing
 *    a project with no drawing, or not saying none is drawn; a pick not opening the drawing; "Set up a project" not
 *    opening setup; the open project not named on the button;
 *  - the pane: the drawing not drawn, "Open PRs that change this" missing a PR that touches it or naming the wrong
 *    parts, a row not opening that PR's pane, Open full window not asking for the window, the window's "Reviews" not
 *    going back to the pane, a project not drawn yet showing no way to set it up;
 *  - off means off: the projects read while System does not show;
 *  - focus: the full window leaving what it covers reachable by Tab, closing it (or the drawing) dropping the focus on
 *    the page instead of the way back in.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxPull, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { SystemProjectRow } from '@plannotator/core/inbox-system';
import type { SettingsModel } from '../api';
import type { PullsPageProps, PullsSystem } from '../pulls/PullsPage';
import type { SystemPaneProps } from './SystemPane';

const hasDom = typeof document !== 'undefined';
const { SettingsPage } = (hasDom ? await import('../components/Settings') : {}) as typeof import('../components/Settings');
const { PullsPage } = (hasDom ? await import('../pulls/PullsPage') : {}) as typeof import('../pulls/PullsPage');
const { SystemPane } = (hasDom ? await import('./SystemPane') : {}) as typeof import('./SystemPane');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { closeSystemSetup, useSystemSetupRequest } = (hasDom ? await import('./opener') : {}) as typeof import('./opener');
const { loadFiles } = (hasDom ? await import('@plannotator/system') : {}) as typeof import('@plannotator/system');
const { useSystemProjects } = (hasDom ? await import('./projects') : {}) as typeof import('./projects');
const { useState } = (hasDom ? await import('react') : {}) as typeof import('react');

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** Every System read the window asked for. */
let systemReads: string[] = [];
beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  systemReads = [];
  // The pane's own reads, when a test draws it through the Reviews page.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/system/')) systemReads.push(url);
    if (url.includes('/system/projects')) return Response.json({ projects: [APP] });
    if (url.includes('/system/drawing')) return Response.json({ project: APP, model: null });
    if (url.includes('/system/pulls')) return Response.json({ pulls: [], unread: 0 });
    return Response.json({});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => closeSystemSetup());
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};
/** Base UI opens on the pointer's press, as a person's click does. */
async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.click();
  });
  await settle();
}
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];

/** Who asked for the setup dialog last (the window draws it from this request). */
let setupAsked: { project: string | null } | null = null;
function SetupSpy() {
  const request = useSystemSetupRequest();
  setupAsked = request ? { project: request.project } : null;
  return null;
}

function mount(node: React.ReactNode) {
  if (!root) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() =>
    root!.render(
      <SidebarProvider>
        <SetupSpy />
        {node}
      </SidebarProvider>,
    ),
  );
}

const APP: SystemProjectRow = { id: 'prj_app', key: 'app-1', name: 'app', repo: 'github.com/acme/app', state: 'drawn', sheets: 2, wanted: 0 };
const NEW: SystemProjectRow = { id: 'prj_new', key: 'new-1', name: 'new-thing', repo: 'github.com/acme/new', state: 'none', sheets: 0, wanted: 0 };

describe('Settings → Capabilities → System', () => {
  const base = {
    serverSession: 's',
    version: '0.29.0',
    home: '/home/u',
    data_dir: '/home/u/.plannotator',
    inbox_tool: { hosts: { 'claude-code': true, pi: false, opencode: false }, env: null },
    notifications: { enabled: true, dismissed: false, allowed_origin: null },
    phones: false,
    store_dir: '/home/u/.plannotator/inbox',
    board: { on: false },
  } as unknown as SettingsModel;
  const draw = (settings: Partial<SettingsModel>, toggles: boolean[], projects: SystemProjectRow[] | null = [APP, NEW]) => {
    const noop = () => {};
    mount(
      <SettingsPage
        settings={{ ...base, ...settings }}
        section="capabilities"
        context={null}
        error={null}
        onToggleTool={noop}
        onToggleTailscale={noop}
        tailscaleBusy={false}
        permission="granted"
        onToggleNotifications={noop}
        onToggleBoard={noop}
        onToggleCodeReview={noop}
        onToggleSystem={(next) => toggles.push(next)}
        systemProjects={projects}
        onDeleteThread={async () => {}}
        onDeleteProject={async () => {}}
      />,
    );
  };
  const labels = () => $$('[data-settings-capabilities] .ib-prow').map((row) => row.querySelector('.ib-l')?.textContent);

  test.if(hasDom)('shown only while Code review is on, right under it; off by default asks to turn on', () => {
    const toggles: boolean[] = [];
    draw({ code_review: { on: false }, system: { on: true } }, toggles);
    expect($('[data-settings-system]')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    root = null;
    draw({ code_review: { on: true }, system: { on: false } }, toggles);
    expect(labels()).toEqual(['Board', 'Code review', 'System']);
    const sw = $('[data-settings-system] button[role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(document.getElementById(sw.getAttribute('aria-labelledby')!)?.textContent).toBe('System');
    // Off: no projects listed.
    expect($('[data-settings-system-projects]')).toBeNull();
    act(() => sw.click());
    expect(toggles).toEqual([true]);
  });

  test.if(hasDom)('on: each project with its drawing in words, and Set up opens its setup', async () => {
    draw({ code_review: { on: true }, system: { on: true } }, []);
    const rows = $$('[data-settings-system-project]').map((row) => row.textContent);
    expect(rows).toEqual(['app2 sheetsSet up', 'new-thingNot drawn yetSet up']);
    act(() => $('[data-settings-system-setup="prj_new"]')!.click());
    await settle();
    expect(setupAsked).toEqual({ project: 'prj_new' });
  });
});

// ---------------------------------------------------------------- Reviews

function pull(number: number, fields: Partial<InboxPull> = {}): InboxPull {
  return {
    key: `github.com/acme/app#${number}`, platform: 'github', host: 'github.com', repo: 'acme/app', number, url: `https://github.com/acme/app/pull/${number}`,
    title: `PR ${number}`, author: 'jun', mine: false, requested: true, state: 'open', base: 'main', head: `b${number}`, head_repo: 'acme/app',
    additions: 1, deletions: 1, files: 1, review: null, approved_by: null, reviewers: [], checks: null, updated_at: '2026-11-06T09:00:00.000Z', merged_at: null,
    ...fields,
  };
}
const MODEL: InboxPullsAnswer = {
  fetched_at: '2026-11-06T09:30:00.000Z',
  hosts: [{ cli: 'gh', host: 'github.com', login: 'dana' }],
  pulls: [pull(11, { title: 'Faster routes' }), pull(12, { title: 'Docs only' })],
  links: {},
  projects: { 'github.com/acme/app': ['prj_app'] },
  cards: {},
  clis: { gh: 'signed_in' },
  unsigned: [],
};

function drawReviews(system: Partial<PullsSystem> | null, over: Partial<PullsPageProps> = {}) {
  const opened: (string | null)[] = [];
  const props: PullsPageProps = {
    state: { model: MODEL, reviews: { fetched_at: MODEL.fetched_at, hosts: MODEL.hosts, rows: [], projects: MODEL.projects }, error: null, loading: false, refresh: () => {}, reload: () => {}, reloadRows: () => {} },
    stackId: null,
    project: null,
    filter: 'all',
    projects: [],
    projectNames: new Map(),
    phone: false,
    onOpenStack: () => {},
    onScope: () => {},
    onReview: () => {},
    onOpenThread: () => {},
    onNew: () => {},
    onLaunch: () => {},
    onStarted: () => {},
    system: system
      ? { projects: [APP, NEW], open: null, sheet: null, full: false, onOpen: (p) => opened.push(p), onSheet: () => {}, onFull: () => {}, onMenu: () => {}, ...system }
      : null,
    ...over,
  };
  mount(<PullsPage {...props} />);
  return { opened };
}

describe('Reviews: the System button', () => {
  test.if(hasDom)('System not shown: the head is today\'s, Reviews and the filter mark', async () => {
    drawReviews(null);
    await settle();
    expect($('[data-system-button]')).toBeNull();
    expect($('[data-pulls-filter-trigger]')).not.toBeNull();
    expect($('[data-pulls-pane-empty]')).not.toBeNull();
  });

  test.if(hasDom)('the menu lists drawn projects only; a pick opens it; "Set up a project" opens setup', async () => {
    const { opened } = drawReviews({});
    await settle();
    await press($('[data-system-button]')!);
    const listed = $$('[data-system-menu-project]').map((row) => [row.getAttribute('data-system-menu-project'), row.querySelector('.ib-pmi-n')?.textContent]);
    expect(listed).toEqual([['prj_app', '2 sheets']]);
    expect($('[data-system-menu-none]')).toBeNull();
    await press($('[data-system-menu-project="prj_app"]')!);
    expect(opened).toEqual(['prj_app']);
    await press($('[data-system-button]')!);
    await press($('[data-system-menu-setup]')!);
    expect(setupAsked).toEqual({ project: null });
  });

  test.if(hasDom)('nothing drawn: the menu says so, with "Set up a project"', async () => {
    drawReviews({ projects: [NEW] });
    await settle();
    await press($('[data-system-button]')!);
    expect($('[data-system-menu-none]')?.textContent).toBe('No project is drawn yet.');
    expect($$('[data-system-menu-project]')).toEqual([]);
    expect($('[data-system-menu-setup]')).not.toBeNull();
  });

  test.if(hasDom)('an open project is named on the button and its drawing takes the pane; a PR\'s pane takes it back', async () => {
    drawReviews({ open: 'prj_app' }, { stackId: null });
    await settle();
    expect($('[data-system-button]')!.getAttribute('aria-label')).toBe('System: app');
    expect($('[data-system-pane="prj_app"]')).not.toBeNull();
    expect($('[data-pulls-pane-empty]')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    root = null;
    drawReviews({ open: 'prj_app' }, { stackId: 'github.com/acme/app#11' });
    await settle();
    expect($('[data-system-pane]')).toBeNull();
    expect($('[data-pulls-stack]')).not.toBeNull();
    expect($('[data-system-button]')!.getAttribute('aria-label')).toBe('System');
  });
});

// ---------------------------------------------------------------- the pane

const DRAWING = {
  'system.yaml': [
    'format: 1',
    'system: App',
    'root: C-001',
    'scopes: { root: App }',
    'parts:',
    '  person: { name: Maya Chen, kind: people }',
    '  api: { name: The API, code: { src/api: every route } }',
    '  web: { name: The web app, code: { src/web: the pages } }',
    '',
  ].join('\n'),
  'sheets/C-001.yaml': 'sheet: C-001\nscope: root\nkind: conceptual\ntitle: App\nbands:\n  - { id: all, row: [person, api, web] }\n',
};

function drawPane(over: Partial<SystemPaneProps> & { model?: unknown; state?: SystemProjectRow['state'] } = {}) {
  const asked: { stack: string[]; full: boolean[]; closed: number } = { stack: [], full: [], closed: 0 };
  const model = over.model === undefined ? loadFiles(DRAWING).model : over.model;
  mount(
    <SystemPane
      project="prj_app"
      sheet={null}
      full={false}
      phone={false}
      pulls={MODEL}
      onSheet={() => {}}
      onFull={(f) => asked.full.push(f)}
      onClose={() => (asked.closed += 1)}
      onOpenStack={(key) => asked.stack.push(key)}
      api={{
        drawing: async () => ({ project: { ...APP, state: over.state ?? APP.state }, model: model as never }),
        pulls: async () => ({ pulls: [{ key: 'github.com/acme/app#11', parts: [{ id: 'api', name: 'The API' }, { id: 'web', name: 'The web app' }] }], unread: 1 }),
      }}
      {...over}
    />,
  );
  return asked;
}

describe('A project\'s drawing in the pane', () => {
  test.if(hasDom)('the drawing, then the open PRs that change it; a row opens that PR\'s pane', async () => {
    const asked = drawPane();
    await settle();
    expect($('[data-system-pane="prj_app"] .sys-view')).not.toBeNull();
    const rows = $$('[data-system-pull]');
    expect(rows.map((r) => r.getAttribute('data-system-pull'))).toEqual(['github.com/acme/app#11']);
    expect(rows[0]!.querySelector('.ib-sysprs-t')?.textContent).toBe('Faster routes');
    expect(rows[0]!.querySelector('[data-system-pull-parts]')?.textContent).toBe('The API and The web app');
    expect($('[data-system-pulls-unread]')?.textContent).toBe('1 pull request could not be read.');
    act(() => rows[0]!.click());
    expect(asked.stack).toEqual(['github.com/acme/app#11']);
  });

  test.if(hasDom)('Open full window asks for the window; its "Reviews" goes back to the pane', async () => {
    const asked = drawPane();
    await settle();
    const openFull = $$('button').find((b) => b.textContent === 'Open full window')!;
    act(() => openFull.click());
    expect(asked.full).toEqual([true]);
    act(() => root?.unmount());
    host?.remove();
    root = null;
    const inFull = drawPane({ full: true });
    await settle();
    expect($('[data-system-full]')).not.toBeNull();
    // The PRs stand beside the drawing in the window.
    expect($('.ib-sysfull-aside [data-system-pull]')).not.toBeNull();
    act(() => $('[data-system-back]')!.click());
    expect(inFull.full).toEqual([false]);
  });

  test.if(hasDom)('not drawn yet: says so, with Set up for that project', async () => {
    drawPane({ model: null, state: 'none' });
    await settle();
    expect($('[data-system-pane-none="none"]')?.textContent).toContain('app is not drawn yet.');
    expect($('[data-system-pulls]')).toBeNull();
    act(() => $$('[data-system-pane-none] button')[0]!.click());
    await settle();
    expect(setupAsked).toEqual({ project: 'prj_app' });
  });
});

const frames = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
};

describe('Off means off, and the focus', () => {
  test.if(hasDom)('the projects are read only while System shows', async () => {
    let flip: (on: boolean) => void = () => {};
    function Reader() {
      const [on, setOn] = useState(false);
      flip = setOn;
      const { projects } = useSystemProjects(on);
      return <p data-read="">{projects ? projects.length : 'none'}</p>;
    }
    mount(<Reader />);
    await settle();
    expect(systemReads).toEqual([]);
    expect($('[data-read]')?.textContent).toBe('none');
    act(() => flip(true));
    await settle();
    expect(systemReads.length).toBe(1);
    expect($('[data-read]')?.textContent).toBe('1');
  });

  test.if(hasDom)('the full window makes what it covers inert, and closing it gives the focus back to "Open full window"', async () => {
    let setFull: (full: boolean) => void = () => {};
    function Page() {
      const [full, set] = useState(false);
      setFull = set;
      return (
        <div>
          <nav>
            <button type="button" data-behind="">A Reviews row</button>
          </nav>
          <SystemPane
            project="prj_app"
            sheet={null}
            full={full}
            phone={false}
            pulls={MODEL}
            onSheet={() => {}}
            onFull={set}
            onClose={() => {}}
            onOpenStack={() => {}}
            api={{ drawing: async () => ({ project: APP, model: loadFiles(DRAWING).model as never }), pulls: async () => ({ pulls: [], unread: 0 }) }}
          />
        </div>
      );
    }
    mount(<Page />);
    await settle();
    const behind = () => $('[data-behind]')!.closest('nav')!;
    expect(behind().inert).toBe(false);
    act(() => setFull(true));
    await settle();
    expect(behind().inert).toBe(true);
    expect(document.activeElement).toBe($('[data-system-back]'));
    act(() => $('[data-system-back]')!.click());
    await settle();
    expect(behind().inert).toBe(false);
    expect(document.activeElement?.textContent?.trim()).toBe('Open full window');
  });

  test.if(hasDom)('the drawing closed: the focus returns to the System button', async () => {
    drawReviews({ open: 'prj_app' });
    await settle();
    $('[data-system-pane]')!.focus();
    drawReviews({ open: null });
    await settle();
    await frames();
    expect($('[data-system-pane]')).toBeNull();
    expect(document.activeElement).toBe($('[data-system-button]'));
  });
});
