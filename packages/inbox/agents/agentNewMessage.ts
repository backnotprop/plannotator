import type { InboxAgent } from '@plannotator/core/inbox-types';
import type { MachineView } from '../api';

/**
 * The sidebar agent menu's first item: New message with this agent already in To. The compose button's name and the
 * dialog's title ("New message"), with the ellipsis of a menu item that opens something to fill in (Rename…, the
 * palette's "New message…").
 */
export const AGENT_NEW_MESSAGE_LABEL = 'New message…';

/**
 * Whether New message's To takes this agent now, so the menu offers the item only where it works (never a dead item):
 *
 * - its session is live and its own (not a launch's `launch:` placeholder, which has nothing to write to yet);
 * - it said where it works (`project`): To lists a live session only under its project (inbox-compose.ts `placeOf`);
 * - a launch the person stopped no longer polls: a reply starts it again, a new message would be refused;
 * - on a linked machine, only while To lists that machine's sessions: launch is on here (`linked`; ComposeDialog reads
 *   other machines only then), and the machine is online with an Inbox that says whether launch is on there
 *   (useMachineLaunches `readable`).
 *
 * `machine`: the agent's machine, null when nothing is linked.
 */
export function agentTakesNewMessage(agent: InboxAgent, machine: Pick<MachineView, 'self' | 'state' | 'launch'> | null, linked: boolean): boolean {
  if (!agent.live || agent.session.startsWith('launch:') || agent.project === null) return false;
  if (agent.launch?.run === 'stopped') return false;
  if (!machine || machine.self) return true;
  return linked && machine.state === 'online' && (machine.launch === true || machine.launch === false);
}
