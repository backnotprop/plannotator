/**
 * The words of the version line above a file opened beside a thread, and of
 * full screen's changed chip (its tooltip and its link): one source, so the
 * two never say different things. Wording approved by the owner, 2026-11-18
 * (the agent's file, captured when sent); the person's own file and a copy
 * taken on first open follow the same pattern.
 */
export interface VersionLineWords {
  /** The sentence: which version is on screen, and when the other one is from. */
  sentence: string;
  /** The link to the other version; null when only one can open. */
  link: { label: string; to: 'current' | 'sent' } | null;
}

export interface VersionLineFacts {
  /** The current file cannot be read: its reason (`unavailable.message`), and the sent copy shows. */
  unavailable: string | null;
  /** Which version is on screen. */
  version: 'current' | 'sent';
  /** The file changed on disk since it was sent (or first opened). */
  changed: boolean;
  /** Its copy was taken the first time the thread was read, not when it was sent. */
  onOpen: boolean;
  /** The person's own message holds the file. */
  fromPerson: boolean;
  /** The agent's name. */
  agent: string;
  /** When it was sent, as the pane writes a time. */
  sentAt: string;
  /** When the copy was taken on first open. */
  firstOpened: string;
  /** When the current file was last edited; null when unknown. */
  editedAt: string | null;
}

/** The line's words, or null when there is nothing to say (the current file, unchanged). */
export function versionLineWords(f: VersionLineFacts): VersionLineWords | null {
  const sender = f.fromPerson ? 'you' : f.agent;
  if (f.unavailable !== null) {
    return {
      sentence: `${f.unavailable} ${f.onOpen ? `This is the copy taken when you first opened it, ${f.firstOpened}.` : `This is the version ${sender} sent at ${f.sentAt}.`}`,
      link: null,
    };
  }
  if (f.version === 'sent') {
    return {
      sentence: f.onOpen ? `Viewing the copy taken when you first opened it, ${f.firstOpened}.` : `Viewing the version ${sender} sent at ${f.sentAt}.`,
      link: { label: 'View current file', to: 'current' },
    };
  }
  if (!f.changed) return null;
  const edited = f.editedAt ? ` (edited ${f.editedAt})` : '';
  const earlier = f.onOpen
    ? `You first opened an earlier version at ${f.firstOpened}.`
    : `${f.fromPerson ? 'You' : f.agent} sent an earlier version at ${f.sentAt}.`;
  return {
    sentence: `Viewing the current file${edited}. ${earlier}`,
    link: { label: f.onOpen ? 'View the version you first saw' : 'View sent version', to: 'sent' },
  };
}
