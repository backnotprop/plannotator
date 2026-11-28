import { useEffect, useRef, useState } from 'react';
import type { InboxCardHistoryEntry, InboxCardRef, InboxCardWire, InboxListRow, InboxProjectRepo, InboxInitiative } from '@plannotator/core/inbox-types';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { InboxHeldError, heldWords, inboxApi, type ComposeSessionsModel, type MachineView } from '../api';
import { findTarget, hostLabel } from '../compose/model';
import { CardPanel } from './CardPanel';
import { agentState, askWhereBody, messageKey, startBody, type BoardMove } from './model';
import { newUuid } from '../uuid';
import { farMachine } from './farCards';

/**
 * The opened card with what it reads: its history (read when it opens and
 * after each write) and its links' live state (read once when it opens, and
 * again when a link is added; never before a card is opened).
 */
export function OpenedCard({
  card,
  projectName,
  projectRoot,
  sessions,
  live,
  phone,
  now,
  rowOf,
  onClose,
  onMove,
  dropAsk,
  onSend,
  onChanged,
  onOpenThread,
  onCreateThread,
  initiatives,
  onInitiative,
  machine,
  onHeld,
}: {
  card: InboxCardWire;
  projectName: string;
  projectRoot: string | null;
  sessions: ComposeSessionsModel | null;
  live: { session: string; busy: boolean | null }[] | null;
  /** The linked machine that holds the card (its agents are that machine's), or null for this Inbox's own. */
  machine: MachineView | null;
  /** A write held for that machine while it is asleep: the window's clock toast. */
  onHeld: (cause: InboxHeldError) => void;
  phone: boolean;
  now: number;
  rowOf: (threadId: string) => InboxListRow | null;
  onClose: () => void;
  /** `fromMenu`: a Drop… the card's right-click menu started (its toast). */
  onMove: (move: BoardMove, fromMenu?: boolean) => Promise<void>;
  /** Drop… from the card's right-click menu (a new number each time): the reason field opens, focused. */
  dropAsk: number;
  onSend: () => void;
  onChanged: (card?: InboxCardWire) => void;
  onOpenThread: (threadId: string) => void;
  onCreateThread: (session: string | null, opener: HTMLElement) => void;
  /** Every initiative, deleted ones too (the history names them); the menu offers the live ones. */
  initiatives: readonly InboxInitiative[];
  onInitiative: (initiative: string | null) => void;
}) {
  const [history, setHistory] = useState<InboxCardHistoryEntry[] | null>(null);
  // The card's own project's repo (not the window's): its text links `#123` there.
  const [repo, setRepo] = useState<InboxProjectRepo | null>(null);
  const [refs, setRefs] = useState<{ ref: InboxCardRef; result: ForgeRefCardResult }[] | null>(null);
  useEffect(() => {
    let alive = true;
    inboxApi
      .card(card.id)
      .then((answer) => {
        if (!alive) return;
        setHistory(answer.history);
        setRepo(answer.repo ?? null);
      })
      .catch(() => alive && setHistory([]));
    return () => {
      alive = false;
    };
  }, [card.id, card.heard_at]);
  const refKey = (card.refs ?? []).map((r) => r.url).join(' ') || card.prs.map((p) => p.url).join(' ');
  useEffect(() => {
    let alive = true;
    setRefs(null);
    if (!refKey) {
      setRefs([]);
      return;
    }
    inboxApi
      .cardRefs(card.id)
      .then((answer) => alive && setRefs(answer.refs))
      .catch(() => alive && setRefs([]));
    return () => {
      alive = false;
    };
  }, [card.id, refKey]);
  const agentSession = card.agent?.kind === 'agent' ? card.agent.session : null;
  // "Ask for an update" and "Create thread": the card's agent while it is live, else a live session in the card's project.
  const askTarget = (() => {
    if (!sessions) return null;
    const own = findTarget(sessions.projects, agentSession);
    if (own) return own;
    const group = sessions.projects.find((g) => g.project.id === card.project_id || (projectRoot !== null && g.project.root === projectRoot));
    return group?.sessions[0] ? { ...group.sessions[0], project: group.project } : null;
  })();
  /**
   * A message to the agent: into the card's thread when the card's own agent
   * is live there, else a new thread to the live session (linked to the
   * card). Answers the message's id.
   */
  // One key per action on this opened card, kept across retries (a lost answer replays the message
  // instead of sending a second one), and fresh after it went (a later Ask is a new message).
  const startKey = useRef(newUuid());
  const askKey = useRef(newUuid());
  const tellAgent = async (body: string, key: string, link: boolean): Promise<string> => {
    if (!askTarget) throw new Error('No agent is running in this project.');
    const idempotency = messageKey(key, askTarget.session, body);
    const thread = card.threads.find((id) => rowOf(id)?.project.id === card.project_id) ?? card.threads[0];
    if (thread && askTarget.session === agentSession) {
      const sent = await inboxApi.newMessage(thread, { session: askTarget.session, body, idempotency_key: idempotency });
      // Held for an asleep linked machine: it goes when that machine is back, and the card is not marked sent before.
      if (sent.held) throw new Error(heldWords(machine));
      return sent.message?.id ?? idempotency;
    }
    const started = await inboxApi.startThread({ to: { host: askTarget.host, session: askTarget.session }, body, idempotency_key: idempotency }, farMachine(card));
    // A send links the thread itself; an Ask links it here.
    if (link) onChanged((await inboxApi.editCard(card.id, { op: 'link', thread_id: started.thread_id })).card);
    return started.message.id;
  };
  return (
    <CardPanel
      card={card}
      history={history}
      initiatives={initiatives}
      onInitiative={onInitiative}
      refs={refs}
      projectName={projectName}
      repo={repo}
      state={agentState(agentSession, live)}
      canAsk={askTarget !== null}
      askNote={
        askTarget && agentSession && askTarget.session !== agentSession
          ? `Its agent's session ended; this asks another ${hostLabel(askTarget.host)} session in ${askTarget.project.name}.`
          : null
      }
      rowOf={rowOf}
      phone={phone}
      now={now}
      onClose={onClose}
      onColumn={(column) => onMove({ op: 'move', column })}
      onShip={() => onMove({ op: 'move', column: 'done' })}
      onRestore={() => onMove({ op: 'restore' })}
      onDrop={(reason, fromMenu) => onMove({ op: 'drop', reason }, fromMenu)}
      dropAsk={dropAsk}
      onSend={onSend}
      onStart={async () => {
        // Start: the card's agent (else a live session in its project) is told to begin, in the card's
        // thread when that agent is the card's own; the card shows "Sent to <agent>" until it moves.
        if (!askTarget) return 'No agent is running in this project.';
        try {
          const messageId = await tellAgent(startBody(card), startKey.current, false);
          onChanged((await inboxApi.editCard(card.id, { op: 'send', thread_id: messageId })).card);
          startKey.current = newUuid();
          return null;
        } catch (cause) {
          return cause instanceof Error ? cause.message : 'Nothing was sent.';
        }
      }}
      onAsk={async () => {
        if (!askTarget) return 'No agent is running in this project.';
        try {
          await tellAgent(askWhereBody(card), askKey.current, true);
          askKey.current = newUuid();
          return null;
        } catch (cause) {
          return cause instanceof Error ? cause.message : 'Nothing was sent.';
        }
      }}
      onNotes={async (notes) => {
        try {
          onChanged((await inboxApi.editCard(card.id, { op: 'edit', notes })).card);
          return true;
        } catch (cause) {
          // Held for an asleep linked machine: kept, and saved there when it is back (the clock toast).
          if (!(cause instanceof InboxHeldError)) return false;
          onHeld(cause);
          return true;
        }
      }}
      onLink={async (ref) => {
        try {
          onChanged((await inboxApi.editCard(card.id, { op: 'link', ref })).card);
          return null;
        } catch (cause) {
          return cause instanceof Error ? cause.message : 'Not linked.';
        }
      }}
      onUnlink={async (url) => {
        try {
          onChanged((await inboxApi.editCard(card.id, { op: 'unlink', url })).card);
          return null;
        } catch (cause) {
          return cause instanceof Error ? cause.message : 'Not removed.';
        }
      }}
      onOpenThread={onOpenThread}
      onCreateThread={(opener) => onCreateThread(askTarget?.session ?? null, opener)}
    />
  );
}

/** Letter marks (letterMarks.tsx): the card's project mark (16 px) in its meta, while project marks show. */
