/** Settings → Agents' "Start new agents in" (packages/server/inbox-launch.ts `settingsState`): its fields and its save. */
import { post, type InboxLaunchSettings } from '../../api';
import { inboxUrl } from '../../inboxUrl';

declare module '../../api' {
  interface InboxLaunchSettings {
    /** Where new agents start: the Inbox (in the background), Rex or T3 Code. Absent from an older Inbox. */
    start_in?: 'inbox' | 'rex' | 't3';
    /** Rex's app is attached on this computer now (only in this computer's own Settings answer). */
    rex_here?: boolean;
    /** Rex on that computer is a server with no app beside it (Linux, FreeBSD): "not here" means its server is not running. */
    rex_headless?: true;
    /** With `rex_here` false: the Rex server there is another account's (a shared server), where agents never start. */
    rex_shared?: true;
    /** The agents that can start in Rex. */
    rex_agents?: string[];
    /** T3 Code's `t3` is on this computer (only in this computer's own Settings answer). */
    t3_here?: boolean;
    /** With `t3_here`: T3 Code is open now; new agents start in the background until it is. */
    t3_open?: boolean;
    /** The agents that can start in T3 Code. */
    t3_agents?: string[];
  }
}

/** Save the choice; the answer is the launch settings as they stand. */
export const launchStartIn = (startIn: 'inbox' | 'rex' | 't3') => post<{ launch: InboxLaunchSettings }>(inboxUrl('/launch/settings'), { start_in: startIn });
