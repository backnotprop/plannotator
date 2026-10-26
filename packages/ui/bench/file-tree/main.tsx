/**
 * The file tree benchmark and fidelity page. Built by vite.config.ts, driven
 * by run.ts through `window.__h`. Not part of any app or of the published
 * package.
 *
 *   ?mode=bench&impl=new|new-tips|pl-browser|pierre&theme=light   (timings)
 *   ?mode=shots&set=small|deep|parity&theme=light|dark            (screenshots)
 */
import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './style.css';
import { FileTree, type FileTreeHandle } from '../../components/file-tree/FileTree';
import { FileTreeStore, type FileTreeBadge } from '../../components/file-tree/store';
import { FileBrowser } from '../../components/sidebar/FileBrowser';
import { setComponentTooltips } from '../../components/HostTitle';
import { TooltipProvider } from '../../components/Tooltip';
import { buildFileTree } from '../../../shared/reference-common';
import type { VaultNode } from '../../types';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') ?? 'bench';
const impl = q.get('impl') ?? 'new';
const theme = q.get('theme') ?? 'light';
document.documentElement.classList.add('theme-plannotator', theme === 'dark' ? 'dark' : 'light');
document.documentElement.style.colorScheme = theme;

type H = Record<string, any>;
const h: H = ((window as any).__h = { impl, mode, marks: {} as Record<string, number> });
const mark = (k: string) => {
  h.marks[k] = performance.now();
};
const frames = (n = 2) =>
  new Promise<void>((r) => {
    const step = (i: number) => (i <= 0 ? r() : requestAnimationFrame(() => step(i - 1)));
    step(n);
  });

function shadowRoot(): ShadowRoot | null {
  for (const el of document.querySelectorAll('#panel *')) if ((el as HTMLElement).shadowRoot) return (el as HTMLElement).shadowRoot;
  return null;
}
h.rowCount = () => {
  if (impl === 'pierre') return shadowRoot()?.querySelectorAll('[data-item-path]').length ?? 0;
  if (impl === 'pl-browser') return document.querySelectorAll('#panel button').length;
  return document.querySelectorAll('#panel [role="treeitem"]').length;
};
h.domNodes = () => document.getElementsByTagName('*').length + (shadowRoot()?.querySelectorAll('*').length ?? 0);
h.scroller = (): HTMLElement => {
  if (impl === 'pierre') {
    const sr = shadowRoot();
    if (sr) {
      for (const el of sr.querySelectorAll('*')) {
        const e = el as HTMLElement;
        const cs = getComputedStyle(e);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight) return e;
      }
    }
  }
  if (impl === 'new' || impl === 'new-tips') return document.querySelector('#panel [role="tree"]') as HTMLElement;
  return document.querySelector('#panel') as HTMLElement;
};

/** Scroll by `step` px every frame for `ms` (bouncing at the ends), or to a random place each frame. */
h.scrollTest = async (ms = 3000, step = 40, jump = false) => {
  const sc = h.scroller();
  sc.scrollTop = 0;
  await frames(3);
  const times: number[] = [];
  let last = performance.now();
  const end = last + ms;
  let dir = 1;
  await new Promise<void>((r) => {
    const tick = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      if (jump) sc.scrollTop = Math.random() * (sc.scrollHeight - sc.clientHeight);
      else {
        const before = sc.scrollTop;
        sc.scrollTop = before + dir * step;
        if (sc.scrollTop === before) dir = -dir;
      }
      if (now < end) requestAnimationFrame(tick);
      else r();
    };
    requestAnimationFrame(tick);
  });
  times.shift();
  const sorted = [...times].sort((a, b) => a - b);
  return {
    frames: times.length,
    fps: 1000 / (times.reduce((a, b) => a + b, 0) / times.length),
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted[sorted.length - 1],
    over33: times.filter((t) => t > 33.4).length,
    scrollHeight: sc.scrollHeight,
  };
};


function dirsUnder(paths: string[], prefix: string): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort();
}

// ---------------------------------------------------------------- one timing for every tree

/**
 * Wall time from the change until it is on screen, the same rule for every
 * tree: the later of two frames after the call and the last DOM change the
 * tree made (a React render that yields between frames keeps changing the DOM
 * after two frames; Pierre renders inside a shadow root, observed too).
 */
