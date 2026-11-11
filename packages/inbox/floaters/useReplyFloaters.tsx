import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import type { InboxReplyDraftRow } from '@plannotator/core/inbox-types';
import type { ReplyDraftFileRef } from '@plannotator/core/inbox-reply-draft';
import { ChatWindowStore } from '@plannotator/ui/components/chat';
import { AuthorMark } from '../icons';
import { inboxApi } from '../api';
import { AskSparkle } from '../ask/AskChatMenu';
import type { AskCorner } from '../ask/useInboxAsk';
import type { InboxToastModel } from '../components/Toast';
import { Icon } from '../icons';
import { machineOf } from '../inboxUrl';
import { FloaterBox } from './FloaterBox';
import { floatingDrafts, floatsAfterVisit, floatThread, floaterName, onFloaterEvent, onReplyBoxSetAside, staleFloats, unfloatThread, useFloatEntries } from './model';

export interface ReplyFloatersOptions {
  rows: readonly InboxReplyDraftRow[];
  rowsRead: boolean;
  threadId: string | null;
  phone: boolean;
  off: boolean;
  floatDrafts: boolean | null;
  ask: AskCorner;
  openThread: (threadId: string) => void;
  openDrafts: () => void;
  refreshDrafts: () => void | Promise<void>;
  toast: (toast: Omit<InboxToastModel, 'id'>) => void;
  dismissToast: () => void;
}

const TILE = 44;
const SETTLE_WINDOW_MS = 5_000;

interface CornerItem {
  key: string;
  kind: 'ask' | 'draft';
  mark: ReactNode;
  name: string;
  label: string;
  onOpen: () => void;
  onPutAway?: () => void;
}

function draftMark(row: InboxReplyDraftRow) {
  return (
    <span className="ib-rf-mark">
      <AuthorMark author={row.author} />
      {row.unseen > 0 && <span className="ib-rf-markdot" aria-hidden="true" />}
    </span>
  );
}

