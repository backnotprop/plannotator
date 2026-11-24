/**
 * Settings → Capabilities: the line of explanation under each switch's name, one source for this computer's rows
 * (Settings.tsx, scheduled/SettingsRow.tsx) and a linked computer's (LinkedCapabilities.tsx), so the two never differ.
 * A switch with no line here shows its name alone.
 */
import type { ReactNode } from 'react';
import type { InboxCapabilitySwitchKey } from '@plannotator/core/inbox-types';

export const CAPABILITY_LINES: Partial<Record<InboxCapabilitySwitchKey, ReactNode>> = {
  board:
    'A page of the work in flight, one card per piece, that your agents keep current. Off, there is no Board page and agents are not offered cards; every card is kept. Agents pick this up in their next session.',
  steps:
    "Your agents' plan for the work in a thread as a checklist, one step per line, under a button at the thread's foot. Off, agents are not offered a checklist and none shows; every checklist is kept. Agents pick this up in their next session.",
  scheduled_threads: 'Runs saved prompts on a schedule, on this computer, while the Inbox is running.',
  code_review: (
    <>
      Review your agents' code changes and your pull requests from GitHub and GitLab: type / in a reply to ask for a review, then approve it, send feedback to the agent, or post it on the pull request. Off, agents are not offered reviews and the review skills leave the / list; guided reviews and <code>plannotator review</code> work as before either way. Agents pick this up in their next session.
    </>
  ),
  chapter_diagrams: "Agents may add a diagram above a chapter's code.",
  system: "A drawing of each project's system, kept current by an agent when main moves. Shows while Code review is on. Off, none of it shows; every drawing is kept. Yours alone.",
  bro: (
    <>
      Agents write to your Inbox in plain words. Applies to new agent sessions. In open Claude Code sessions, run <code>/reload-plugins plannotator</code>.
    </>
  ),
  float_drafts: 'Keep an unsent reply in a small window in the corner when you leave its thread.',
};