async function timed(fn: () => void): Promise<number> {
  const panel = document.querySelector('#panel') as HTMLElement;
  let last = 0;
  const mo = new MutationObserver(() => {
    last = performance.now();
  });
  const opts = { subtree: true, childList: true, attributes: true, characterData: true };
  mo.observe(panel, opts);
  const sr = shadowRoot();
  if (sr) mo.observe(sr, opts);
  const t0 = performance.now();
  fn();
  await frames(2);
  let end = performance.now();
  // Wait until two frames pass with no change.
  let quiet = 0;
  while (quiet < 2 && performance.now() - t0 < 60000) {
    const before = last;
    await frames(1);
    quiet = last === before ? quiet + 1 : 0;
  }
  mo.disconnect();
  end = Math.max(end, last);
  return end - t0;
}

// ---------------------------------------------------------------- new tree

function NewTree({ store }: { store: FileTreeStore }) {
  return (
    <TooltipProvider>
      <FileTree tree={store} rowHeight={22} label="Files" />
    </TooltipProvider>
  );
}

function mountNew(paths: string[]) {
  if (impl === 'new-tips') setComponentTooltips(true);
  // As useFileTree builds it: top-level rows first, the full index in slices.
  const store = new FileTreeStore(paths, { sliced: true });
  h.store = store;
  void store.whenReady().then(async () => {
    await frames(2);
    mark('fullReady');
    h.fullReady = true;
  });
  h.expand = (p: string) => timed(() => store.expand(p));
  h.collapse = (p: string) => timed(() => store.collapse(p));
  h.expandAllUnder = async (prefix: string) => ({ ms: await timed(() => store.expandAll(prefix.replace(/\/$/, ''))), visible: store.model.rowCount });
  h.collapseAllUnder = async (prefix: string) => ({ ms: await timed(() => store.collapseAll(prefix.replace(/\/$/, ''))), visible: store.model.rowCount });
  h.expandEverything = async () => ({ ms: await timed(() => store.expandAll()), visible: store.model.rowCount });
  h.collapseEverything = async () => ({ ms: await timed(() => store.collapseAll()), visible: store.model.rowCount });
  h.filter = async (q: string) => ({ ms: await timed(() => store.setFilter(q)), visible: store.model.rowCount });
  return store;
}

// ---------------------------------------------------------------- Pierre

async function mountPierre(paths: string[]) {
  // Aliased by vite.config.ts to PIERRE_TREES_DIR when it is set, else to a stub that throws.
  const { FileTree: PierreTree } = await import('@pierre/trees');
  const panel = document.querySelector('#panel') as HTMLElement;
  panel.classList.add('pierre');
  const model = new PierreTree({ paths, initialExpansion: 'closed', icons: 'standard', search: true, flattenEmptyDirectories: true });
  h.model = model;
  const wrap = document.createElement('div');
  wrap.style.height = '100%';
  panel.appendChild(wrap);
  model.render({ containerWrapper: wrap });
  const item = (p: string) => model.getItem(p) as any;
  h.expand = (p: string) => timed(() => item(p)?.expand());
  h.collapse = (p: string) => timed(() => item(p)?.collapse());
  // Pierre has no expand-all: one expand() per folder, the way the first harness measured it.
  h.expandAllUnder = async (prefix: string) => ({ ms: await timed(() => { for (const d of dirsUnder(h.paths, prefix)) item(d)?.expand?.(); }), visible: model.getVisibleCount() });
  h.collapseAllUnder = async (prefix: string) => {
    const folder = prefix.replace(/\/$/, '');
    const dirs = dirsUnder(h.paths, prefix).filter((d) => d === folder || d.startsWith(prefix)).reverse();
    return { ms: await timed(() => { for (const d of dirs) item(d)?.collapse?.(); }), visible: model.getVisibleCount() };
  };
  h.expandEverything = async () => ({ ms: await timed(() => { for (const d of dirsUnder(h.paths, '')) item(d)?.expand?.(); }), visible: model.getVisibleCount() });
  h.collapseEverything = async () => ({ ms: await timed(() => { for (const d of dirsUnder(h.paths, '').reverse()) item(d)?.collapse?.(); }), visible: model.getVisibleCount() });
}

// ---------------------------------------------------------------- old FileBrowser

