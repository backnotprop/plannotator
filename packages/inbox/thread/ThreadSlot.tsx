import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { RegionBoundary } from '@plannotator/ui/components/RegionBoundary';
import { closeTo } from '../app/focus';
import { writeRoute } from '../app/writeRoute';
import { CardChip } from '../board/CardChip';
import { NotificationAsk } from '../components/NotificationAsk';
import { ThreadPane } from '../components/Thread';
import { ThreadWait } from '../components/ThreadWait';
import { ThreadGone } from './ThreadGone';
import { fullExitFile, fullFromSide } from '../fullScreenOrigin';
import { useHeldThread } from '../data/queries/thread';
import type { HeldThread } from '../data/apply/record';
import { drawnSection } from '../held';
import { machineOf } from '../inboxUrl';
import { threadStepsRead } from '../linkedReads';
import { useFarStepsReread } from './useFarStepsReread';
import { machineTakes, rowSnoozes, snoozeBlockedBy, threadAwayLine, threadOutbox } from '../machines';
import { MAIN_PANE, type PaneId } from '../panes/model';
import type { PaneOnScreen } from '../panes/onScreen';
import { PaneScopeContext } from '../panes/scope';
import { priorityAction } from '../priority';
import { threadLink } from '../rowMenu';
import { threadBoardCard } from '../steps/model';
import { openTakenBack } from '../takenBackCompose';
import { pageOffersUpdates } from '../updateNotice';
import { fileOpener } from './openFile';
import type { ThreadSlotHost } from './slotHost';

export interface ThreadSlotProps {
  paneId: PaneId;
  /** The thread this pane shows (panes/model.ts), or null. */
  threadId: string | null;
  /** Only the active pane takes the thread keys and counts messages as seen. */
  active: boolean;
  /** On the page; false: mounted off it (panes/paneKeeper.tsx), so its thread is not on screen. Default true. */
  shown?: boolean;
  /** The thread as the window holds it for this pane; absent, the slot reads it from the cache itself. */
  held?: HeldThread | null;
  host: ThreadSlotHost;
}

/**
 * One thread pane: the "opening…" place until the thread's read lands, then the thread. Its keys, its seen-on-sight
 * and its place on screen are its own, keyed by `paneId`; what it reads from the window it reads by thread id.
 */
