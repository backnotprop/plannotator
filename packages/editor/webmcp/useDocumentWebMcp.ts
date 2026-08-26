/**
 * App-side wiring: builds the `DocumentToolAdapter` over App state (read
 * through one ref updated every render, the `headerHandlersRef` pattern) and
 * attaches the phase-1 catalog with `useToolset`.
 *
 * Zero footprint without WebMCP: `useToolset` resolves `document.modelContext`
 * once; when it is absent, the catalog is never built, the tracker never
 * observes, and no effect body runs. Nothing here is rendered, and the
 * opt-out preference is read lazily (no settings-registry entry, so no
 * cookie is ever seeded for a user who never opts out).
 */
import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { getDocPreviewFetcher } from '@plannotator/ui/components/InlineMarkdown';
import type { ViewerHandle } from '@plannotator/ui/components/Viewer';
import type { CachedDocState } from '@plannotator/ui/hooks/useLinkedDoc';
import { AnnotationType, type Annotation, type Block, type VaultNode } from '@plannotator/ui/types';
import { getWebMcpPolicy, useToolset, useWebMcpToolsEnabled, type DocumentSurface } from '@plannotator/ui/webmcp';
import {
  buildDocumentHooks,
  buildDocumentTools,
  createDocumentToolState,
  syncTrackers,
  type DocumentSessionView,
  type DocumentSnapshot,
  type DocumentToolAdapter,
  type SessionDecision,
  type SessionMode,
  type SiblingDocument,
} from './documentTools';

export interface DocumentWebMcpFileBrowserDir {
  path: string;
  tree: VaultNode[];
  isVault?: boolean;
}

export interface DocumentWebMcpInputs {
  isApiMode: boolean;
  isSharedSession: boolean;
  goalSetupMode: boolean;
  annotateMode: boolean;
  annotateSource: 'file' | 'message' | 'folder' | null;
  liveApp: { appUrl: string } | null;
  livePageUrl: string;
  archiveMode: boolean;
  gate: boolean;
  submitted: 'approved' | 'denied' | 'exited' | null;
  renderAs: 'markdown' | 'html';
  rawHtml: string;
  displayedMarkdown: string;
  blocks: Block[];
  allAnnotations: Annotation[];
  isEditingMarkdown: boolean;
  editorDiffersFromBaseline: boolean;
  sourceStale: boolean;
  sourceFilePath: string | undefined;
  sourceInfo: string | undefined;
  versionInfo: { version: number; totalVersions: number } | null;
  linkedDoc: {
    isActive: boolean;
    filepath: string | null;
    /** useLinkedDoc's load error; a failed open lands here rather than rejecting. */
    error: string | null;
    getDocAnnotations: () => Map<string, CachedDocState>;
    open: (path: string) => Promise<void>;
  };
  /** Folder sessions: the file browser's loaded directories (absolute dir path + relative tree). */
  fileBrowserDirs: DocumentWebMcpFileBrowserDir[];
  /** Folder sessions: the absolute path the file browser has selected. */
  fileBrowserActiveFile: string | null;
  /** Folder sessions: App's file-browser selection handler (absolute path + its directory). */
  openFolderFile?: (absolutePath: string, dirPath: string) => Promise<void>;
  viewerRef: RefObject<ViewerHandle | null>;
  scrollViewport: HTMLElement | null;
  addAnnotation: (annotation: Annotation) => void;
  editAnnotation: (id: string, patch: Partial<Annotation>) => void;
  deleteAnnotation: (id: string) => void;
  selectAnnotation: (id: string | null) => void;
  showBanner: (message: string) => void;
}

const PAINT_DELAY_MS = 50;
/** How long `reveal { path }` waits for the navigated document to commit. */
const NAVIGATION_COMMIT_TIMEOUT_MS = 5000;

function firstHeading(blocks: readonly Block[]): string | null {
  const heading = blocks.find((b) => b.type === 'heading');
  return heading ? heading.content : null;
}

function isComposerOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector('[data-comment-popover="true"]');
}