export function useReplyFloaters(options: ReplyFloatersOptions): { layer: ReactNode } {
  const { rows, rowsRead, threadId, phone, off, floatDrafts, ask, openThread, openDrafts, refreshDrafts, toast, dismissToast } = options;
  const floats = !off && floatDrafts === true;
  const entries = useFloatEntries();
  const [openId, setOpenId] = useState<string | null>(null);
  const [wantsFocus, setWantsFocus] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const room = useCornerRoom(!off, phone);
  useSyncExternalStore(ask.store.subscribe, ask.store.getVersion);
  const askMinimized = ask.store.minimized;
  const askOpen = ask.threadId !== null && !askMinimized;
  const frame = useMemo(() => new ChatWindowStore(), []);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const refresh = useRef(refreshDrafts);
  refresh.current = refreshDrafts;
  const rowsNow = useRef({ rows, read: rowsRead });
  rowsNow.current = { rows, read: rowsRead };

  const visit = useRef<{ id: string; updated: string | null | undefined } | null>(null);
  const settling = useRef(new Map<string, { updated: string | null | undefined; until: number }>());
  const settleTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const look = useCallback((id: string) => {
    const was = settling.current.get(id);
    if (!was) return;
    void inboxApi.replyDraft(id).then(
      ({ draft }) => {
        if (settling.current.get(id) !== was) return;
        if (floatsAfterVisit(was.updated, draft)) {
          settling.current.delete(id);
          floatThread(id);
          void refresh.current();
        } else if (Date.now() > was.until) settling.current.delete(id);
      },
      () => {},
    );
  }, []);
  const settle = useCallback(
    (id: string, updated: string | null | undefined, wait: number) => {
      settling.current.set(id, { updated, until: Date.now() + SETTLE_WINDOW_MS });
      const timer = setTimeout(() => {
        settleTimers.current.delete(timer);
        look(id);
      }, wait);
      settleTimers.current.add(timer);
    },
    [look],
  );
  useEffect(() => {
    if (!floats) return;
    const timers = settleTimers.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      settling.current.clear();
    };
  }, [floats]);
  useEffect(() => {
    if (!floats) return;
    return onFloaterEvent((kind, changed) => {
      if (kind === 'draft' && changed && settling.current.has(changed)) look(changed);
    });
  }, [floats, look]);
  useEffect(() => {
    if (!floats) {
      visit.current = null;
      return;
    }
    const left = visit.current;
    visit.current = null;
    if (threadId && !machineOf(threadId)) {
      const known = rowsNow.current.read ? (rowsNow.current.rows.find((row) => row.thread_id === threadId)?.unsent?.reply_at ?? null) : undefined;
      visit.current = { id: threadId, updated: known };
      settling.current.delete(threadId);
      setOpenId((id) => (id === threadId ? null : id));
    }
    if (left && left.id !== threadId) settle(left.id, left.updated, 350);
  }, [threadId, floats, settle]);
  useEffect(() => {
    if (!floats) return;
    return onReplyBoxSetAside((id) => {
      const here = visit.current;
      if (here?.id === id) settle(id, here.updated, 450);
    });
  }, [floats, settle]);

  useEffect(() => {
    if (off || floatDrafts !== false) return;
    setOpenId(null);
    for (const entry of entries) unfloatThread(entry.id);
  }, [off, floatDrafts, entries]);

  useEffect(() => {
    if (!floats || !rowsRead) return;
    for (const id of staleFloats(entries, rows, openId ? [openId] : [], Date.now())) unfloatThread(id);
  }, [floats, rowsRead, entries, rows, openId]);

  const drafts = useMemo(() => (floats ? floatingDrafts(entries, rows, threadId) : []), [floats, entries, rows, threadId]);

  const focusLauncher = useCallback(() => {
    requestAnimationFrame(() => {
      const target = layerRef.current?.querySelector<HTMLElement>('[data-rf-launcher]') ?? document.querySelector<HTMLElement>('section.ib-pane .ib-subject');
      target?.focus({ preventScroll: true });
    });
  }, []);

  const placeWindow = useCallback(() => {
    if (ask.threadId !== null && !ask.store.minimized && !ask.store.fullscreen) {
      const at = ask.store.geometry();
      frame.setWindowOffsets(at.right + at.w + 12, at.bottom);
    } else frame.setWindowOffsets(16, 16);
  }, [ask.threadId, ask.store, frame]);

  const openBox = useCallback(
    (id: string) => {
      setMenu(false);
      setWantsFocus(id);
      if (phone) ask.minimize();
      else placeWindow();
      setOpenId(id);
    },
    [phone, placeWindow, ask],
  );
  const wasAskOpen = useRef(askOpen);
  useEffect(() => {
    const opened = askOpen && !wasAskOpen.current;
    wasAskOpen.current = askOpen;
    if (!opened || openId === null) return;
    if (phone) setOpenId(null);
    else {
      const a = ask.store.geometry();
      const d = frame.geometry();
      const overlaps = d.right < a.right + a.w && d.right + d.w > a.right;
      if (overlaps) frame.setWindowOffsets(a.right + a.w + 12, d.bottom);
    }
  }, [askOpen, openId, phone, ask.store, frame]);

  const minimize = useCallback(
    (id: string) => {
      setOpenId((open) => (open === id ? null : open));
      focusLauncher();
    },
    [focusLauncher],
  );
  const putAway = useCallback(
    (id: string) => {
      setOpenId((open) => (open === id ? null : open));
      unfloatThread(id);
      toast({
        icon: 'check',
        lead: 'Stays in Drafts',
        speech: 'It stopped floating. The reply stays in Drafts.',
        action: {
          label: 'Drafts',
          onPress: () => {
            dismissToast();
            openDrafts();
          },
        },
      });
      focusLauncher();
    },
    [dismissToast, focusLauncher, openDrafts, toast],
  );
  const toThread = useCallback(
    (id: string) => {
      setOpenId(null);
      setMenu(false);
      openThread(id);
    },
    [openThread],
  );
  const sent = useCallback(
    (row: InboxReplyDraftRow, agent: string) => {
      setOpenId(null);
      unfloatThread(row.thread_id);
      void refresh.current();
      toast({
        icon: 'check',
        lead: `Sent to ${agent}`,
        detail: `in ${row.project.name}`,
        speech: `Sent to ${agent} in ${row.project.name}.`,
        action: {
          label: 'Open',
          onPress: () => {
            dismissToast();
            openThread(row.thread_id);
          },
        },
      });
      focusLauncher();
    },
    [dismissToast, focusLauncher, openThread, toast],
  );
  const discarded = useCallback(
    (row: InboxReplyDraftRow, words: string, files: readonly ReplyDraftFileRef[]) => {
      setOpenId(null);
      unfloatThread(row.thread_id);
      void refresh.current();
      toast({
        icon: 'check',
        lead: 'Reply discarded',
        onUndo: () => {
          dismissToast();
          const add = [...files];
          const place = add.flatMap((file) => (file.pasted ? [{ upload_id: file.upload_id, pasted: file.pasted }] : []));
          void inboxApi
            .saveReplyDraft(row.thread_id, words, null, null, { add, remove: [], place })
            .then(() => {
              floatThread(row.thread_id);
              return refresh.current();
            })
            .catch(() => toast({ icon: 'warn', lead: 'The reply could not be restored.', wrap: true }));
        },
      });
      focusLauncher();
    },
    [dismissToast, focusLauncher, toast],
  );
  const gone = useCallback((id: string) => {
    setOpenId((open) => (open === id ? null : open));
    unfloatThread(id);
    void refresh.current();
  }, []);

  const openedRow = useRef<InboxReplyDraftRow | null>(null);
  const listed = openId !== null ? (rows.find((each) => each.thread_id === openId) ?? null) : null;
  if (listed) openedRow.current = listed;
  else if (openedRow.current?.thread_id !== openId) openedRow.current = null;
  const openRow = floats && openId !== null && openId !== threadId ? (listed ?? openedRow.current) : null;
  const orphan = openId !== null && openId !== threadId && openRow === null;
  useEffect(() => {
    if (orphan) setOpenId(null);
  }, [orphan]);
  const items: CornerItem[] = [
    ...drafts.map(
      (row): CornerItem => ({
        key: row.thread_id,
        kind: 'draft',
        mark: draftMark(row),
        name: floaterName(row),
        label: `Reply to ${row.author?.kind === 'agent' ? row.author.name : 'the agent'}: ${row.subject ?? floaterName(row)}${row.unseen > 0 ? '. New message.' : ''}`,
        onOpen: () => openBox(row.thread_id),
        onPutAway: () => putAway(row.thread_id),
      }),
    ),
  ];

  const something = drafts.length > 0;
  const footRoom = !off && room.foot && !room.hidden && something && !(phone && room.boxOpen);
  const reserve = footRoom ? TILE + 12 : 0;
  useLayoutEffect(() => {
    const root = document.querySelector<HTMLElement>('.pn-inbox');
    if (!root) return;
    if (reserve > 0) {
      root.setAttribute('data-rf-room', '');
      root.style.setProperty('--ib-rf-room', `${reserve}px`);
    } else {
      root.removeAttribute('data-rf-room');
      root.style.removeProperty('--ib-rf-room');
    }
  }, [reserve]);
  useEffect(
    () => () => {
      const root = document.querySelector<HTMLElement>('.pn-inbox');
      root?.removeAttribute('data-rf-room');
      root?.style.removeProperty('--ib-rf-room');
    },
    [],
  );

  if (off) return { layer: null };

  const askGeom = !phone && askOpen && !ask.store.fullscreen ? ask.store.geometry() : null;
  const place: CSSProperties = askGeom ? { right: askGeom.right + askGeom.w + 12, bottom: askGeom.bottom } : { right: room.right, bottom: room.bottom };
  const showCorner = items.length > 0 && !room.hidden && !(phone && (room.boxOpen || askOpen || openRow !== null)) && !(!phone && openRow !== null) && !(askOpen && ask.store.fullscreen);
  const onAll = () => {
    setMenu(false);
    openDrafts();
  };

  return {
    layer: (
      <div ref={layerRef} className={`ib-rf-layer${phone && openRow ? ' ib-rf-over' : ''}`} data-rf-layer="" data-rf-phone={phone ? '' : undefined}>
        {showCorner &&
          (phone ? <PhoneCorner style={place} items={items} menu={menu} setMenu={setMenu} onAll={onAll} /> : <Stack style={place} items={items} menu={menu} setMenu={setMenu} onAll={onAll} />)}
        {openRow && (
          <FloaterBox
            key={openRow.thread_id}
            row={openRow}
            phone={phone}
            frame={frame}
            takeFocus={wantsFocus === openRow.thread_id}
            onMinimize={() => minimize(openRow.thread_id)}
            onPutAway={() => putAway(openRow.thread_id)}
            onOpenThread={() => toThread(openRow.thread_id)}
            onSent={(agent) => sent(openRow, agent)}
            onDiscarded={(words, files) => discarded(openRow, words, files)}
            onGone={() => gone(openRow.thread_id)}
          />
        )}
      </div>
    ),
  };
}

