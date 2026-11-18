/** Settings → Agents' "Start new agents in" (packages/server/inbox-launch.ts `settingsState`): its fields and its save. */
import { post, type InboxLaunchSettings } from '../../api';
import { inboxUrl } from '../../inboxUrl';

declare module '../../api' {
  interface InboxLaunchSettings {
    /** Where new agents start: the Inbox (in the background) or Rex. Absent from an older Inbox. */
    start_in?: 'inbox' | 'rex';
    /** Rex's app is attached on this computer now (only in this computer's own Settings answer). */
    rex_here?: boolean;
    /** The agents that can start in Rex. */
    rex_agents?: string[];
  }
}

/** Save the choice; the answer is the launch settings as they stand. */
export const launchStartIn = (startIn: 'inbox' | 'rex') => post<{ launch: InboxLaunchSettings }>(inboxUrl('/launch/settings'), { start_in: startIn });
