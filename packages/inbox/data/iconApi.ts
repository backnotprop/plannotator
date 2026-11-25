/**
 * The window's side of the icon dialog's requests (packages/server/inbox-icon-animate.ts). A request about a project
 * goes to the Inbox that has it (inboxUrl), a linked machine's too, which keeps it.
 */
import { get, post } from '../api';
import { inboxUrl, machineOf } from '../inboxUrl';

/** "Animate it": a request an agent's hand-back names (`{ request }`), for this agent or project and the picture it shows. */
export const askIconAnimate = (animate: { icon: string; agent: string; sessions: string[] } | { icon: string; project: string }) =>
  post<{ request?: unknown }>(inboxUrl('/icon-animate', undefined, 'project' in animate ? machineOf(animate.project) : null), { animate });

/** Pictures agents handed back and the originals they replaced (`{ results: [{ icon, result }] }`): "Use the original". */
export const iconAnimateResults = () => get<{ results?: unknown }>(inboxUrl('/icon-animate'));