function OldBrowser({ tree, dirPath = '/root', expandedInit }: { tree: VaultNode[]; dirPath?: string; expandedInit?: Set<string> }) {
  const [expanded, setExpanded] = useState<Set<string>>(expandedInit ?? new Set());
  useEffect(() => {
    if (mode !== 'bench') return;
    const key = (p: string) => `${dirPath}:${p}`;
    h.expand = (p: string) => timed(() => setExpanded((s) => new Set(s).add(key(p))));
    h.collapse = (p: string) =>
      timed(() =>
        setExpanded((s) => {
          const n = new Set(s);
          n.delete(key(p));
          return n;
        }),
      );
    h.expandAllUnder = async (prefix: string) => {
      const dirs = dirsUnder(h.paths, prefix).map(key);
      const ms = await timed(() => setExpanded((s) => new Set([...s, ...dirs])));
      return { ms, visible: h.rowCount() };
    };
    h.collapseAllUnder = async (prefix: string) => {
      const folder = key(prefix.replace(/\/$/, ''));
      const under = key(prefix);
      const ms = await timed(() => setExpanded((s) => new Set([...s].filter((k) => k !== folder && !k.startsWith(under)))));
      return { ms, visible: h.rowCount() };
    };
  }, [dirPath]);
  return (
    <FileBrowser
      dirs={[{ path: dirPath, name: 'root', tree, isLoading: false, error: null, hasLoadedTree: true } as any]}
      expandedFolders={expanded}
      onToggleFolder={(k) =>
        setExpanded((s) => {
          const n = new Set(s);
          n.has(k) ? n.delete(k) : n.add(k);
          return n;
        })
      }
      collapsedDirs={new Set()}
      onToggleCollapse={() => {}}
      onSelectFile={() => {}}
      activeFile={null}
      onFetchAll={() => {}}
    />
  );
}

// ---------------------------------------------------------------- screenshots

const DEEP_NAMES = ['src', 'packages', 'very-long-folder-name-that-keeps-going', 'компоненты', 'コンポーネント', 'level'];
function deepSet(): string[] {
  const out: string[] = [];
  let prefix = '';
  for (let d = 0; d < 22; d++) {
    prefix = prefix ? `${prefix}/${DEEP_NAMES[d % DEEP_NAMES.length]}-${d}` : `${DEEP_NAMES[0]}-0`;
    out.push(`${prefix}/file-at-depth-${d}.ts`);
    if (d % 4 === 0) out.push(`${prefix}/a-very-long-file-name-that-will-certainly-not-fit-in-a-narrow-sidebar-${d}.config.json`);
    if (d % 5 === 1) out.push(`${prefix}/日本語のファイル名-${d}.md`, `${prefix}/Ελληνικά-${d}.txt`, `${prefix}/עברית-${d}.md`);
  }
  out.push('README.md', 'zz-top-level.ts');
  return out;
}

const SMALL = [
  'apps/hook/server/index.ts',
  'apps/hook/server/cli.ts',
  'apps/review/index.tsx',
  'packages/ui/components/Viewer.tsx',
  'packages/ui/components/sidebar/FileBrowser.tsx',
  'packages/ui/components/file-tree/FileTree.tsx',
  'packages/ui/components/file-tree/model.ts',
  'packages/ui/components/file-tree/store.ts',
  'packages/ui/theme.css',
  'packages/core/annotatable.ts',
  'docs/guide.md',
  'docs/notes.txt',
  'README.md',
  'a2.ts',
  'a10.ts',
  'CHANGELOG.md',
  'package.json',
];
const SMALL_BADGES = new Map<string, FileTreeBadge>([
  ['packages/ui/components/file-tree/FileTree.tsx', { letter: 'A', tone: 'added', additions: 512, label: 'Added' }],
  ['packages/ui/components/file-tree/model.ts', { letter: 'A', tone: 'added', additions: 640, count: 2, label: 'Added, 2 comments' }],
  ['packages/ui/components/Viewer.tsx', { additions: 4, deletions: 2, count: 1, marker: { glyph: '•', tone: 'primary', label: 'Unsaved edits' } }],
  ['apps/hook/server/cli.ts', { letter: 'R', tone: 'renamed', label: 'Renamed' }],
  ['docs/notes.txt', { letter: 'D', tone: 'deleted', struck: true, disabled: true, label: 'Deleted' }],
  ['CHANGELOG.md', { letter: 'U', tone: 'untracked', label: 'Untracked' }],
]);

/**
 * `?mode=live`: a store the browser proofs drive through `window.__h` (tests/e2e/file-tree.spec.ts):
 * folders a/ and b/ above 500 files g000…g499, in a 320 × 600 panel.
 */
