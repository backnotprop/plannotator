/**
 * The Plannotator Snapshots HUD: the strip (collected snapshots, destination, Send)
 * and the panel (one snapshot large, numbered boxes and comments, View text, Ask
 * this session, the destination picker). One window: the native app resizes
 * it between the two from the `layout` messages this page sends.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { sendSummary } from '@plannotator/shared/snapshots/compose';
import {
  HOST_LABELS,
  connectionLabel,
  textWithoutRemovedLines,
  type ConnectionView,
  type Rect,
  type Snapshot,
  type SnapshotBox,
  type SnapshotsCaptureMode,
  type SnapshotsState,
} from '@plannotator/shared/snapshots/types';
import { useSnapshotsHudShortcuts } from '@plannotator/ui/shortcuts/snapshots/snapshotsHud.shortcuts';
import { api, followState, HubError, token } from './api';
import { deriveSnapshot } from './derive';
import { Icon } from './icons';
import { isNative, postNative, registerNativeCalls, type CapturedEvent } from './native';
import { useSnapshotEdits } from './useSnapshotEdits';
import { AskPane, type AskContext, type AskEntry } from './components/AskPane';
import { Picker } from './components/Picker';
import { Stage, type Tool } from './components/Stage';
import { TextView } from './components/TextView';
import { commentsOn, ThumbImage, useSnapshotImage } from './components/Thumb';
import { AgentMark } from './components/AgentMark';
import { PermissionCard, type PermissionKind, type PermissionState } from './components/PermissionCard';
import { CaptureControl, captureKindFor } from './components/CaptureControl';

type Mode = 'hidden' | 'strip' | 'panel' | 'picker' | 'permission';

const STRIP_THUMBS = 5;
const DELIVERED_LINGER_MS = 2_000;
const CONFIRM_SEND_FROM = 3;

function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

function snapshotTitle(snapshot: Snapshot): { title: string; sub?: string } {
  const where = [snapshot.source?.app, snapshot.source?.windowTitle].filter(Boolean).join(' — ');
  const fallback = snapshot.kind === 'display' ? 'Screen' : snapshot.kind === 'window' ? 'Window' : 'Screen Capture';
  return { title: where || fallback, sub: snapshot.source?.url?.replace(/^https?:\/\//, '') };
}

export function App() {
  const [hub, setHub] = useState<SnapshotsState | null>(null);
  const [online, setOnline] = useState(false);
  const [open, setOpen] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('box');
  const [view, setView] = useState<'image' | 'text'>('image');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingBoxId, setEditingBoxId] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askEntries, setAskEntries] = useState<AskEntry[]>([]);
  const [askContext, setAskContext] = useState<AskContext[]>([]);
  const [picker, setPicker] = useState<null | { reason: 'choose' | 'send' | 'retarget' }>(null);
  const [menu, setMenu] = useState<null | 'send' | 'more'>(null);
  const [sending, setSending] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [toast, setToast] = useState<null | { text: string; action?: { label: string; run: () => void } }>(null);
  const [permissions, setPermissions] = useState({ screen: true, accessibility: true, screenEverGranted: false });
  const [screenOff, setScreenOff] = useState(false);
  const [permission, setPermission] = useState<{ kind: PermissionKind; state: PermissionState } | null>(null);
  const [appIcon, setAppIcon] = useState<string | null>(null);
  const [landing, setLanding] = useState<{ captureId: string; snapshotId: string; first: boolean } | null>(null);
  const [hiddenSend, setHiddenSend] = useState<string | null>(null);
  const [rawTexts, setRawTexts] = useState<Record<string, string | null>>({});
  const [deleteArmed, setDeleteArmed] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const edits = useSnapshotEdits();
  const hudRef = useRef<HTMLDivElement>(null);
  const stageImageRef = useRef<HTMLDivElement>(null);
  const snapshotNoteRef = useRef<HTMLTextAreaElement>(null);
  const thumbRefs = useRef(new Map<string, HTMLElement>());

  // --- Hub state -----------------------------------------------------------------------
  useEffect(() => {
    if (!token) return;
    return followState(
      (state) => {
        setHub(state);
        edits.reconcile([...state.snapshots, ...state.lastSentSnapshots]);
      },
      setOnline,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const collection = hub?.collection ?? null;
  const snapshots = useMemo(() => (hub?.snapshots ?? []).map(edits.merged), [hub?.snapshots, edits.merged]);
  const connections = hub?.connections ?? [];
  const destination = hub?.destination ?? null;
  const index = Math.max(0, snapshots.findIndex((snapshot) => snapshot.id === currentId));
  const current = snapshots[index] ?? null;
  const currentImage = useSnapshotImage(current);

  useEffect(() => {
    if (!current && snapshots.length > 0) setCurrentId(snapshots[0]!.id);
  }, [current, snapshots]);

  // Window text for App Capture, fetched once per snapshot.
  useEffect(() => {
    for (const snapshot of snapshots) {
      if (snapshot.text && !(snapshot.id in rawTexts)) {
        setRawTexts((all) => ({ ...all, [snapshot.id]: null }));
        void api.text(snapshot.id).then((text) => setRawTexts((all) => ({ ...all, [snapshot.id]: text || null })));
      }
    }
  }, [snapshots, rawTexts]);

  // The new-capture control's mode (Screen / App), remembered by the hub. Shown at once on a
  // click, before the hub's state comes back.
  const [chosenMode, setChosenMode] = useState<SnapshotsCaptureMode | null>(null);
  const captureMode: SnapshotsCaptureMode = chosenMode ?? hub?.settings.captureMode ?? 'screen';
  useEffect(() => {
    if (chosenMode && hub?.settings.captureMode === chosenMode) setChosenMode(null);
  }, [chosenMode, hub?.settings.captureMode]);
  const chooseCaptureMode = (mode: SnapshotsCaptureMode) => {
    setChosenMode(mode);
    void api.settings({ captureMode: mode });
  };
  // App Capture asks for Accessibility when it starts (as ⌥⇧⌘5 does), never when chosen.
  const newCapture = () => postNative({ type: 'capture', kind: captureKindFor(captureMode) });

  // Native settings mirror (the menu bar's "App Capture for ⌥⇧⌘4" decides what ⌥⇧⌘4 takes).
  useEffect(() => {
    if (hub) postNative({ type: 'settings', appCapture: hub.settings.appCapture, explainerSeen: hub.settings.explainerSeen });
  }, [hub?.settings.appCapture, hub?.settings.explainerSeen]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- What is on screen -------------------------------------------------------------------
  const lastSent = hub?.lastSent ?? null;
  const delivery = lastSent?.send && lastSent.send.sendId !== hiddenSend ? lastSent.send : null;
  useEffect(() => {
    if (!delivery || (delivery.state !== 'delivered' && delivery.state !== 'copied')) return;
    const timer = setTimeout(() => setHiddenSend(delivery.sendId), DELIVERED_LINGER_MS + 400);
    return () => clearTimeout(timer);
  }, [delivery?.sendId, delivery?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasSnapshots = !!collection && snapshots.length > 0;
  const mode: Mode = permission
    ? 'permission'
    : open && hasSnapshots
      ? 'panel'
      : picker
        ? 'picker'
        : hasSnapshots || delivery || toast || screenOff
          ? 'strip'
          : 'hidden';

  useEffect(() => {
    if (!hasSnapshots) setOpen(false);
  }, [hasSnapshots]);
  useEffect(() => {
    if (permissions.screen) setScreenOff(false);
  }, [permissions.screen]);
  useEffect(() => {
    setConfirmSend(false);
  }, [snapshots.length, destination?.sessionId]);

  // Tell the native window how big to be, and whether to take the keyboard. For the panel
  // this is the default (and smallest) size: the native side keeps the size it was dragged to.
  useLayoutEffect(() => {
    if (!isNative) return;
    const element = hudRef.current?.querySelector(mode === 'permission' ? '.perm' : '.strip') as HTMLElement | null;
    const rect = element?.getBoundingClientRect();
    postNative({
      type: 'layout',
      mode,
      width: mode === 'panel' ? 760 : mode === 'picker' ? 560 : mode === 'permission' ? 460 : Math.ceil(rect?.width ?? 0),
      height: mode === 'panel' ? 540 : mode === 'picker' ? 420 : mode === 'permission' ? Math.ceil(rect?.height ?? 420) : 46,
      // The permission card is clicked, never typed into: the app you were in keeps the keyboard.
      focus: mode === 'panel' || mode === 'picker',
    });
  });

  // --- Native calls -------------------------------------------------------------------------
  const openPanelAt = useCallback((snapshotId?: string | null) => {
    if (snapshotId) setCurrentId(snapshotId);
    setOpen(true);
    setView('image');
  }, []);

  useEffect(
    () =>
      registerNativeCalls({
        captured: (event: CapturedEvent) => {
          setLanding({ captureId: event.captureId, snapshotId: event.snapshotId, first: event.first });
          if (event.first) {
            setTool('box');
            openPanelAt(event.snapshotId);
          }
        },
        toggle: () => setOpen((value) => !value),
        willCapture: () => {
          setEditingBoxId(null);
          setOpen(false);
        },
        permissions: (state) => setPermissions((current) => ({ ...current, ...state })),
        permission: (state) => setPermission(state.state === 'done' ? null : { kind: state.kind as PermissionKind, state: state.state as PermissionState }),
        appIcon: (url) => setAppIcon(url),
        screenRecordingOff: () => {
          setOpen(false);
          setScreenOff(true);
        },
        captureFailed: (reason) => setToast({ text: reason }),
      }),
    [openPanelAt],
  );

  useEffect(() => {
    postNative({ type: 'ready' });
  }, []);

  // The capture flight: once the new snapshot is on screen, say where it lands; the native
  // side flies the cut-out there and then calls flightDone, and the thumbnail appears.
  useEffect(() => {
    if (!landing || !hub?.snapshots.some((snapshot) => snapshot.id === landing.snapshotId)) return;
    const frame = requestAnimationFrame(() => {
      const target = landing.first ? stageImageRef.current : thumbRefs.current.get(landing.snapshotId);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      postNative({ type: 'flightTarget', captureId: landing.captureId, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } });
      if (!isNative) setLanding(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [landing, hub?.snapshots, mode]);

  // A flight that never reports back never keeps a thumbnail hidden.
  useEffect(() => {
    if (!landing) return;
    const timer = setTimeout(() => setLanding((current) => (current === landing ? null : current)), 1500);
    return () => clearTimeout(timer);
  }, [landing]);

  useEffect(() => {
    if (!window.snapshotsHud) return;
    (window.snapshotsHud as unknown as { flightDone: (captureId: string) => void }).flightDone = (captureId: string) => {
      setLanding((current) => (current?.captureId === captureId ? null : current));
      requestAnimationFrame(() => requestAnimationFrame(() => postNative({ type: 'flightLanded', captureId })));
    };
  });

  // --- Editing ----------------------------------------------------------------------------------
  const nextBoxNumber = (snapshot: Snapshot) => snapshot.boxes.reduce((max, box) => Math.max(max, box.n), 0) + 1;

  const createBox = (rect: Rect) => {
    if (!current) return;
    const box: SnapshotBox = { id: crypto.randomUUID(), n: nextBoxNumber(current), rect: rect.map((v) => Math.round(v)) as Rect, comment: '' };
    edits.edit(current, { boxes: [...current.boxes, box] });
    setSelectedId(box.id);
    setEditingBoxId(box.id);
  };

  const commentBox = (box: SnapshotBox, comment: string) => {
    if (!current) return;
    edits.edit(current, { boxes: current.boxes.map((b) => (b.id === box.id ? { ...b, comment } : b)) }, false);
    setEditingBoxId(null);
  };

  const cancelComment = (box: SnapshotBox) => {
    if (!current) return;
    // A new box that was never given a comment goes away with Esc.
    if (!box.comment.trim()) {
      edits.edit(current, { boxes: current.boxes.filter((b) => b.id !== box.id) }, false);
      setSelectedId(null);
    }
    setEditingBoxId(null);
  };

  const deleteSelected = () => {
    if (!current) return;
    if (selectedId && current.boxes.some((b) => b.id === selectedId)) {
      edits.edit(current, { boxes: current.boxes.filter((b) => b.id !== selectedId) });
      setSelectedId(null);
      setEditingBoxId(null);
      return;
    }
    if (selectedId && current.redactions.some((r) => r.id === selectedId)) {
      edits.edit(current, { redactions: current.redactions.filter((r) => r.id !== selectedId) });
      setSelectedId(null);
      return;
    }
    // The snapshot itself: one press, or two when it has comments.
    if (commentsOn(current) > 0 && deleteArmed !== current.id) {
      setDeleteArmed(current.id);
      setToast({ text: `Snapshot ${index + 1} has ${commentsOn(current)} comment${commentsOn(current) === 1 ? '' : 's'}. Press ⌫ again to delete it.` });
      return;
    }
    setDeleteArmed(null);
    setToast(null);
    const next = snapshots[index + 1] ?? snapshots[index - 1] ?? null;
    setCurrentId(next?.id ?? null);
    void api.deleteSnapshot(current.id);
  };

  const go = (delta: number) => {
    const next = snapshots[index + delta];
    if (!next) return;
    setCurrentId(next.id);
    setSelectedId(null);
    setEditingBoxId(null);
    if (view === 'text' && !next.text) setView('image');
  };

  const askAbout = (box?: SnapshotBox) => {
    if (!current) return;
    const context: AskContext = { snapshotId: current.id, snapshotIndex: index + 1, ...(box ? { boxId: box.id, boxN: box.n } : {}) };
    setAskContext([context]);
    setAskOpen(true);
  };

  const prepareSnapshots = useCallback(
    async (ids: string[]) => {
      await edits.flush();
      const fresh = await api.state();
      for (const snapshot of fresh.snapshots.filter((s) => ids.includes(s.id))) await deriveSnapshot(snapshot);
    },
    [edits],
  );

  // --- Sending ---------------------------------------------------------------------------------
  const liveDestination = destination?.live ? destination : null;
  const isAuto = !!destination && destination.reason !== 'chosen' && destination.reason !== 'summoned';
  const summary = useMemo(
    () =>
      sendSummary(snapshots, (snapshot) => {
        if (!snapshot.text?.include) return null;
        const raw = rawTexts[snapshot.id];
        return raw ? textWithoutRemovedLines(raw, snapshot.text.removedLines).length : snapshot.text.chars;
      }),
    [snapshots, rawTexts],
  );

  const copyMarkdown = async () => {
    if (!collection) return;
    setMenu(null);
    setPicker(null);
    try {
      await prepareSnapshots(collection.snapshots);
      const { text, files } = await api.copy(collection.id);
      if (isNative) postNative({ type: 'clipboard', text, files });
      else await navigator.clipboard.writeText(text).catch(() => undefined);
      setOpen(false);
    } catch (error) {
      setToast({ text: error instanceof Error ? error.message : String(error) });
    }
  };

  const copyImages = async () => {
    if (!collection) return;
    setMenu(null);
    await prepareSnapshots(collection.snapshots);
    const { files } = await api.markdown(collection.id);
    if (isNative) postNative({ type: 'clipboard', files });
    setToast({ text: isNative ? `Copied ${files.length} image${files.length === 1 ? '' : 's'}.` : 'Copying images needs the native app; use Reveal in Finder.' });
  };

  const reveal = async () => {
    if (!collection) return;
    setMenu(null);
    await prepareSnapshots(collection.snapshots);
    await api.reveal(collection.id);
  };

  const send = async (to?: ConnectionView) => {
    if (!collection || sending) return;
    const target = to ?? liveDestination;
    if (!target) {
      if (connections.length === 0) setMenu('send');
      else setPicker({ reason: 'send' });
      return;
    }
    if (!to && snapshots.length >= CONFIRM_SEND_FROM && !confirmSend) {
      setConfirmSend(true);
      return;
    }
    setSending(true);
    setConfirmSend(false);
    setEditingBoxId(null);
    try {
      await prepareSnapshots(collection.snapshots);
      await api.send(collection.id, { host: target.host, sessionId: target.sessionId });
      setOpen(false);
      setAskEntries([]);
      setAskOpen(false);
    } catch (error) {
      setToast({ text: error instanceof HubError ? error.message : `Could not send: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setSending(false);
    }
  };

  const pick = async (connection: ConnectionView) => {
    const reason = picker?.reason;
    setPicker(null);
    if (reason === 'retarget' && lastSent) {
      await api.retarget(lastSent.id, { host: connection.host, sessionId: connection.sessionId });
      return;
    }
    if (collection) await api.updateCollection(collection.id, { destination: { host: connection.host, sessionId: connection.sessionId } });
    if (reason === 'send') void send(connection);
  };

  const discard = async () => {
    if (!collection) return;
    setMenu(null);
    const id = collection.id;
    await api.discard(id);
    setOpen(false);
    setToast({ text: `Discarded ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}.`, action: { label: 'Undo', run: () => void api.restore(id) } });
  };

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.action ? 10_000 : 4_000);
    return () => clearTimeout(timer);
  }, [toast]);

  // --- Keys ------------------------------------------------------------------------------------
  const panelKeys = mode === 'panel';
  const notTyping = (event: KeyboardEvent) => panelKeys && !picker && !isTyping(event);
  useSnapshotsHudShortcuts({
    handlers: {
      boxTool: { when: notTyping, handle: () => setTool('box') },
      arrowTool: { when: notTyping, handle: () => setTool('arrow') },
      drawTool: { when: notTyping, handle: () => setTool('pen') },
      redactTool: { when: notTyping, handle: () => setTool('redact') },
      noteTool: {
        when: (e) => notTyping(e) && view === 'image',
        handle: () => {
          setEditingBoxId(null);
          snapshotNoteRef.current?.focus();
        },
      },
      viewText: { when: (e) => notTyping(e) && !!current?.text, handle: () => setView((v) => (v === 'text' ? 'image' : 'text')) },
      previousSnapshot: { when: (e) => notTyping(e) && view === 'image', handle: () => go(-1) },
      nextSnapshot: { when: (e) => notTyping(e) && view === 'image', handle: () => go(1) },
      deleteSelection: { when: (e) => notTyping(e) && view === 'image', handle: deleteSelected },
      undo: { when: notTyping, handle: () => current && edits.undo(current) },
      redo: { when: notTyping, handle: () => current && edits.redo(current) },
      chooseDestination: { when: () => panelKeys, handle: () => setPicker({ reason: 'choose' }) },
      ask: { when: () => panelKeys, handle: () => (askOpen ? setAskOpen(false) : askAbout(current?.boxes.find((b) => b.id === selectedId))) },
      send: { when: () => panelKeys && !picker, handle: () => void send() },
      copyMarkdown: { when: () => panelKeys, handle: () => void copyMarkdown() },
      back: {
        when: () => panelKeys && !picker,
        handle: () => {
          if (menu) setMenu(null);
          else if (askOpen) setAskOpen(false);
          else if (view === 'text') setView('image');
          else if (confirmSend) setConfirmSend(false);
          else setOpen(false);
        },
      },
    },
  });

  // --- Render ------------------------------------------------------------------------------------
  if (!token) {
    return (
      <div className="hud">
        <div className="strip glass">
          <span className="state muted" style={{ padding: '0 12px' }}>
            Plannotator Snapshots: open this page from the app or with `plannotator snapshot open`.
          </span>
        </div>
      </div>
    );
  }

  // Who it goes to: the agent's mark and the project. "Auto" stays visible: a guess must look like a guess.
  const destinationName = destination ? connectionLabel(destination) : 'No session';
  const chip = (
    <button
      type="button"
      className={`chip${!destination ? ' choose' : ''}${destination && !destination.live ? ' gone' : ''}`}
      onClick={() => setPicker({ reason: 'choose' })}
      title="Where it goes (⌘K)"
      aria-label={destination ? `Send to ${destinationName}${isAuto ? ', chosen automatically' : ''}. Change` : 'Choose where it goes'}
    >
      {destination ? (
        <>
          <AgentMark host={destination.host} title={destination.title} />
          <span className="chip-name">{destination.project || HOST_LABELS[destination.host]}</span>
          {isAuto && <span className="auto">Auto</span>}
        </>
      ) : (
        <span>{connections.length === 0 ? 'No session' : 'Choose…'}</span>
      )}
    </button>
  );

  const sendButton = (
    <button type="button" className={`send${confirmSend ? ' confirm' : ''}`} disabled={sending} onClick={() => void send()} aria-label={confirmSend ? 'Send now' : 'Send'}>
      {sending ? <span className="spin" /> : <Icon name="up" size={14} />}
      {confirmSend ? 'Send now' : 'Send'}
    </button>
  );

  const noSession = connections.length === 0;

  return (
    <div ref={hudRef} className="hud-root" data-mode={mode}>
      {mode === 'permission' && permission && (
        <div className="hud perm-host">
          <PermissionCard
            kind={permission.kind}
            state={permission.state}
            appIcon={appIcon}
            onRequest={() => postNative({ type: 'permission.request' })}
            onReopen={() => postNative({ type: 'permission.reopen' })}
            onDecline={() => postNative({ type: 'permission.decline' })}
            onClose={() => {
              setPermission(null);
              postNative({ type: 'permission.cancel' });
            }}
          />
        </div>
      )}
      {mode === 'picker' && picker && (
        <div className="hud picker-host">
          <Picker
            connections={connections}
            current={destination}
            title={picker.reason === 'retarget' ? 'Send elsewhere' : 'Send to'}
            onPick={(connection) => void pick(connection)}
            onCopy={() => void copyMarkdown()}
            onClose={() => setPicker(null)}
          />
        </div>
      )}
      {mode === 'strip' && (
        <div className="hud" ref={undefined}>
          <StripView
            hasSnapshots={hasSnapshots}
            snapshots={snapshots}
            lastSentSnapshots={hub?.lastSentSnapshots ?? []}
            delivery={delivery}
            screenOff={screenOff}
            landingSnapshotId={landing && !landing.first ? landing.snapshotId : null}
            thumbRefs={thumbRefs}
            captureMode={captureMode}
            noSession={noSession}
            online={online}
            chip={chip}
            sendButton={sendButton}
            onOpen={(snapshotId) => openPanelAt(snapshotId ?? snapshots.find((s) => commentsOn(s) === 0)?.id ?? snapshots[0]?.id)}
            onCaptureMode={chooseCaptureMode}
            onCapture={newCapture}
            onCopy={() => void copyMarkdown()}
            onReveal={() => void reveal()}
            onRetarget={() => setPicker({ reason: 'retarget' })}
            onSendAnyway={() => lastSent?.send?.successorSessionId && lastSent.send.host && void api.retarget(lastSent.id, { host: lastSent.send.host, sessionId: lastSent.send.successorSessionId })}
            onCopySent={async () => {
              if (!lastSent) return;
              const { text } = await api.markdown(lastSent.id);
              if (isNative) postNative({ type: 'clipboard', text });
              else await navigator.clipboard.writeText(text).catch(() => undefined);
              setHiddenSend(lastSent.send?.sendId ?? null);
            }}
            onOpenSettings={() => postNative({ type: 'permission.begin', kind: 'screen' })}
            toast={toast}
            onToastAction={() => {
              toast?.action?.run();
              setToast(null);
            }}
          />
        </div>
      )}
      {mode === 'panel' && (
        <div className="hud panel glass" role="dialog" aria-label={current ? `Snapshot ${index + 1} of ${snapshots.length}` : 'Plannotator Snapshots'}>
          {isNative && (
            // The native window runs the drag (Panel.swift, PanelResizer); this only draws the
            // corner's mark and gives WebKit the same cursors, so the two never disagree.
            <div className="resize" aria-hidden="true" title="Drag to resize · double-click for the default size">
              <span className="resize-top" />
              <span className="resize-left" />
              <span className="resize-corner">
                <svg viewBox="0 0 10 10" width="10" height="10">
                  <path d="M1.5 9V6.5a5 5 0 0 1 5-5H9" />
                </svg>
              </span>
            </div>
          )}
          <div className="p-head">
            <div className="nav-btns">
              <button type="button" aria-label="Previous snapshot (←)" disabled={index <= 0} onClick={() => go(-1)}>
                <Icon name="left" />
              </button>
              <button type="button" aria-label="Next snapshot (→)" disabled={index >= snapshots.length - 1} onClick={() => go(1)}>
                <Icon name="right" />
              </button>
            </div>
            <div className="p-title">
              {current ? snapshotTitle(current).title : ''}
              {current && view === 'image' && snapshotTitle(current).sub && <small>{snapshotTitle(current).sub}</small>}
            </div>
            {current?.text && (
              <div className="seg" role="group" aria-label="View">
                <button type="button" className={view === 'image' ? 'on' : ''} onClick={() => setView('image')} aria-label="Image" title="Image">
                  <Icon name="image" size={14} />
                </button>
                <button type="button" className={view === 'text' ? 'on' : ''} onClick={() => setView('text')} aria-label="Window text (T)" title="Window text (T)">
                  <Icon name="text" size={14} />
                </button>
              </div>
            )}
            <button
              type="button"
              className={`hbtn${askOpen ? ' on' : ''}`}
              aria-label="Ask this session (⌘J)"
              title="Ask this session (⌘J)"
              aria-pressed={askOpen}
              onClick={() => (askOpen ? setAskOpen(false) : askAbout(current?.boxes.find((b) => b.id === selectedId)))}
            >
              <Icon name="ask" />
            </button>
            <div style={{ position: 'relative' }}>
              <button type="button" className="hbtn" aria-label="More" onClick={() => setMenu(menu === 'more' ? null : 'more')}>
                <Icon name="more" />
              </button>
              {menu === 'more' && (
                <div className="menu glass" style={{ top: 30, bottom: 'auto' }} role="menu">
                  <button type="button" role="menuitem" onClick={() => void copyMarkdown()}>
                    Copy as Markdown
                  </button>
                  <button type="button" role="menuitem" onClick={() => void reveal()}>
                    Reveal in Finder
                  </button>
                  <button type="button" role="menuitem" onClick={() => void discard()}>
                    Discard {snapshots.length} snapshot{snapshots.length === 1 ? '' : 's'}
                  </button>
                </div>
              )}
            </div>
            <button type="button" className="hbtn" aria-label="Collapse to the strip (Esc)" onClick={() => setOpen(false)}>
              <Icon name="collapse" />
            </button>
          </div>
          <div className={`p-body${view === 'text' ? ' wide' : ''}`}>
            {view === 'image' && (
              <div className="rail" role="toolbar" aria-label="Tools">
                {(
                  [
                    ['box', 'box', 'R', 'Box'],
                    ['arrow', 'arrow', 'A', 'Arrow'],
                    ['pen', 'pen', 'D', 'Draw'],
                    ['redact', 'redact', 'B', 'Redact'],
                  ] as const
                ).map(([id, icon, key, label]) => (
                  <button
                    type="button"
                    key={id}
                    className={`tool${tool === id ? ' on' : ''}`}
                    aria-label={`${label} (${key})`}
                    aria-pressed={tool === id}
                    title={`${label} (${key})`}
                    onClick={() => setTool(id)}
                  >
                    <Icon name={icon} />
                  </button>
                ))}
                <button
                  type="button"
                  className="tool"
                  aria-label="Note on this image (N)"
                  title="Note on this image (N)"
                  onClick={() => {
                    setEditingBoxId(null);
                    snapshotNoteRef.current?.focus();
                  }}
                >
                  <Icon name="note" />
                </button>
              </div>
            )}
            {current && view === 'image' && (
              <Stage
                snapshot={current}
                imageUrl={landing?.first && landing.snapshotId === current.id && isNative ? null : currentImage}
                imageRef={stageImageRef}
                tool={tool}
                selectedId={selectedId}
                editingBoxId={editingBoxId}
                noteRef={snapshotNoteRef}
                reserveRight={askOpen ? 420 : 0}
                onSelect={setSelectedId}
                onCreateBox={createBox}
                onEditBox={setEditingBoxId}
                onComment={commentBox}
                onCancelComment={cancelComment}
                onAddStroke={(stroke) => edits.edit(current, { strokes: [...current.strokes, stroke] })}
                onAddRedaction={(rect) => edits.edit(current, { redactions: [...current.redactions, { id: crypto.randomUUID(), rect: rect.map((v) => Math.round(v)) as Rect }] })}
                onNote={(note) => edits.edit(current, { note }, false)}
                onAskAbout={(box) => askAbout(box)}
              />
            )}
            {current && view === 'text' && (
              <div className="stage" style={{ background: 'transparent' }}>
                <TextView
                  snapshot={current}
                  text={rawTexts[current.id] ?? null}
                  onRemoveLines={(lines) => edits.edit(current, { text: { removedLines: [...new Set([...(current.text?.removedLines ?? []), ...lines])].sort((a, b) => a - b) } }, false)}
                  onRestoreLines={(lines) => edits.edit(current, { text: { removedLines: (current.text?.removedLines ?? []).filter((n) => !lines.includes(n)) } }, false)}
                  onInclude={(include) => edits.edit(current, { text: { include } }, false)}
                  onTurnOnAccessibility={() => postNative({ type: 'permission.begin', kind: 'accessibility' })}
                />
              </div>
            )}
            {askOpen && (
              <AskPane
                entries={askEntries}
                setEntries={setAskEntries}
                context={askContext}
                setContext={setAskContext}
                destination={liveDestination}
                snapshots={snapshots}
                prepare={prepareSnapshots}
                onClose={() => setAskOpen(false)}
              />
            )}
            {!current && <div className="empty-stage" />}
          </div>
          <div className="p-foot">
            <div>
              <div className="film" role="list" aria-label="Snapshots">
                {snapshots.map((snapshot, i) => {
                  const count = commentsOn(snapshot);
                  return (
                    <button
                      type="button"
                      role="listitem"
                      key={snapshot.id}
                      className={`fm${snapshot.id === current?.id ? ' cur' : ''}`}
                      aria-label={`Snapshot ${i + 1}${count ? `, ${count} comment${count === 1 ? '' : 's'}` : ', no comments'}`}
                      onClick={() => {
                        setCurrentId(snapshot.id);
                        setSelectedId(null);
                        setEditingBoxId(null);
                        if (view === 'text' && !snapshot.text) setView('image');
                      }}
                    >
                      <ThumbImage snapshot={snapshot} />
                      <span className="n">{i + 1}</span>
                      {snapshot.text && <span className="app">T</span>}
                      {count > 0 && <span className="badge">{count}</span>}
                    </button>
                  );
                })}
                <CaptureControl mode={captureMode} onMode={chooseCaptureMode} onCapture={newCapture} />
              </div>
              <div className="note">
                <input
                  value={noteDraft ?? collection?.note ?? ''}
                  placeholder="Note for this send"
                  aria-label="Note for this send"
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onBlur={() => {
                    if (collection && noteDraft !== null) void api.updateCollection(collection.id, { note: noteDraft });
                    setNoteDraft(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                />
              </div>
            </div>
            <div className="foot-r">
              {confirmSend && liveDestination && (
                <span className="sum confirm" role="status">
                  {summary} → {liveDestination.project || HOST_LABELS[liveDestination.host]} · ⌘↩
                </span>
              )}
              <span className="go">
                {chip}
                {noSession ? (
                  <button type="button" className="send" onClick={() => setMenu(menu === 'send' ? null : 'send')} aria-haspopup="menu">
                    Send ▾
                  </button>
                ) : (
                  sendButton
                )}
              </span>
              {menu === 'send' && (
                <div className="menu glass" role="menu">
                  <button type="button" role="menuitem" onClick={() => void copyMarkdown()}>
                    Copy as Markdown
                  </button>
                  <button type="button" role="menuitem" onClick={() => void copyImages()}>
                    Copy images
                  </button>
                  <button type="button" role="menuitem" onClick={() => void reveal()}>
                    Reveal in Finder
                  </button>
                  <div className="menu-note">Run /plannotator-snapshot in your agent to receive snapshots.</div>
                </div>
              )}
            </div>
          </div>
          {picker && (
            <Picker
              connections={connections}
              current={destination}
              title={picker.reason === 'retarget' ? 'Send elsewhere' : 'Send to'}
              onPick={(connection) => void pick(connection)}
              onCopy={() => void copyMarkdown()}
              onClose={() => setPicker(null)}
            />
          )}
          {toast && (
            <div className="toast glass" role="status">
              {toast.text}
              {toast.action && (
                <button
                  type="button"
                  className="mini-link"
                  onClick={() => {
                    toast.action!.run();
                    setToast(null);
                  }}
                >
                  {toast.action.label}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {hasSnapshots ? `${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}${destination ? `, sending to ${HOST_LABELS[destination.host]}, ${destination.project}` : ''}.` : ''}
      </div>
    </div>
  );
}

function StripView(props: {
  hasSnapshots: boolean;
  snapshots: Snapshot[];
  lastSentSnapshots: Snapshot[];
  delivery: SnapshotsState['lastSent'] extends infer C ? (C extends { send?: infer S } ? S | null : null) : null;
  screenOff: boolean;
  landingSnapshotId: string | null;
  thumbRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  captureMode: SnapshotsCaptureMode;
  noSession: boolean;
  online: boolean;
  chip: React.ReactNode;
  sendButton: React.ReactNode;
  onOpen: (snapshotId?: string) => void;
  onCaptureMode: (mode: SnapshotsCaptureMode) => void;
  onCapture: () => void;
  onCopy: () => void;
  onReveal: () => void;
  onRetarget: () => void;
  onSendAnyway: () => void;
  onCopySent: () => void;
  onOpenSettings: () => void;
  toast: { text: string; action?: { label: string } } | null;
  onToastAction: () => void;
}) {
  const { snapshots, delivery } = props;
  if (props.toast && !props.hasSnapshots) {
    return (
      <div className="strip glass" role="status" style={{ paddingRight: 12 }}>
        <span className="state">{props.toast.text}</span>
        {props.toast.action && (
          <button type="button" className="mini-link" onClick={props.onToastAction}>
            {props.toast.action.label}
          </button>
        )}
      </div>
    );
  }
  if (props.screenOff) {
    return (
      <div className="strip glass" role="status">
        <span className="state">
          <Icon name="warn" className="ico" style={{ color: 'var(--warn)' }} />
          Screen Recording is off
        </span>
        <button type="button" className="send" style={{ height: 30 }} onClick={props.onOpenSettings}>
          Turn On
        </button>
      </div>
    );
  }
  if (!props.hasSnapshots && delivery) {
    const thumbs = props.lastSentSnapshots.slice(-4);
    const label = delivery.label;
    const project = label.includes(' · ') ? label.slice(label.indexOf(' · ') + 3) : label;
    const who = delivery.host ? (
      <span className="who-chip">
        <AgentMark host={delivery.host} size={16} />
        {project}
      </span>
    ) : null;
    return (
      <div className={`strip glass${delivery.state === 'delivered' || delivery.state === 'copied' ? ' fade-out' : ''}`} role="status" style={{ paddingRight: 12 }}>
        {thumbs.length > 0 && (
          <div className="thumbs">
            {thumbs.map((snapshot) => (
              <div className="th" key={snapshot.id}>
                <ThumbImage snapshot={snapshot} />
              </div>
            ))}
          </div>
        )}
        {delivery.state === 'delivered' && (
          <span className="state" aria-label={`Sent to ${label}`}>
            <Icon name="check" className="ico ok" />
            Sent{who}
          </span>
        )}
        {delivery.state === 'copied' && (
          <span className="state">
            <Icon name="check" className="ico ok" />
            Copied
          </span>
        )}
        {delivery.state === 'pending' && (
          <span className="state">
            <span className="spin" />
            Sending{who}
          </span>
        )}
        {delivery.state === 'queued' && (
          <span className="state" title="The session is busy; it reads this next." aria-label={`Queued: ${label} is busy and reads this next`}>
            <Icon name="clock" className="ico warn" />
            Queued{who}
          </span>
        )}
        {delivery.state === 'ended' && (
          <>
            <span className="state">
              <Icon name="warn" className="ico bad" />
              Session ended
            </span>
            <button type="button" className="mini-link" onClick={props.onRetarget}>
              Send elsewhere…
            </button>
            <button type="button" className="mini-link" onClick={props.onCopySent}>
              Copy
            </button>
          </>
        )}
        {delivery.state === 'cleared' && (
          <>
            <span className="state">
              <Icon name="warn" className="ico warn" />
              {label} was cleared.
            </span>
            <button type="button" className="mini-link" onClick={props.onSendAnyway}>
              Send there anyway
            </button>
            <button type="button" className="mini-link" onClick={props.onRetarget}>
              Choose another
            </button>
          </>
        )}
      </div>
    );
  }
  const visible = snapshots.slice(-STRIP_THUMBS);
  const older = snapshots.length - visible.length;
  return (
    <div
      className="strip glass"
      role="group"
      aria-label={`Plannotator Snapshots: ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        props.onOpen();
      }}
    >
      <div className="thumbs">
        {older > 0 && <span className="more">+{older}</span>}
        {visible.map((snapshot) => {
          const count = commentsOn(snapshot);
          return (
            <button
              type="button"
              key={snapshot.id}
              ref={(element) => {
                if (element) props.thumbRefs.current.set(snapshot.id, element);
                else props.thumbRefs.current.delete(snapshot.id);
              }}
              className={`th${props.landingSnapshotId === snapshot.id ? ' landing' : ''}${props.landingSnapshotId === null ? '' : ''}`}
              aria-label={`Open snapshot ${snapshots.indexOf(snapshot) + 1}`}
              onClick={() => props.onOpen(snapshot.id)}
            >
              <ThumbImage snapshot={snapshot} />
              {snapshot.text && <span className="app">T</span>}
              {count > 0 && <span className="badge">{count}</span>}
            </button>
          );
        })}
      </div>
      <span className="count">{snapshots.length}</span>
      <span className="sep" />
      <CaptureControl mode={props.captureMode} onMode={props.onCaptureMode} onCapture={props.onCapture} />
      {props.noSession ? (
        <>
          <span className="chip">No session</span>
          <button type="button" className="mini-link" onClick={props.onCopy}>
            Copy as Markdown
          </button>
          <button type="button" className="mini-link" onClick={props.onReveal}>
            Reveal in Finder
          </button>
        </>
      ) : (
        <>
          {props.chip}
          {props.sendButton}
        </>
      )}
      {!props.online && <span className="muted" title="Reconnecting to the hub">·</span>}
    </div>
  );
}
