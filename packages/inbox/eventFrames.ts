import type { InboxHealth, InboxNotifyReach, InboxRestartAgents } from '@plannotator/core/inbox-types';
import { idsIn, INBOX_EVENT_FRAMES, localIdsIn, type InboxEvent, type InboxEventFrame, type InboxEventWindow, type MachineRecordFrame, type MachineView, type OutboxView, type TailscaleSettings, type UpdateCheckFailing } from './api';
import { inboxUrl, rememberLocal, rememberMachine } from './inboxUrl';
import { browserSharedEventsEnv, sharedInboxEventsSupported, subscribeOwnInboxEvents, subscribeSharedInboxEvents } from './sharedEvents';
import { parseRestartAgents } from './restartAgents';
import { readHello, type RestartHello } from './sessionAdopt';

export interface InboxEventHandlers {
  onRecord: (event: InboxEvent | null) => void;
  onStatus: (update: InboxHealth['update'], updated?: string | null, restartClaudeCode?: number, restartAgents?: InboxRestartAgents, checkFailing?: UpdateCheckFailing | null) => void;
  onReach?: (reach: InboxNotifyReach) => void;
  onDeliveries?: (change?: { labels: boolean; sessions: boolean; agents?: boolean }) => void;
  onConnect?: (hello?: RestartHello) => void;
  onDrafts?: (threadId: string | null) => void;
  onAsk?: (threadId: string) => void;
  onPins?: () => void;
  onArtifactPins?: () => void;
  onTags?: () => void;
  onShow?: (threadId: string, windowId: string) => void;
  onSnoozes?: () => void;
  onThreadPulls?: (threadIds: string[]) => void;
  onRows?: (rows: unknown, rev: unknown, last: { prev: unknown; by: unknown }) => void;
  onSidebar?: (sidebar: unknown, rev: unknown) => void;
  onAgentFaces?: (data: unknown) => void;
  onReactions?: (reactions: unknown, rev: unknown) => void;
  onCapabilities?: (capabilities: { board?: { on: boolean }; steps?: { on: boolean }; bro?: { on: boolean }; float_drafts?: { on: boolean }; mark_read_warning?: { on: boolean }; code_review?: { on: boolean }; shape?: { on: boolean }; system?: { on: boolean }; chapter_diagrams?: { on: boolean } }) => void;
  onTailscale?: (tailscale: TailscaleSettings) => void;
  onShapes?: (ids: string[]) => void;
  onMachine?: (frame: MachineRecordFrame) => void;
  onMachines?: (machines: MachineView[]) => void;
  onOutbox?: (entry: OutboxView) => void;
  onCatchUp?: () => void;
  onLive?: (live: boolean) => void;
}