interface StackProps {
  style: CSSProperties;
  items: readonly CornerItem[];
  menu: boolean;
  setMenu: (open: boolean) => void;
  onAll: () => void;
}

function Stack({ style, items, menu, setMenu, onAll }: StackProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const spread = (on: boolean, wait: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMenu(on), wait);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const count = items.length;
  const last = useRef(count);
  const [arrive, setArrive] = useState(0);
  useEffect(() => {
    if (count > last.current) setArrive((n) => n + 1);
    last.current = count;
  }, [count]);
  const shown = items.slice(0, items.length > 6 ? 5 : 6);
  const more = items.length - shown.length;
  const drafts = items.filter((item) => item.kind === 'draft').length;
  const groupName = items.some((item) => item.kind === 'ask') ? 'Ask AI and draft replies' : 'Draft replies';
  return (
    <div
      ref={wrap}
      className="ib-rf-stack"
      style={style}
      role="group"
      aria-label={groupName}
      data-rf-corner=""
      data-spread={menu ? '' : undefined}
      onPointerEnter={(event) => event.pointerType === 'mouse' && spread(true, 70)}
      onPointerLeave={(event) => event.pointerType === 'mouse' && spread(false, 260)}
      onBlur={(event) => {
        if (!wrap.current?.contains(event.relatedTarget as Node | null)) spread(false, 60);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menu) {
          event.stopPropagation();
          setMenu(false);
          wrap.current?.querySelector<HTMLElement>('[data-rf-launcher]')?.focus();
        }
      }}
    >
      {more > 0 && (
        <button type="button" className="ib-rf-card ib-rf-morecard" style={{ '--i': shown.length } as CSSProperties} tabIndex={menu ? 0 : -1} aria-hidden={!menu} onClick={onAll} data-rf-more="">
          <span className="ib-rf-cardname">{more} more in Drafts</span>
        </button>
      )}
      {[...shown].reverse().map((item) => {
        const i = shown.indexOf(item);
        const front = i === 0;
        return (
          <div
            className="ib-rf-card"
            style={{ '--i': i } as CSSProperties}
            key={item.key}
            data-rf-card={item.key}
            data-kind={item.kind}
            data-front={front ? '' : undefined}
            data-deep={i > 2 ? '' : undefined}
            data-arrive={front && arrive > 0 ? arrive % 2 : undefined}
          >
            <button
              type="button"
              className="ib-rf-cardopen"
              aria-label={item.label}
              {...(front ? { 'data-rf-launcher': '', 'aria-expanded': items.length > 1 ? menu : undefined } : {})}
              tabIndex={front || menu ? 0 : -1}
              onClick={() => {
                if (!menu && items.length > 1) setMenu(true);
                else item.onOpen();
              }}
            >
              {item.mark}
              <span className="ib-rf-cardname" dir="auto">
                {item.name}
              </span>
              <span className="ib-rf-cardkind" aria-hidden="true">
                {item.kind === 'ask' ? <AskSparkle size={13} className="ib-ic" /> : <Icon name="pen" size={13} />}
              </span>
            </button>
            {item.onPutAway && (
              <button type="button" className="ib-rf-ic ib-rf-cardx" aria-label={`Stop floating: ${item.name}`} tabIndex={menu ? 0 : -1} onClick={item.onPutAway}>
                <Icon name="x" size={13} />
              </button>
            )}
          </div>
        );
      })}
      {items.length > 1 && !menu && (
        <span className="ib-rf-badge" aria-hidden="true">
          {drafts || items.length}
        </span>
      )}
    </div>
  );
}

