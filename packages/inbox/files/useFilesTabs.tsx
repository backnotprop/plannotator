/**
 * Files beside a thread (approval "inbox-files-tabs"), for ThreadPane: the
 * open-file tabs, the files panel and its quiet changes toggle, the folder
 * button's state, and the project files the viewers read through the Files
 * routes. ThreadPane keeps today's flow (how a file opens, full screen, the
 * phone) and asks this hook only for what is drawn beside the thread.
 *
 * Only where a file can show beside the thread (`enabled`: a desktop window
 * with room); a phone and a stacked window keep today's screens.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { inboxApi, InboxApiError, type NoFolderReason, type ProjectFileContent, type ThreadFolder } from '../api';
import { selectionToolbarShowing } from '../selectionToolbar';
import { inOverlay, isComposingKey, isEditableTarget, modalOpen } from '../shortcuts/guards';
import { attachmentLabel } from '../attachments';
import type { Artifact } from '../artifacts';
import { useInboxFileSource, type InboxFileSource } from '../fileSource';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { FilesPanel, fileKindIcon } from './FilesPanel';
import { FilesTabRow, type FileTabView } from './FilesTabRow';
import { isProjectFileId, projectFileDir, projectFileId, projectFilePath, projectFileSource, projectFileState } from './projectFiles';
import { closeOtherTabs, closeTab, keepKnownTabs, openTab, stepTab, threadTabs, type FileTabs } from './tabs';

/** The files panel shows (a window choice, a cookie like the Inbox's other layout choices). */
export const FILES_PANEL_COOKIE = 'plannotator-inbox-files-panel';
/** The quiet changes toggle is on. */
export const FILES_CHANGES_COOKIE = 'plannotator-inbox-files-changes';

export interface FilesTabsInput {
  enabled: boolean;
  threadId: string;
  /** The file in the route (on screen when it is beside the thread). */
  fileId: string | null;
  /** `&artifacts` in the route: the pane is open on its Artifacts tab when no file is shown. */
  artifactsRoute: boolean;
  /** The open file is full screen (the tabs are not drawn). */
  shownFull: boolean;
  /** The thread's files have been read (unknown attachment tabs can be dropped). */
  filesLoaded: boolean;
  allFiles: readonly InboxAttachmentState[];
  artifacts: readonly Artifact[] | null;
  /** Comments waiting, by path (fileCommentKey: a project file's by its relative path). */
  counts: ReadonlyMap<string, number>;
  projectRoot: string;
  /** Changes when the folder may have moved (the latest agent message: it can come from another worktree). */
  folderKey: string;
  /** Show a file beside the thread, in its tab (switching tabs: replaces the entry). */
  showFile: (id: string, options?: { replace?: boolean }) => void;
  /** The Artifacts tab (no file shown), or close the pane (`open` false). */
  showArtifacts: (open: boolean, options?: { replace?: boolean }) => void;
  /** Open a file on purpose, as a tile does (its view by today's rule). */
  openOnPurpose: (attachment: Pick<InboxAttachmentState, 'id' | 'kind' | 'ref'> & { name: string }) => void;
  openArtifact: (artifact: Artifact) => void;
  /** Leave the file on screen once nothing unsaved would be lost (AttachmentPane's `leave`). */
  leave: (to: string | null, go: () => void) => void;
  onBlocked: (words: string) => void;
}

