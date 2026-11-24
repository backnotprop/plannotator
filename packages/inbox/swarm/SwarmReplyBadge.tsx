import { useSyncExternalStore } from 'react';
import type { ThreadSession } from '../agents/model';
import type { ReplyText } from '../replyText';
import { SwarmBadge } from './SwarmBadge';
import { carriesSwarm, swarmAgentKind, swarmAgentName, swarmWordsFor, type SwarmSkillContext } from './swarmSkillWords';

/**
 * The Swarm badge in a thread's reply box (docs/agent-guides/inbox-compose.md, "Swarm"): quiet, with no entrance. As in
 * New message its state IS "the reply's words carry `/swarm`": a press puts it in or takes it out, typing it lights the
 * badge, and a reply sent with it makes the thread a swarm (on this computer, or the linked computer that holds the
 * thread, through its forward). In a thread that is a swarm already it shows only while the words carry `/swarm`.
 * It reads the words from the reply's store, so typing re-renders the badge alone, never the thread.
 */
export function SwarmReplyBadge({ text, onChange, swarmOn }: { text: ReplyText; onChange: (words: string) => void; swarmOn: boolean }) {
  const read = () => carriesSwarm(text.get());
  const on = useSyncExternalStore(text.subscribe, read, read);
  if (swarmOn && !on) return null;
  return (
    <span className="ib-swarm-reply" data-reply-swarm="">
      <SwarmBadge on={on} appear={false} onToggle={(next) => onChange(swarmWordsFor(text.get(), next))} />
    </span>
  );
}

/** Who a reply goes to, for `/swarm`'s text (@plannotator/core/swarm-skill): the thread's agents, none when it has one. */
export function swarmReplySkill(sessions: readonly Pick<ThreadSession, 'host'>[], project: string | null): SwarmSkillContext {
  return { agents: sessions.map((s) => swarmAgentName(swarmAgentKind(s.host), [project])) };
}