/** Every file in a directory tree as an absolute path (the file browser's own `${dir}/${node.path}` rule). */
export function flattenFileBrowserDirs(dirs: readonly DocumentWebMcpFileBrowserDir[]): Array<{ path: string; title?: string }> {
  const out: Array<{ path: string; title?: string }> = [];
  const walk = (dirPath: string, nodes: readonly VaultNode[]) => {
    for (const node of nodes) {
      if (node.type === 'file') out.push({ path: `${dirPath}/${node.path}`, title: node.name });
      else if (node.children) walk(dirPath, node.children);
    }
  };
  for (const dir of dirs) {
    if (dir.isVault) continue;
    walk(dir.path, dir.tree);
  }
  return out;
}

/**
 * Pending writes the tools made that React has not committed yet. The
 * adapter overlays them on the last committed list so the nudges built
 * right after a mutation (and the tracker seq of the new comment) reflect
 * the mutation; entries drop out as soon as the committed list shows them.
 */
interface OptimisticOverlay {
  added: Map<string, Annotation>;
  patched: Map<string, Partial<Annotation>>;
  removed: Set<string>;
}

export function applyOverlay(base: readonly Annotation[], overlay: OptimisticOverlay): Annotation[] {
  const ids = new Set(base.map((a) => a.id));
  // Reconcile: anything the committed list already reflects is done.
  for (const id of overlay.added.keys()) if (ids.has(id)) overlay.added.delete(id);
  for (const id of overlay.removed) if (!ids.has(id)) overlay.removed.delete(id);
  for (const [id, patch] of overlay.patched) {
    const live = base.find((a) => a.id === id);
    if (!live || Object.entries(patch).every(([k, v]) => (live as unknown as Record<string, unknown>)[k] === v)) overlay.patched.delete(id);
  }
  if (overlay.added.size === 0 && overlay.removed.size === 0 && overlay.patched.size === 0) return base as Annotation[];
  const merged = base
    .filter((a) => !overlay.removed.has(a.id))
    .map((a) => (overlay.patched.has(a.id) ? { ...a, ...overlay.patched.get(a.id) } : a));
  for (const added of overlay.added.values()) merged.push(added);
  return merged;
}