export function dispatchInboxFrame(frame: InboxEventFrame, handlers: InboxEventHandlers): void {
  switch (frame.name) {
    case 'heartbeat':
      return;
    case 'hello':
      handlers.onConnect?.(readHello(frame.data) ?? undefined);
      return;
    case 'reach':
      try {
        handlers.onReach?.(JSON.parse(frame.data) as InboxNotifyReach);
      } catch {
      }
      return;
    case 'drafts':
      try {
        const data = JSON.parse(frame.data) as { thread_id?: unknown; compose?: unknown };
        if (typeof data.thread_id === 'string') handlers.onDrafts?.(data.thread_id);
        else if (data.compose === true) handlers.onDrafts?.(null);
      } catch {
      }
      return;
    case 'ask':
      try {
        const data = JSON.parse(frame.data) as { thread_id?: unknown };
        if (typeof data.thread_id === 'string') handlers.onAsk?.(data.thread_id);
      } catch {
      }
      return;
    case 'deliveries': {
      let labels = false;
      let sessions = false;
      let agents = false;
      try {
        const change = JSON.parse(frame.data) as { labels?: unknown; sessions?: unknown; agents?: unknown } | null;
        labels = change?.labels === true;
        sessions = change?.sessions === true;
        agents = change?.agents === true;
      } catch {
      }
      handlers.onDeliveries?.({ labels, sessions, agents });
      return;
    }
    case 'pins':
      handlers.onPins?.();
      return;
    case 'artifact-pins':
      handlers.onArtifactPins?.();
      return;
    case 'tags':
      handlers.onTags?.();
      return;
    case 'show':
      try {
        const data = JSON.parse(frame.data) as { thread_id?: unknown; window?: unknown };
        if (typeof data.thread_id === 'string' && typeof data.window === 'string') handlers.onShow?.(data.thread_id, data.window);
      } catch {
      }
      return;
    case 'snoozes':
      handlers.onSnoozes?.();
      return;
    case 'thread-pulls':
      try {
        const data = JSON.parse(frame.data) as { thread_ids?: unknown };
        const ids = Array.isArray(data.thread_ids) ? data.thread_ids.filter((id): id is string => typeof id === 'string') : [];
        if (ids.length > 0) handlers.onThreadPulls?.(ids);
      } catch {
      }
      return;
    case 'rows':
      try {
        const data = JSON.parse(frame.data) as { rows?: unknown; rev?: unknown; prev?: unknown; by?: unknown };
        handlers.onRows?.(data.rows, data.rev, { prev: data.prev, by: data.by });
      } catch {
      }
      return;
    case 'sidebar':
      try {
        const data = JSON.parse(frame.data) as { sidebar?: unknown; rev?: unknown };
        handlers.onSidebar?.(data.sidebar, data.rev);
      } catch {
      }
      return;
    case 'agent-faces':
      try {
        handlers.onAgentFaces?.(JSON.parse(frame.data));
      } catch {
      }
      return;
    case 'reactions':
      try {
        const data = JSON.parse(frame.data) as { reactions?: unknown; rev?: unknown };
        handlers.onReactions?.(data.reactions, data.rev);
      } catch {
      }
      return;
    case 'capabilities':
      try {
        const data = JSON.parse(frame.data) as { board?: { on?: unknown }; steps?: { on?: unknown }; bro?: { on?: unknown }; float_drafts?: { on?: unknown }; mark_read_warning?: { on?: unknown }; code_review?: { on?: unknown }; shape?: { on?: unknown }; system?: { on?: unknown }; chapter_diagrams?: { on?: unknown } };
        handlers.onCapabilities?.({
          ...(typeof data.board?.on === 'boolean' ? { board: { on: data.board.on } } : {}),
          ...(typeof data.steps?.on === 'boolean' ? { steps: { on: data.steps.on } } : {}),
          ...(typeof data.bro?.on === 'boolean' ? { bro: { on: data.bro.on } } : {}),
          ...(typeof data.float_drafts?.on === 'boolean' ? { float_drafts: { on: data.float_drafts.on } } : {}),
          ...(typeof data.mark_read_warning?.on === 'boolean' ? { mark_read_warning: { on: data.mark_read_warning.on } } : {}),
          ...(typeof data.code_review?.on === 'boolean' ? { code_review: { on: data.code_review.on } } : {}),
          ...(typeof data.shape?.on === 'boolean' ? { shape: { on: data.shape.on } } : {}),
          ...(typeof data.system?.on === 'boolean' ? { system: { on: data.system.on } } : {}),
          ...(typeof data.chapter_diagrams?.on === 'boolean' ? { chapter_diagrams: { on: data.chapter_diagrams.on } } : {}),
        });
      } catch {
      }
      return;
    case 'tailscale':
      try {
        const data = JSON.parse(frame.data) as { tailscale?: unknown };
        const tailscale = data.tailscale as TailscaleSettings | null | undefined;
        if (tailscale && typeof tailscale === 'object' && typeof tailscale.on === 'boolean') handlers.onTailscale?.(tailscale);
      } catch {
      }
      return;
    case 'shapes':
      try {
        const data = JSON.parse(frame.data) as { ids?: unknown };
        if (Array.isArray(data.ids)) handlers.onShapes?.(data.ids.filter((id): id is string => typeof id === 'string'));
      } catch {
      }
      return;
    case 'machine':
      try {
        const data = JSON.parse(frame.data) as Partial<MachineRecordFrame>;
        if (typeof data.machine === 'string' && typeof data.seq === 'number') {
          const machineKind = (data.record as { kind?: unknown } | undefined)?.kind;
          if (machineKind === 'steps' || machineKind === 'thread_pull') return;
          rememberMachine(idsIn(data.record), data.machine);
          handlers.onMachine?.({ machine: data.machine, seq: data.seq, live: data.live === true, record: (data.record as InboxEvent | undefined) ?? null });
        }
      } catch {
      }
      return;
    case 'machines':
      try {
        const data = JSON.parse(frame.data) as { machines?: unknown };
        if (Array.isArray(data.machines)) handlers.onMachines?.(data.machines as MachineView[]);
      } catch {
      }
      return;
    case 'outbox':
      try {
        const data = JSON.parse(frame.data) as OutboxView;
        if (typeof data.key === 'string' && typeof data.machine === 'string') handlers.onOutbox?.(data);
      } catch {
      }
      return;
    case 'record': {
      let parsed: InboxEvent | null = null;
      try {
        parsed = JSON.parse(frame.data) as InboxEvent;
      } catch {
      }
      if (parsed) rememberLocal(localIdsIn(parsed));
      handlers.onRecord(parsed);
      return;
    }
    case 'status':
      try {
        const data = JSON.parse(frame.data) as {
          update: InboxHealth['update'];
          updated?: string | null;
          restart_claude_code?: unknown;
          restart_agents?: unknown;
          update_check_failing?: UpdateCheckFailing | null;
        };
        handlers.onStatus(
          data.update,
          'updated' in data ? (data.updated ?? null) : undefined,
          typeof data.restart_claude_code === 'number' ? data.restart_claude_code : undefined,
          parseRestartAgents(data.restart_agents) ?? undefined,
          'update_check_failing' in data ? (data.update_check_failing ?? null) : undefined,
        );
      } catch {
      }
      return;
  }
}

export function openInboxEventFrames(cursor: number, onFrame: (frame: InboxEventFrame) => void, win?: InboxEventWindow): () => void {
  const query = new URLSearchParams({ cursor: String(cursor), machines: '1' });
  if (win) {
    query.set('window', win.id);
    query.set('permission', win.permission);
    query.set('origin', win.origin);
  }
  const source = new EventSource(inboxUrl(`/events?${query}`));
  for (const name of INBOX_EVENT_FRAMES) {
    source.addEventListener(name, (event) => {
      const message = event as MessageEvent<string>;
      onFrame({ name, data: typeof message.data === 'string' ? message.data : '', id: message.lastEventId || null });
    });
  }
  return () => source.close();
}

export function subscribeInboxEvents(cursor: number, handlers: InboxEventHandlers, win?: InboxEventWindow): () => void {
  if (win && sharedInboxEventsSupported()) {
    return subscribeSharedInboxEvents(cursor, handlers, win, browserSharedEventsEnv({ open: openInboxEventFrames, dispatch: dispatchInboxFrame }));
  }
  if (win && typeof document !== 'undefined') {
    return subscribeOwnInboxEvents(cursor, handlers, win, {
      open: openInboxEventFrames,
      dispatch: dispatchInboxFrame,
      lifecycle: { document, window },
      isVisible: () => document.visibilityState === 'visible',
    });
  }
  return openInboxEventFrames(cursor, (frame) => dispatchInboxFrame(frame, handlers), win);
}
