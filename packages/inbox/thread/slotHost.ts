import type { ReactNode, RefObject } from 'react';
import type { InboxListRow, InboxListSection, InboxReaction, InboxThread, InboxTourChange } from '@plannotator/core/inbox-types';
import type { CardsModel, OutboxView, SettingsModel, ThreadModel } from '../api';
import type { Route } from '../app/route';
import type { SearchLanding } from '../components/SearchHost';
import type { InboxToastModel } from '../components/Toast';
import type { ComposeRequest } from '../compose/ComposeDialog';
import type { MachinesModel } from '../machines';
import type { useInboxNotifications } from '../notify';
import type { PanesOnScreen } from '../panes/onScreen';
import type { PaneReads } from '../panes/paneReads';
import type { useInboxShapes } from '../shape/useInboxShapes';
import type { ShapeReplyPart } from '../shape/addToReply';
import type { KeyedSignal } from '../signal';
import type { Stack } from '../stack';
import type { createStepsBus } from '../steps/useThreadSteps';
import type { ThreadPaneProps } from './paneProps';

/**
 * What a thread slot takes from the window: the window's state and its actions on a thread. Per-pane state is not
 * here; the slot keeps it, or reads it from the window by thread id.
 */
export interface ThreadSlotHost {
  route: Route;
  routeRef: RefObject<Route>;
  /** The window's own wait before drawing a thread (a link into Reviews waits for its rows). */
  rowsPending: boolean;
  outbox: ReadonlyMap<string, OutboxView>;
  dismissOutbox: (key: string) => void;
  /** Each pane's reads, its load, what it opened with and its look (panes/paneReads.ts). */
  paneReads: PaneReads;
  phone: boolean;
  stack: Stack;
  full: boolean;
  fromCard: string | null;
  fileOpen: boolean;
  staleNotice: ReactNode;
  /** The thread "Notify again" shows in, or null. */
  notifyAgainIn: string | null;
  notifications: ReturnType<typeof useInboxNotifications>;
  soundOn: boolean;
  settings: SettingsModel | null;
  saveTour: (change: InboxTourChange) => void;
  go: (next: Route) => void;
  leave: (next: Route) => void;
  close: (next: Route) => void;
  openCompose: (request: ComposeRequest, opener?: HTMLElement | null) => void;
  pullReviewOf: NonNullable<ThreadPaneProps['pullReview']>['linkOf'] | null;
  reviewView: ThreadPaneProps['reviewView'];
  pullsShown: boolean;
  stepsBus: ReturnType<typeof createStepsBus>;
  boardEnabled: boolean | null;
  boardsOn: boolean;
  cards: CardsModel | null;
  backToCard: () => void;
  openThreadRow: InboxListRow | null;
  snoozeBack: { until: string } | null;
  refreshThread: (threadId: string, given?: ThreadModel) => Promise<InboxThread | null>;
  refreshList: (adopt: boolean) => Promise<unknown>;
  shown: InboxListSection[] | null;
  markRead: (threadId: string, read: boolean) => Promise<unknown>;
  markUnread: (threadId: string) => Promise<unknown>;
  acknowledge: (threadId: string, messageId: string, on: boolean, agent: string, reaction?: InboxReaction | null, was?: InboxReaction | null) => Promise<unknown>;
  markAction: NonNullable<ThreadPaneProps['onAction']>;
  archive: (threadId: string, rootId: string, next: boolean) => Promise<unknown>;
  pinnedIds: ReadonlySet<string>;
  pinsOn: boolean;
  machines: MachinesModel;
  setPin: (row: Pick<InboxListRow, 'thread_id' | 'subject'>, pinned: boolean) => Promise<unknown>;
  setPriority: (thread: InboxThread, on: boolean) => unknown;
  snoozeOn: boolean;
  snooze: (thread: InboxThread, until: string) => unknown;
  unsnooze: (thread: InboxThread) => unknown;
  setMachineUpdateOpen: (open: { id: string; snooze: boolean }) => void;
  threadAgentContext: ThreadPaneProps['agentContext'];
  replyFor: string | null;
  setReplyFor: (threadId: string | null) => void;
  draftSignals: KeyedSignal;
  filesSignals: KeyedSignal;
  shapes: ReturnType<typeof useInboxShapes>;
  ask: { side: ThreadPaneProps['onSide']; sideWords: ThreadPaneProps['onSideWords'] };
  askReply: { threadId: string; words: string } | null;
  setAskReply: (next: null) => void;
  shapeReply: (ShapeReplyPart & { threadId: string }) | null;
  setShapeReply: (next: null) => void;
  patchQuestions: ThreadPaneProps['onQuestions'];
  onPickSaves: ThreadPaneProps['onPickSaves'];
  afterWrite: () => Promise<void>;
  rowPatches: ReadonlyMap<string, { read_at?: unknown }>;
  decideInThread: (threadId: string) => ThreadPaneProps['decide'];
  searchLanding: RefObject<SearchLanding | null>;
  decideLanding: RefObject<{ messageId: string; questionKey: string } | null>;
  landed: () => void;
  seenOnSight: (threadId: string, through: number) => void;
  /** A dialog, a guide or New message is over the window. */
  covered: boolean;
  panesOnScreen: PanesOnScreen;
  setOpenThreadCovered: (covered: boolean) => void;
  listTitle: string;
  fullSidebar: boolean;
  setThreadFull: (on: boolean) => void;
  leaveFull: () => void;
  showToast: (toast: Omit<InboxToastModel, 'id'>) => void;
  toastNow: RefObject<InboxToastModel | null>;
  dismissToast: () => void;
  inboxLink: (href: string) => (() => void) | null;
  holdSidebarIfTight: () => void;
  backFromFile: RefObject<{ thread: string; name: string | null; label: string } | null>;
}
