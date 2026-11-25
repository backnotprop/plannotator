/**
 * The window's side of the icon dialog's requests, Animate it and Ask an agent to draw it
 * (packages/server/inbox-icon-animate.ts). A request about a project goes to the Inbox that has it (inboxUrl), a linked
 * machine's too, which keeps it.
 */
import { get, post } from '../api';
import { inboxUrl, machineOf } from '../inboxUrl';

/** "Animate it": a request an agent's hand-back names (`{ request }`), for this agent or project and the picture it shows. */
export const askIconAnimate = (animate: { icon: string; agent: string; sessions: string[] } | { icon: string; project: string }) =>
  post<{ request?: unknown }>(inboxUrl('/icon-animate', undefined, 'project' in animate ? machineOf(animate.project) : null), { animate });

/** Ask an agent to draw it: a request about an agent's icon or a project's picture, kept by the Inbox that has the project. */
export const askIconDraw = (draw: { agent: string; sessions: string[] } | { project: string }) =>
  post<{ request?: unknown }>(inboxUrl('/icon-animate', undefined, 'project' in draw ? machineOf(draw.project) : null), { draw });

/** Pictures agents handed back and the originals they replaced (`{ results: [{ icon, result }] }`): "Use the original". */
export const iconAnimateResults = () => get<{ results?: unknown }>(inboxUrl('/icon-animate'));