export function ThreadSlot({ paneId, threadId, active, shown: onPage = true, held: given, host }: ThreadSlotProps) {
  const { route, routeRef, phone, stack, full, fromCard, fileOpen, settings, machines, go, leave, close, listTitle } = host;
  // A pane that stops being the active one reads its thread itself and keeps showing what it showed.
  const shown = useRef<string | null>(null);
  const own = useHeldThread(given === undefined ? threadId : null, shown.current === threadId);
  const held = given === undefined ? own : given;
  const thread = held?.thread ?? null;
  const open = host.paneReads.view(paneId);
  const load = open.load?.threadId === threadId ? open.load : null;
  // A linked machine that is away: its line, and the answers held for it, in the thread's place.
  const owner = threadId ? machines.linked.find((m) => m.id === machineOf(threadId)) : undefined;
  const away = owner ? threadAwayLine(owner) : null;
  const awayWait = !!load && !(thread && thread.thread_id === threadId) && (((!!away || !!load.waiting) && load.state === 'failed') || load.state === 'refused');
  const ready = !!threadId && !!thread && thread.thread_id === threadId && !host.rowsPending;
  useEffect(() => {
    if (ready) shown.current = threadId;
  });
  const scope = useMemo(() => ({ paneId, active }), [paneId, active]);
  const activeRef = useRef(active);
  activeRef.current = active;
  /** Focus was in the thread's place when it gave way to the thread: it goes to the thread's subject. */
  const focusSubject = useRef(false);
  useEffect(() => {
    focusSubject.current = false;
  }, [threadId]);
  // The thread landed while focus was in its place: focus goes to its subject, never to the page.
  useLayoutEffect(() => {
    if (!focusSubject.current || !thread || thread.thread_id !== threadId) return;
    focusSubject.current = false;
    document.querySelector<HTMLElement>(`section.ib-pane[data-thread-id="${CSS.escape(thread.thread_id)}"] .ib-subject`)?.focus();
  }, [thread, threadId]);
  // What the thread says of itself on screen, held back while the pane waits off the page.
  const screen = useRef<PaneOnScreen | null>(null);
  const reportScreen = () => {
    const state = onPage ? screen.current : null;
    host.panesOnScreen.set(paneId, state);
    if (paneId === MAIN_PANE) host.setOpenThreadCovered(state?.covered ?? false);
  };
  const pageRef = useRef(onPage);
  useEffect(() => {
    if (pageRef.current === onPage) return;
    pageRef.current = onPage;
    reportScreen();
  });
  const onClose = fromCard ? host.backToCard : () => close({ ...route, thread: null, file: null });
  const stepsRead = thread ? threadStepsRead(thread.thread_id, settings?.steps) : null;
  useFarStepsReread(thread?.thread_id, (id) => host.stepsBus.emit(id));
  const backLabel = fromCard ? 'Board' : route.reviews ? 'Reviews' : listTitle;
  // A thread that throws while it draws says so in the pane; the sidebar and the list stay (ui's RegionBoundary). Try
  // again mounts the pane afresh, which reads its reply draft back from the server (replyDraft.ts flushes on unmount).
  // The notice takes the header's Back too, and the address names the thread (a reload opens it again): its own Back,
  // in the header's words, closes the pane (on a phone, back to the list).
  return (
    <PaneScopeContext.Provider value={scope}>
      <RegionBoundary name="Thread pane" className="ib-pane ib-pempty" resetKey={threadId} onClose={onClose} closeLabel={`Back to ${backLabel}`}>
      {/* Beside the list, the thread's place says it is opening (or why not) until its read lands; a phone
          and a stacked window keep the list until there is a thread to show, or the thread's machine is away. */}
      {threadId && !ready && ((!phone && !stack.thread) || awayWait) && (
        <ThreadWait
          key={threadId}
          load={load}
          away={away}
          held={{ entries: threadOutbox(host.outbox, { thread_id: threadId, messages: [] }), machine: owner ?? null, onDismiss: host.dismissOutbox }}
          onFocusLeaving={() => {
            focusSubject.current = true;
          }}
          onRetry={() => {
            focusSubject.current = false;
            host.paneReads.retry(paneId);
          }}
          onClose={onClose}
        />
      )}
      {threadId && thread && ready && (
        <ThreadPane
          notice={
            <>
              {/* No list beside the thread (a phone, a stacked window, full screen, a card's thread, beside a file):
                  the stale page notice is here instead. */}
              {(phone || stack.thread || full || fromCard || fileOpen) && host.staleNotice}
              {/* Deleted elsewhere while on screen: it stays, and says so above it. */}
              {load?.gone && <ThreadGone />}
              {host.notifyAgainIn === thread.thread_id ? (
              <div className="ib-tour-notify-again" data-tour-notify-again="">
                <NotificationAsk
                  kind={host.notifications.ask!}
                  soundOn={host.soundOn}
                  movedFrom={settings?.notifications.allowed_origin ?? null}
                  onTurnOn={() => {
                    host.saveTour({ notify_again: false });
                    void host.notifications.turnOn();
                  }}
                  onNotNow={() => host.saveTour({ notify_again: false })}
                  onSettings={() => go({ page: 'settings', project: null, thread: null, section: 'general' })}
                />
              </div>
              ) : null}
            </>
          }
          thread={thread}
          onNewMessageWith={(source) => host.openCompose({ reuse: [source] })}
          codeReview={settings?.code_review?.on === true}
          pullReview={
            host.pullReviewOf
              ? {
                  linkOf: host.pullReviewOf,
                  // A thread opened beside Reviews keeps Reviews beside the one it opens.
                  onOpen: (link) => leave(link.kind === 'thread' ? { page: 'inbox', project: null, thread: link.threadId, reviews: route.reviews } : { page: 'reviews', project: null, thread: null, stack: link.stackId, layer: null }),
                }
              : undefined
          }
          inReviews={!!route.reviews}
          reviewView={host.reviewView}
          onInReviews={host.pullsShown && !route.reviews ? () => go({ page: 'inbox', reviews: { project: null, view: 'all' }, project: null, thread: thread.thread_id }) : undefined}
          threadSteps={
            // The thread's own machine's Steps switch decides (a linked machine's thread: its answer's `on`).
            stepsRead !== null
              ? {
                  on: stepsRead,
                  subscribe: host.stepsBus.subscribe,
                  // The checklist head's Board icon (part 4): the card that links this thread, while the Board is on.
                  boardCard: (() => {
                    const card = host.boardEnabled === true && host.cards ? threadBoardCard(host.cards.cards, thread.thread_id) : null;
                    if (!card) return null;
                    return {
                      title: card.title,
                      onOpen: () =>
                        fromCard === card.id ? host.backToCard() : go({ page: 'board', project: null, thread: null, board: 'lanes', card: card.id }),
                    };
                  })(),
                }
              : null
          }
          sent={host.openThreadRow?.sent ?? null}
          row={host.openThreadRow}
          snoozeBack={host.snoozeBack?.until ?? null}
          run={held && held.run !== undefined ? held.run : undefined}
          attachCommand={held && held.run !== undefined ? (held.attach_command ?? null) : null}
          onRunChanged={() => void host.refreshThread(thread.thread_id)}
          openedWith={open.openedWith?.threadId === thread.thread_id ? open.openedWith.ids : null}
          drawn={drawnSection(host.shown, thread.thread_id)}
          onMarkRead={(read) => void host.markRead(thread.thread_id, read)}
          onMarkUnread={() => void host.markUnread(thread.thread_id)}
          onAck={(messageId, on, agent, reaction, was) => void host.acknowledge(thread.thread_id, messageId, on, agent, reaction, was)}
          onAction={(messageId, key, mark) => host.markAction(messageId, key, mark)}
          onArchive={(next) => void host.archive(thread.thread_id, thread.messages[0]!.id, next)}
          pinned={host.pinnedIds.has(thread.thread_id)}
          onPin={host.pinsOn && machineTakes({ machine: machineOf(thread.thread_id) ?? undefined }, machines, 'star') ? (next) => host.setPin(thread, next) : undefined}
          priority={(() => {
            const action = host.openThreadRow && machineTakes(host.openThreadRow, machines, 'priority') ? priorityAction(host.openThreadRow) : null;
            return action ? { on: action === 'priority-remove', onToggle: () => void host.setPriority(thread, action === 'priority-add') } : undefined;
          })()}
          onSnooze={host.snoozeOn && rowSnoozes({ machine: machineOf(thread.thread_id) ?? undefined }, machines) ? (until) => void host.snooze(thread, until) : undefined}
          onUnsnooze={host.snoozeOn && rowSnoozes({ machine: machineOf(thread.thread_id) ?? undefined }, machines) ? () => void host.unsnooze(thread) : undefined}
          snoozeBlocked={(() => {
            const blocked = host.snoozeOn && pageOffersUpdates(settings) ? snoozeBlockedBy({ machine: machineOf(thread.thread_id) ?? undefined }, machines) : null;
            return blocked ? { name: blocked.name, onPress: () => host.setMachineUpdateOpen({ id: blocked.id, snooze: true }) } : undefined;
          })()}
          machine={machines.linked.find((m) => m.id === machineOf(thread.thread_id)) ?? null}
          agentContext={host.threadAgentContext}
          // A session's name in the thread's header filters the list to that agent, as the sidebar's agent does,
          // and keeps this thread on screen (the person is reading it); a second click shows everything again.
          agentFilter={route.page === 'inbox' ? (route.agent ?? null) : null}
          onAgentFilter={(agentId) => leave({ page: 'inbox', project: null, machine: null, agent: agentId, thread: route.page === 'inbox' ? route.thread : null })}
          onMachineUpdate={pageOffersUpdates(settings) ? (id) => host.setMachineUpdateOpen({ id, snooze: false }) : undefined}
          outbox={threadOutbox(host.outbox, thread)}
          onDismissOutbox={host.dismissOutbox}
          replyRequest={host.replyFor}
          draftSignal={host.draftSignals.of(thread.thread_id)}
          filesSignal={host.filesSignals.of(thread.thread_id)}
          onReplyOpened={() => host.setReplyFor(null)}
          onSide={host.ask.side}
          onSideWords={host.ask.sideWords}
          replyWords={host.askReply?.threadId === thread.thread_id ? host.askReply.words : null}
          onReplyWordsTaken={() => host.setAskReply(null)}
          onQuestions={host.patchQuestions}
          onPickSaves={(ids, paneClosed) => host.onPickSaves(ids, paneClosed, threadId)}
          onChanged={host.afterWrite}
          onTakenBack={(draft) => openTakenBack(draft, host.openCompose, host.afterWrite)}
          readPending={host.rowPatches.get(thread.thread_id)?.read_at !== undefined}
          onSentRead={async (model) => {
            if (routeRef.current.thread !== model.thread.thread_id) return false;
            const drawn = await host.refreshThread(model.thread.thread_id, model);
            if (!drawn) return false;
            void host.refreshList(false);
            return true;
          }}
          onClose={onClose}
          file={route.file ?? null}
          namedFile={route.ref ?? null}
          onOpenNamedFile={(ref) => (ref ? go({ ...routeRef.current, file: null, ref }) : close({ ...routeRef.current, ref: null }))}
          onOpenFile={fileOpener(routeRef)}
          fullFromSide={fullFromSide(window.history.state)}
          fullExitFile={fullExitFile(window.history.state)}
          onOpenGuide={(messageId, at) => go({ ...route, guide: messageId, ...(at ? { guideAt: at } : {}) })}
          artifacts={route.artifacts === true}
          onArtifacts={(open) => (open ? go({ ...routeRef.current, artifacts: true, links: false, msg: null }) : close({ ...routeRef.current, artifacts: false, links: false }))}
          links={route.artifacts === true && route.links === true}
          // Between the view's two sides: the same screen, so Back still returns to the thread.
          onLinks={(on) => writeRoute({ ...routeRef.current, links: on }, { replace: true })}
          // Decision mode's one way in (thread only): from two of this thread's decisions up, and not while a
          // sitting is tucked into its pill (the pill's Resume is the way back to it).
          decide={host.decideInThread(thread.thread_id)}
          landing={
            route.msg && host.decideLanding.current?.messageId === route.msg
              ? { messageId: route.msg, terms: [], questionKey: host.decideLanding.current.questionKey, focus: 'prompt' }
              : route.msg
              ? {
                  messageId: route.msg,
                  terms: host.searchLanding.current?.messageId === route.msg ? host.searchLanding.current.terms : [],
                  questionKey: host.searchLanding.current?.messageId === route.msg ? host.searchLanding.current.questionKey : null,
                }
              : null
          }
          onLanded={host.landed}
          lookSeq={open.look?.threadId === thread.thread_id ? open.look.seq : undefined}
          seenThrough={open.look?.threadId === thread.thread_id ? open.look.through : null}
          // Only the active pane counts what it shows as seen (panes/model.ts).
          onSeen={(through) => activeRef.current && host.seenOnSight(thread.thread_id, through)}
          covered={host.covered}
          parked={!onPage}
          onScreenChange={(state) => {
            screen.current = state;
            reportScreen();
          }}
          backLabel={backLabel}
          cardChip={fromCard ? <CardChip card={host.cards?.cards.find((c) => c.id === fromCard) ?? null} onOpen={host.backToCard} /> : undefined}
          phone={phone}
          stacked={stack.thread || !!fromCard}
          threadAlone={full}
          paired={host.paired}
          fullSidebar={host.fullSidebar}
          onFull={fromCard ? undefined : (on) => (on ? host.setThreadFull(true) : host.leaveFull())}
          fileStacked={stack.file}
          remote={settings ? (settings.via ?? 'local') === 'tailnet' : null}
          onToast={(t) => host.showToast(t)}
          linkOf={(messageId) => threadLink(thread.thread_id, settings, window.location.origin, messageId)}
          onInboxLink={host.inboxLink}
          onBackToList={(fileName) => {
            // The file's own close (its ×), then focus on this thread's row and one line for a screen reader.
            host.holdSidebarIfTight();
            // ‹ Inbox beside a file opened from full screen ends full screen too: the list comes back.
            host.setThreadFull(false);
            host.backFromFile.current = { thread: thread.thread_id, name: fileName, label: listTitle };
            closeTo({ ...routeRef.current, file: null });
          }}
        />
      )}
      </RegionBoundary>
    </PaneScopeContext.Provider>
  );
}