export function useFilesTabs(input: FilesTabsInput) {
  const { enabled, threadId, fileId, artifactsRoute, shownFull, allFiles, counts, projectRoot } = input;
  const [tabs, setTabsState] = useState<FileTabs>(() => threadTabs.get(threadId));
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const setTabs = useCallback(
    (next: FileTabs) => {
      tabsRef.current = next;
      setTabsState(next);
      threadTabs.set(threadId, next);
    },
    [threadId],
  );
  const lastCurrent = useRef<string | null>(null);
  const stepping = useRef<{ from: string | null; to: string } | null>(null);
  const [treeOpen, setTreeOpenState] = useState(() => storage.getItem(FILES_PANEL_COOKIE) === 'open');
  const setTreeOpen = (open: boolean) => {
    setTreeOpenState(open);
    storage.setItem(FILES_PANEL_COOKIE, open ? 'open' : 'closed');
  };
  /** The pane was opened on a thread's folder with nothing else to show: the panel shows for this visit, the cookie untouched. */
  const [treeForced, setTreeForced] = useState(false);
  const [showChanges, setShowChangesState] = useState(() => storage.getItem(FILES_CHANGES_COOKIE) === 'on');
  const setShowChanges = (on: boolean) => {
    setShowChangesState(on);
    storage.setItem(FILES_CHANGES_COOKIE, on ? 'on' : 'off');
  };
  // The thread's project folder (PROJECT-FOLDER definition, packages/server/inbox-files.ts `inboxThreadFilesFolder`):
  // undefined while asked, null when it has none (`noFolder` says why).
  const [folderState, setFolderState] = useState<{ threadId: string; folder: ThreadFolder | null; reason: NoFolderReason | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    inboxApi.filesFolder(threadId).then(
      (answer) => {
        if (!gone) setFolderState({ threadId, folder: answer.folder, reason: answer.folder ? null : answer.reason });
      },
      (cause) => {
        // Over the tailnet the Files routes answer local_only: no folder here.
        if (!gone) setFolderState({ threadId, folder: null, reason: cause instanceof InboxApiError && cause.code === 'local_only' ? 'remote' : null });
      },
    );
    return () => {
      gone = true;
    };
  }, [enabled, threadId, input.folderKey]);
  const folder = folderState && folderState.threadId === threadId ? folderState.folder : undefined;
  const noFolder = folderState && folderState.threadId === threadId ? folderState.reason : null;
  const [filterFocus, setFilterFocus] = useState(0);

  // Another thread: its own tabs.
  const shownThread = useRef(threadId);
  useEffect(() => {
    if (shownThread.current === threadId) return;
    shownThread.current = threadId;
    lastCurrent.current = null;
    setTabsState(threadTabs.get(threadId));
  }, [threadId]);

  // The file in the route gets its tab: its own, the one a step replaced, or a new one right of the last shown.
  useEffect(() => {
    if (!fileId) {
      if (artifactsRoute) lastCurrent.current = null;
      return;
    }
    const step = stepping.current;
    stepping.current = null;
    const next = step && step.to === fileId ? stepTab(tabsRef.current, step.from, fileId) : openTab(tabsRef.current, fileId, lastCurrent.current);
    if (next !== tabsRef.current) setTabs(next);
    lastCurrent.current = fileId;
  }, [fileId, artifactsRoute, setTabs]);

  // A tab whose attachment the thread no longer has goes (a project file stays: it may come back).
  useEffect(() => {
    if (!input.filesLoaded) return;
    const known = new Set(allFiles.map((a) => a.id));
    const next = keepKnownTabs(tabsRef.current, (id) => isProjectFileId(id) || known.has(id));
    if (next !== tabsRef.current) setTabs(next);
  }, [allFiles, input.filesLoaded, setTabs]);

  // Project files: the state the viewers read, by name first, then as the server read it.
  const projectStates = useRef(new Map<string, InboxAttachmentState>());
  const [, bump] = useState(0);
  useEffect(() => {
    projectStates.current = new Map();
  }, [threadId]);
  const projectAttachment = useCallback((id: string): InboxAttachmentState | null => {
    const path = projectFilePath(id);
    if (path === null) return null;
    let state = projectStates.current.get(path);
    if (!state) {
      state = { ...projectFileState(path), current: { sha256: '', size: 0, mtime: '' } };
      projectStates.current.set(path, state);
    }
    return state;
  }, []);
  const base = useInboxFileSource();
  const source: InboxFileSource = useMemo(
    () =>
      projectFileSource(threadId, base, (content: ProjectFileContent) => {
        const before = projectStates.current.get(content.path);
        const next = projectFileState(content.path, content);
        if (before && before.kind === next.kind && before.size === next.size && before.current?.sha256 === next.current?.sha256) return;
        projectStates.current.set(content.path, next);
        bump((n) => n + 1);
      }),
    [threadId, base],
  );

  const attachmentOf = (id: string) => allFiles.find((a) => a.id === id) ?? projectAttachment(id);
  const nameOf = (id: string) => attachmentOf(id)?.name ?? 'that file';

  const current = fileId && !shownFull ? fileId : null;
  /** The pane beside the thread is open (a file in its tab, or the Artifacts tab). */
  const paneOpen = enabled && (artifactsRoute || fileId !== null);
  const treeShown = treeOpen || treeForced;
  useEffect(() => {
    if (!paneOpen) setTreeForced(false);
  }, [paneOpen]);
  // Closing the pane (to the thread alone: Escape, a file's ×, the button) closes its tabs, so a file opened later
  // starts a row of its own, as a file opened before the tabs did.
  useEffect(() => {
    if (paneOpen || tabsRef.current.length === 0) return;
    lastCurrent.current = null;
    setTabs([]);
  }, [paneOpen, setTabs]);
  /** The pane has shown its Artifacts tab since it opened (the door, or the tab): closing the last file goes back there. */
  const artifactsShown = useRef(false);
  if (!paneOpen) artifactsShown.current = false;
  else if (artifactsRoute && fileId === null) artifactsShown.current = true;

  const tabViews: FileTabView[] = tabs.map((id) => {
    const path = projectFilePath(id);
    if (path !== null) {
      const state = attachmentOf(id)!;
      return { id, name: state.name, icon: fileKindIcon(state.kind), count: counts.get(path) ?? 0, where: projectFileDir(path) || undefined };
    }
    const a = allFiles.find((f) => f.id === id);
    if (!a) return { id, name: '…', icon: 'doc', count: 0 };
    const label = attachmentLabel(a, projectRoot);
    const dir = label.includes('/') ? label.slice(0, label.lastIndexOf('/')) : '';
    return { id, name: a.name, icon: fileKindIcon(a.kind), count: counts.get(a.path) ?? 0, where: dir || undefined };
  });

  const select = (id: string) => {
    if (id === fileId) return;
    input.leave(nameOf(id), () => input.showFile(id, { replace: true }));
  };
  const close = (id: string) => {
    const result = closeTab(tabsRef.current, id, fileId);
    const go = () => {
      setTabs(result.tabs);
      if (fileId !== id) return;
      if (result.current) input.showFile(result.current, { replace: true });
      // The last file: back to Artifacts when the pane has shown it, else the pane closes, as a file's × did before.
      else input.showArtifacts(artifactsShown.current, { replace: true });
    };
    if (id === fileId) input.leave(null, go);
    else go();
  };
  const closeOthers = () => setTabs(closeOtherTabs(tabsRef.current, fileId));
  // Close all: back to the thread alone, as closing the last file does when Artifacts was never shown.
  const closeAll = () =>
    input.leave(null, () => {
      setTabs([]);
      input.showArtifacts(false, { replace: true });
    });
  const toArtifacts = () => {
    if (!fileId) return;
    input.leave(null, () => input.showArtifacts(true, { replace: true }));
  };

  /** The folder button in the thread header: opens the pane (the last file shown, else Artifacts), or closes it. */
  const toggleDoor = () => {
    if (paneOpen) {
      input.leave(null, () => input.showArtifacts(false));
      return;
    }
    const back = lastCurrent.current && tabsRef.current.includes(lastCurrent.current) ? lastCurrent.current : tabsRef.current[tabsRef.current.length - 1];
    if (back) input.showFile(back);
    else {
      // The panel as the person left it; a thread with nothing but its folder opens on the folder (this visit only).
      if ((input.artifacts?.length ?? 0) === 0 && folder) setTreeForced(true);
      input.showArtifacts(true);
    }
  };

  // Escape beside the thread closes the file on screen, by the tab's own rule (the next tab, else back), once
  // nothing inside the window used the key: a field, a dialog or popover, a menu, a draft that closes itself.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isComposingKey(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (isEditableTarget(target) || inOverlay(target) || modalOpen() || selectionToolbarShowing()) return;
      if (document.querySelector('[role="menu"], [data-comment-popover], [data-pn-annotation-toolbar-row], [data-quick-label-picker]')) return;
      event.preventDefault();
      closeRef.current(current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current]);

  /** `]` / `[` inside the tab on screen: the next file takes this tab's place. */
  const noteStep = (to: string) => {
    stepping.current = { from: fileId, to };
  };

  const treeButton = (
    <Tip content={treeShown ? 'Hide files' : 'Show files'}>
      <button
        type="button"
        className="ib-iconbtn"
        aria-pressed={treeShown}
        aria-label="Files panel"
        onClick={() => {
          setTreeForced(false);
          setTreeOpen(!treeShown);
        }}
        data-files-panel-toggle=""
      >
        <Icon name="panelR" size={17} />
      </button>
    </Tip>
  );

  const tabRow = (tools: { file: ReactNode; view: ReactNode } | null, trailing?: ReactNode) => (
    <FilesTabRow
      artifactsCount={input.artifacts?.length ?? 0}
      artifactsOn={!current}
      onArtifacts={toArtifacts}
      tabs={tabViews}
      current={current}
      onSelect={select}
      onClose={close}
      onCloseOthers={closeOthers}
      onCloseAll={closeAll}
      onPlus={() => {
        setTreeOpen(true);
        setFilterFocus((n) => n + 1);
      }}
      tools={tools?.file ?? null}
      trailing={
        tools ? (
          <>
            {treeButton}
            {tools.view}
          </>
        ) : (
          trailing
        )
      }
    />
  );

  const crumb = (attachment: InboxAttachmentState) => {
    const path = projectFilePath(attachment.id);
    const label = path ?? attachmentLabel(attachment, projectRoot);
    const parts = label.split('/').filter(Boolean);
    const name = parts.pop() ?? attachment.name;
    return (
      <span className="ib-crumbs" data-files-crumbs="">
        {parts.map((part, i) => (
          <span key={i} className="ib-crumb">
            {part}
            <Icon name="chevR" size={12} />
          </span>
        ))}
        <span className="ib-crumb ib-cur" aria-current="page">
          {name}
        </span>
      </span>
    );
  };

  const panel =
    enabled && treeShown ? (
      <FilesPanel
        threadId={threadId}
        artifacts={input.artifacts}
        counts={counts}
        openId={current}
        onOpenArtifact={input.openArtifact}
        onOpenProjectFile={(path) => {
          const id = projectFileId(path);
          const state = projectAttachment(id)!;
          input.openOnPurpose({ id, kind: state.kind, name: state.name });
        }}
        onBlocked={input.onBlocked}
        showChanges={showChanges}
        onShowChanges={setShowChanges}
        noFolder={noFolder}
        active={paneOpen && !shownFull}
        focusFilter={filterFocus}
        onFilterFocused={() => setFilterFocus(0)}
      />
    ) : null;
  // One panel for both panes (the Artifacts tab and a file beside the thread): drawn once into a host element that
  // the pane on screen holds, so switching tabs keeps its open folders, filter and scroll. It stays mounted while no
  // pane holds it (full screen, the pane closed): it refreshes only while on screen.
  const [panelHost] = useState(() => (typeof document === 'undefined' ? null : document.createElement('div')));
  const aside = panel && panelHost ? <PanelSlot host={panelHost} /> : undefined;
  const panelPortal = panel && panelHost ? createPortal(panel, panelHost) : null;

  /** AttachmentPane's `tabs` for the file on screen beside the thread. */
  const paneTabs = (attachment: InboxAttachmentState) =>
    enabled
      ? {
          row: (tools: { file: ReactNode; view: ReactNode } | null) => tabRow(tools),
          // One file open: its tools fold into the tab row.
          fold: tabs.length <= 1,
          crumb: crumb(attachment),
          extra: treeButton,
        }
      : undefined;

  return {
    enabled,
    tabs,
    paneOpen,
    /** The Artifacts tab is on screen beside the thread. */
    artifactsTab: enabled && artifactsRoute && fileId === null,
    projectAttachment,
    source,
    noteStep,
    toggleDoor,
    paneTabs,
    aside,
    /** The panel itself: ThreadPane renders it while a pane holds `aside`. */
    panelPortal,
    artifactsTabRow: tabRow(null, treeButton),
    treeOpen: treeShown,
    /** The thread's project folder: undefined while asked, null when it has none (desktop only). */
    folder,
  };
}

/** Where the files panel shows in a pane: holds the panel's host element while mounted (`display: contents`). */
function PanelSlot({ host }: { host: HTMLElement }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const at = slot.current;
    if (!at) return;
    host.style.display = 'contents';
    at.appendChild(host);
    return () => {
      if (host.parentNode === at) at.removeChild(host);
    };
  }, [host]);
  return <div ref={slot} className="ib-ftree-slot" />;
}