function PhoneCorner({ style, items, menu, setMenu, onAll }: StackProps) {
  const front = items[0]!;
  const drafts = items.filter((item) => item.kind === 'draft');
  const withAsk = items.some((item) => item.kind === 'ask');
  const press = () => {
    if (items.length === 1) front.onOpen();
    else setMenu(true);
  };
  return (
    <>
      <button
        type="button"
        className="ib-rf-round"
        style={style}
        aria-label={withAsk ? (drafts.length > 0 ? `Ask AI and ${drafts.length === 1 ? '1 draft reply' : `${drafts.length} draft replies`}` : front.label) : items.length === 1 ? front.label : `Draft replies, ${items.length}`}
        data-rf-launcher=""
        data-rf-corner=""
        onClick={press}
      >
        {front.mark}
        {(items.length > 1 || (withAsk && drafts.length > 0)) && <span className="ib-rf-badge">{drafts.length || items.length}</span>}
      </button>
      {menu && (
        <div className="ib-rf-sheetwrap" role="dialog" aria-modal="true" aria-label={withAsk ? 'Ask AI and drafts' : 'Draft replies'} data-popover-layer="" data-chat-window="" data-rf-sheet="">
          <div className="ib-rf-sheethead">
            <span className="ib-rf-sheettitle">{withAsk ? 'Ask AI and drafts' : 'Drafts'}</span>
            <button type="button" className="ib-rf-ic" aria-label="Close" onClick={() => setMenu(false)} autoFocus>
              <Icon name="x" size={18} />
            </button>
          </div>
          <div className="ib-rf-list ib-rf-listsheet" role="list" data-rf-list="">
            {items.map((item) => (
              <div role="listitem" key={item.key}>
                <button type="button" className="ib-rf-row" onClick={item.onOpen} data-rf-row={item.key} aria-label={item.label}>
                  {item.mark}
                  <span className="ib-rf-rowtext">
                    <span className="ib-rf-rowname" dir="auto">
                      {item.name}
                    </span>
                    <span className="ib-rf-rowsub">{item.kind === 'ask' ? 'Chat about this thread' : 'Your reply'}</span>
                  </span>
                  <span className="ib-rf-cardkind" aria-hidden="true">
                    {item.kind === 'ask' ? <AskSparkle size={15} className="ib-ic" /> : <Icon name="pen" size={15} />}
                  </span>
                </button>
              </div>
            ))}
            <button type="button" className="ib-rf-all" onClick={onAll} data-rf-all="">
              All drafts
            </button>
          </div>
        </div>
      )}
    </>
  );
}

