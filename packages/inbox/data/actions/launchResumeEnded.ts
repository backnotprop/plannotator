/** Settings → Agents' "Replies to an ended session resume it" (packages/server/inbox-launch.ts `settingsState`): its fields and its save. */
import { post, type InboxLaunchSettings } from '../../api';
import { inboxUrl } from '../../inboxUrl';

declare module '../../api' {
  interface InboxLaunchSettings {
    /** The reply box picks "Resume this <agent> session" by default for an ended session. Absent from an older Inbox. */
    resume_ended?: boolean;
    /** The agents that resume a session the Inbox never started (the switch applies to them only). */
    resume_agents?: string[];
  }
}

/** Save the switch; the answer is the launch settings as they stand. */
export const launchResumeEnded = (on: boolean) => post<{ launch: InboxLaunchSettings }>(inboxUrl('/launch/settings'), { resume_ended: on });
