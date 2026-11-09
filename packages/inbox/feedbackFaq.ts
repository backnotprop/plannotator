/**
 * Feedback → Common questions (components/FeedbackDialog.tsx, approval "inbox-feedback-faq"): the questions people
 * write in about most, each with its answer, and at most one action and one link. Edit the words here; the dialog
 * draws them in this order.
 *
 * An action runs the setting the Inbox already has (the window wires each kind in App.tsx): `simple-list` is the
 * list's ⋮ menu → View → Simple list (listView.ts); `settings-rows` and `settings-devices` open those Settings
 * sections. A link opens in a new tab: real release notes or docs only.
 */

export type FeedbackFaqAction = 'simple-list' | 'settings-rows' | 'settings-devices';

export interface FeedbackFaqItem {
  /** Stable id, for the open item and tests. */
  id: string;
  question: string;
  answer: string;
  action?: { kind: FeedbackFaqAction; label: string };
  link?: { label: string; href: string };
}

const RELEASE = 'https://github.com/backnotprop/plannotator/releases/tag/';

export const FEEDBACK_FAQ: readonly FeedbackFaqItem[] = [
  {
    id: 'list-moves',
    question: 'The list moves while I’m reading it',
    answer:
      'Fixed in 0.28.52. New messages wait behind “N new · Show” at the top of the list, so rows only move when you ask. The row you open stays where it is. Want no groups at all? Use Simple list: one list, newest first.',
    action: { kind: 'simple-list', label: 'Use Simple list' },
    link: { label: 'What changed in 0.28.52', href: `${RELEASE}v0.28.52` },
  },
  {
    id: 'simple-list',
    question: 'Can I have one plain list instead of groups?',
    answer: 'Yes. ⋮ above the list → View → Simple list. Same rows and badges, newest first. Smart groups stay one click away.',
    action: { kind: 'simple-list', label: 'Use Simple list' },
  },
  {
    id: 'rows',
    question: 'Rows show too much, or too little',
    answer:
      'Settings → Rows has three looks, Minimal, Balanced and Detailed, and you can fine-tune density, the preview and the time. Your choice follows you to every browser.',
    action: { kind: 'settings-rows', label: 'Open Settings → Rows' },
  },
  {
    id: 'done',
    question: 'How do I mark a thread done?',
    answer: 'Archive it from the thread’s ⋯ menu. It comes back by itself if the agent writes again, and Unarchive reopens it.',
    link: { label: 'Inbox docs', href: 'https://plannotator.ai/docs/reference/inbox/#what-you-see' },
  },
  {
    id: 'phone',
    question: 'Can I use the Inbox on my phone?',
    answer: 'Yes, over your tailnet: open the address from Settings → Devices on your phone.',
    action: { kind: 'settings-devices', label: 'Open Settings → Devices' },
  },
];