export function useDocumentWebMcp(inputs: DocumentWebMcpInputs): { available: boolean; registered: boolean } {
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const state = useMemo(() => createDocumentToolState(), []);
  const toolsEnabled = useWebMcpToolsEnabled();
  const overlayRef = useRef<OptimisticOverlay>({ added: new Map(), patched: new Map(), removed: new Set() });
  // Waiters for `reveal { path }`: resolved by the commit effect below once
  // the navigated document is the open one.
  const navigationWaitersRef = useRef<Array<{ path: string; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>>([]);
  /** Resolve every waiter for `path` (or all when null) and clear their timers. */
  const settleWaiter = (path: string | null, ok: boolean) => {
    const remaining: typeof navigationWaitersRef.current = [];
    for (const waiter of navigationWaitersRef.current) {
      if (path === null || waiter.path === path) {
        clearTimeout(waiter.timer);
        waiter.resolve(ok);
      } else {
        remaining.push(waiter);
      }
    }
    navigationWaitersRef.current = remaining;
  };

  const surface: DocumentSurface = inputs.liveApp ? 'live-app' : inputs.renderAs === 'html' ? 'html' : 'markdown';
  const writable = !inputs.archiveMode && inputs.submitted === null;
  const folder = inputs.annotateSource === 'folder';
  const active = (inputs.isApiMode || inputs.isSharedSession) && !inputs.goalSetupMode && toolsEnabled;

  const adapter = useMemo<DocumentToolAdapter>(() => {
    const current = () => inputsRef.current;
    const openPath = () => {
      const i = current();
      return i.linkedDoc.filepath ?? i.sourceFilePath ?? null;
    };
    const annotations = () => applyOverlay(current().allAnnotations, overlayRef.current);
    const getDocument = (): DocumentSnapshot => {
      const i = current();
      return {
        path: openPath(),
        text: i.liveApp ? null : i.displayedMarkdown,
        blocks: i.liveApp ? [] : i.blocks,
        annotations: annotations(),
        html: i.renderAs === 'html' ? i.rawHtml : null,
      };
    };
    const paint = (annotation: Annotation) => {
      if (annotation.type === AnnotationType.GLOBAL_COMMENT || !annotation.originalText) return;
      const viewer = current().viewerRef;
      setTimeout(() => {
        viewer.current?.applySharedAnnotations([annotation]);
      }, PAINT_DELAY_MS);
    };
    const isOpen = (path: string | null) => path === null || path === openPath();
    /** The file browser directory that contains `path` (folder sessions). */
    const dirFor = (path: string): string | null =>
      current().fileBrowserDirs.find((d) => !d.isVault && path.startsWith(`${d.path}/`))?.path ?? null;
    /** Navigate to a sibling and resolve once React has committed it as the open document. */
    /** Whether the session knows `path` at all (folder tree or linked-doc cache). */
    const knowsPath = (path: string): boolean => {
      const i = current();
      if (i.linkedDoc.getDocAnnotations().has(path)) return true;
      if (i.annotateSource === 'folder') return flattenFileBrowserDirs(i.fileBrowserDirs).some((d) => d.path === path);
      return false;
    };
    const navigateTo = (path: string): Promise<boolean> => {
      const i = current();
      // A path the session cannot know never opens; answer at once instead
      // of waiting out the commit timeout (linkedDoc.open swallows fetch
      // failures into its error state).
      if (!knowsPath(path)) return Promise.resolve(false);
      // Folder sessions open through the file browser's own selection path so
      // the browser's active file, the doc URL (base + doc=1) and the linked
      // document stay in step, exactly like a click in the sidebar.
      const dir = i.annotateSource === 'folder' ? dirFor(path) : null;
      const open = dir && i.openFolderFile ? () => i.openFolderFile!(path, dir) : () => i.linkedDoc.open(path);
      const commit = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settleWaiter(path, false), NAVIGATION_COMMIT_TIMEOUT_MS);
        navigationWaitersRef.current.push({ path, resolve, timer });
      });
      void open().catch(() => settleWaiter(path, false));
      return commit;
    };
    return {
      getSession(): DocumentSessionView {
        const i = current();
        const mode: SessionMode = i.archiveMode
          ? 'archive'
          : i.isSharedSession && !i.isApiMode
            ? 'shared'
            : i.annotateMode
              ? i.liveApp ? 'annotate-app' : i.annotateSource === 'folder' ? 'annotate-folder' : i.annotateSource === 'message' ? 'annotate-last' : 'annotate'
              : 'plan';
        const decision: SessionDecision = i.submitted === 'approved' ? 'approved' : i.submitted === 'denied' ? 'feedback-sent' : i.submitted === 'exited' ? 'exited' : 'pending';
        const currentSurface: DocumentSurface = i.liveApp ? 'live-app' : i.renderAs === 'html' ? 'html' : 'markdown';
        return {
          mode,
          surface: currentSurface,
          source: {
            title: firstHeading(i.blocks) ?? i.sourceInfo ?? null,
            path: openPath(),
            url: i.liveApp ? i.liveApp.appUrl : null,
          },
          gate: i.gate,
          readOnly: i.archiveMode,
          decision,
          commentOnly: currentSurface !== 'markdown',
          sourceStale: i.sourceStale,
          editing: i.isEditingMarkdown || i.editorDiffersFromBaseline,
          versions: i.versionInfo ? { current: i.versionInfo.version, total: i.versionInfo.totalVersions } : null,
          pageUrl: i.liveApp ? (i.livePageUrl || null) : null,
        };
      },
      getDocument,
      async readDocument(path) {
        const i = current();
        if (!i.isApiMode) return null;
        const cached = i.linkedDoc.getDocAnnotations().get(path);
        if (cached && typeof cached.markdown === 'string') {
          return { path, text: cached.markdown, blocks: parseMarkdownToBlocks(cached.markdown), annotations: cached.annotations };
        }
        if (i.annotateSource !== 'folder' && !cached) return null;
        try {
          // /api/doc answers `{ markdown }` for annotatable documents and
          // `{ contents }` for code files; a folder file is the former.
          const result = (await getDocPreviewFetcher()(path, dirFor(path) ?? undefined)) as { contents?: string; markdown?: string } | null;
          const text = typeof result?.markdown === 'string' ? result.markdown : typeof result?.contents === 'string' ? result.contents : null;
          if (text === null) return null;
          return { path, text, blocks: parseMarkdownToBlocks(text), annotations: cached?.annotations ?? [] };
        } catch {
          return null;
        }
      },
      getSiblingDocuments(): SiblingDocument[] {
        const i = current();
        const open = openPath();
        const siblings: SiblingDocument[] = [];
        const seen = new Set<string>();
        for (const [path, cached] of i.linkedDoc.getDocAnnotations()) {
          if (path === open) continue;
          seen.add(path);
          siblings.push({ path, open: i.fileBrowserActiveFile === path, annotations: cached.annotations, composerOpen: false });
        }
        // Folder sessions: the file browser's selection is "open" even when
        // the linked-doc cache has not seen the document yet.
        if (i.annotateSource === 'folder' && i.fileBrowserActiveFile && i.fileBrowserActiveFile !== open && !seen.has(i.fileBrowserActiveFile)) {
          siblings.push({ path: i.fileBrowserActiveFile, open: true, annotations: [], composerOpen: false });
        }
        return siblings;
      },
      listDocuments() {
        const i = current();
        if (i.annotateSource !== 'folder') return [];
        return flattenFileBrowserDirs(i.fileBrowserDirs);
      },
      getComposer() {
        return { open: isComposerOpen() };
      },
      addAnnotation(annotation, path) {
        if (!isOpen(path)) return false;
        overlayRef.current.added.set(annotation.id, annotation);
        current().addAnnotation(annotation);
        paint(annotation);
        return true;
      },
      updateAnnotation(id, patch, path) {
        if (!isOpen(path)) return false;
        overlayRef.current.patched.set(id, { ...(overlayRef.current.patched.get(id) ?? {}), ...patch });
        const added = overlayRef.current.added.get(id);
        if (added) overlayRef.current.added.set(id, { ...added, ...patch });
        current().editAnnotation(id, patch);
        return true;
      },
      removeAnnotation(id, path) {
        if (!isOpen(path)) return false;
        overlayRef.current.removed.add(id);
        overlayRef.current.added.delete(id);
        current().deleteAnnotation(id);
        return true;
      },
      async revealAnnotation(id, path) {
        if (path !== null && !isOpen(path)) {
          const committed = await navigateTo(path);
          if (!committed) return false;
        }
        const exists = annotations().some((a) => a.id === id);
        if (!exists) return false;
        current().selectAnnotation(id);
        return true;
      },
      async revealSection(blockId, path) {
        if (path !== null && !isOpen(path)) {
          const committed = await navigateTo(path);
          if (!committed) return false;
        }
        if (typeof document === 'undefined') return false;
        const target = document.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
        if (!target) return false;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return true;
      },
      showBanner(message) {
        current().showBanner(message);
      },
    };
  }, []);

  const result = useToolset({
    id: 'document',
    active,
    build: () => buildDocumentTools(adapter, state, { writable, folder, toolName: (bare) => `${getWebMcpPolicy().namePrefix}${bare}` }),
    deps: [surface, writable, folder],
    hooks: useMemo(() => buildDocumentHooks(adapter, state, (bare) => `${getWebMcpPolicy().namePrefix}${bare}`), [adapter, state]),
  });

  // Observe annotation changes as they happen so tombstones and activity
  // times are real-time rather than call-time. Gated on the provider: a
  // browser without WebMCP never runs the body.
  const annotations = inputs.allAnnotations;
  useEffect(() => {
    if (!result.registered) return;
    syncTrackers(adapter, state);
  }, [adapter, state, annotations, result.registered]);

  // Resolve `reveal { path }` waiters on the commit that makes their
  // document the open one (the DOM for it is mounted by then).
  const openFilepath = inputs.linkedDoc.filepath;
  useEffect(() => {
    if (openFilepath !== null) settleWaiter(openFilepath, true);
  }, [openFilepath]);
  // A failed load never becomes the open document: linkedDoc.open swallows
  // the fetch failure into its error state, so that state fails the waiters.
  const openError = inputs.linkedDoc.error;
  useEffect(() => {
    if (openError) settleWaiter(null, false);
  }, [openError]);

  return result;
}