function Live() {
  const [store] = useState(() => {
    const paths = ['a/one.ts', 'a/two.ts', 'b/x.ts', ...Array.from({ length: 500 }, (_, i) => `g${String(i).padStart(3, '0')}.ts`)];
    return new FileTreeStore(paths);
  });
  h.store = store;
  h.tree = () => document.querySelector('[role="tree"]') as HTMLElement;
  /** The path of the row whose top is at or just above the tree's scrollTop. */
  h.topPath = () => {
    const tree: HTMLElement = h.tree();
    const rows = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const top = tree.scrollTop;
    let best: HTMLElement | null = null;
    for (const r of rows) if (r.offsetTop <= top + 0.5 && (!best || r.offsetTop > best.offsetTop)) best = r;
    return best?.dataset.path ?? null;
  };
  useEffect(() => {
    h.ready = true;
  }, []);
  return (
    <div id="live" style={{ width: 320, height: 600 }} className="bg-card">
      <FileTree tree={store} />
    </div>
  );
}

function Shots() {
  const set = q.get('set') ?? 'small';
  const ref = useRef<FileTreeHandle>(null);
  const [store] = useState(() => {
    setComponentTooltips(true);
    if (set === 'deep') {
      const s = new FileTreeStore(deepSet());
      s.expandAll();
      return s;
    }
    return new FileTreeStore(SMALL, { badges: SMALL_BADGES, expanded: ['packages', 'packages/ui', 'packages/ui/components', 'packages/ui/components/file-tree', 'docs'] });
  });
  const selected = set === 'deep' ? 'src-0/packages-1/very-long-folder-name-that-keeps-going-2/компоненты-3/file-at-depth-3.ts' : 'packages/ui/components/file-tree/model.ts';
  h.reveal = (p: string) => ref.current?.revealPath(p);
  h.focusTree = () => ref.current?.focus();
  useEffect(() => {
    h.ready = true;
  }, []);
  if (set === 'parity') {
    const tree = buildFileTree(SMALL);
    const exp = new Set(['/root:packages', '/root:packages/ui', '/root:packages/ui/components', '/root:packages/ui/components/file-tree', '/root:docs']);
    return (
      <div className="flex gap-6 p-4">
        <div>
          <div id="old" className="w-[300px] h-[620px] overflow-auto bg-card border border-border rounded">
            <OldBrowser tree={tree} expandedInit={exp} />
          </div>
        </div>
        <div>
          <div id="new" className="w-[300px] h-[620px] bg-card border border-border rounded py-1">
            <FileTree tree={store} selectedPath={selected} indent={14} rowHeight={26} />
          </div>
        </div>
      </div>
    );
  }
  const phone = q.get('phone') === '1';
  return (
    <div id="shot" className={phone ? 'w-full h-[100dvh] bg-card' : 'w-[320px] h-[760px] bg-card border-r border-border'}>
      <FileTree ref={ref} tree={store} selectedPath={selected} rowHeight={phone ? 36 : undefined} />
    </div>
  );
}

// ---------------------------------------------------------------- boot

(async () => {
  const root = document.getElementById('root')!;
  if (mode === 'live') {
    ReactDOM.createRoot(root).render(<Live />);
    return;
  }
  if (mode === 'shots') {
    ReactDOM.createRoot(root).render(
      <TooltipProvider>
        <Shots />
      </TooltipProvider>,
    );
    return;
  }
  mark('fetchStart');
  const paths: string[] = await (await fetch('/data.json')).json();
  h.paths = paths;
  h.count = paths.length;
  // The old FileBrowser is handed a built VaultNode tree (the server builds it in Plannotator).
  const vault = impl === 'pl-browser' ? buildFileTree(paths) : null;
  await frames(1);
  mark('dataReceived');
  const panel = document.createElement('div');
  panel.id = 'panel';
  root.appendChild(panel);
  if (impl === 'pierre') {
    await mountPierre(paths);
    await frames(2);
    mark('painted');
    h.ready = true;
    return;
  }
  const store = impl === 'pl-browser' ? null : mountNew(paths);
  function App() {
    useEffect(() => {
      mark('committed');
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          mark('painted');
          h.ready = true;
        }),
      );
    }, []);
    return store ? <NewTree store={store} /> : <OldBrowser tree={vault!} />;
  }
  ReactDOM.createRoot(panel).render(<App />);
})();