interface CornerRoom {
  foot: boolean;
  right: number;
  bottom: number;
  boxOpen: boolean;
  hidden: boolean;
}

function inCodeFence(node: Node): boolean {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.closest('pre') != null;
}

function useCornerRoom(on: boolean, phone: boolean): CornerRoom {
  const [room, setRoom] = useState<CornerRoom>({ foot: false, right: 16, bottom: 16, boxOpen: false, hidden: false });
  useLayoutEffect(() => {
    if (!on) return;
    let raf = 0;
    let watched: HTMLElement | null = null;
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
    const measure = () => {
      const vw = window.innerWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const foot = document.querySelector<HTMLElement>('section.ib-pane .ib-pfoot');
      const full = !!document.querySelector('.ib-fullview, [data-full-view-bar]');
      const keyboard = document.documentElement.hasAttribute('data-ib-keyboard');
      if (foot !== watched) {
        if (watched) sizes?.unobserve(watched);
        if (foot) sizes?.observe(foot);
        watched = foot;
      }
      let next: CornerRoom = { foot: false, right: 16, bottom: 16, boxOpen: false, hidden: full || keyboard };
      if (foot && !foot.hidden) {
        const f = foot.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(foot).paddingLeft) || (phone ? 12 : 30);
        const rrow = foot.querySelector<HTMLElement>('.ib-rbox .ib-rrow');
        const footrow = foot.querySelector<HTMLElement>('.ib-footrow');
        const line = (rrow ?? footrow)?.getBoundingClientRect();
        const cy = line ? line.top + line.height / 2 : f.top + f.height / 2;
        next = {
          foot: true,
          right: Math.round(vw - (f.right - pad)),
          bottom: Math.round(vh - cy - TILE / 2),
          boxOpen: !!rrow,
          hidden: full || keyboard,
        };
      }
      setRoom((last) => (last.foot === next.foot && last.right === next.right && last.bottom === next.bottom && last.boxOpen === next.boxOpen && last.hidden === next.hidden ? last : next));
    };
    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    }
    measure();
    // A code fence's highlight (ui's codeHighlight writes off-screen fences' markup in idle time, many a second on
    // a long thread) moves nothing measured here: it costs no measure, whose queries walk the whole page.
    const changes = new MutationObserver((records) => {
      if (records.some((record) => !inCodeFence(record.target))) schedule();
    });
    const root = document.querySelector('.pn-inbox') ?? document.body;
    changes.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'data-full-view-bar'] });
    changes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ib-keyboard'] });
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      changes.disconnect();
      sizes?.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
    };
  }, [on, phone]);
  return room;
}
