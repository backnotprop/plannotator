/**
 * What a host hands the reply box (ReplyBox.tsx) beside its words store: who can get the reply, its skills and its
 * voice. Plain data and callbacks: the box fetches nothing, keeps nothing at module level and loads no voice code of
 * its own (the voice parts come in through `ReplyBoxVoice.parts`, from the voice entry, replyVoice.ts). The Inbox's
 * own wiring is in Thread.tsx.
 */
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import type { ComposerCommand } from '../ComposerField';
import type { VoiceMicButton, VoiceNote, VoiceStatusLine } from '../VoiceMic';
import type { RecipientRow } from '../../replyRecipients';
import type { SessionLabels } from '../../sessionLabels';
import type { VoiceHandle } from '../../voice';

/** Who gets the reply, when several agents could: the computer's chip at the start of the words, a phone's pill in the row. */
export interface ReplyBoxRecipients {
  /** Every agent the list offers, live first, ended last. */
  rows: readonly RecipientRow[];
  /** Who gets the reply now, the one it answers first (one typed with `@` included). */
  chosen: readonly RecipientRow[];
  open: boolean;
  onOpen: (open: boolean) => void;
  /** Who gets the reply from now on (ids, the one it answers first): a row picked alone, or a row ticked in or out. */
  onChange: (to: readonly string[]) => void;
  /**
   * The most agents one reply goes to. 1: the list picks one, a row's circle only shows the choice. Unset: as many as
   * a draft holds (`RECIPIENTS_MAX`), as in the Inbox.
   */
  maxRecipients?: number;
  /** Who gets it once `row` is ticked in or out (the Inbox counts its typed tags). Absent: `row` in or out of `chosen`. */
  toggle?: (row: RecipientRow) => readonly string[];
  /** The list's last row, "Tag another agent". Absent: none. */
  onTagAnother?: () => void;
  /** Remove a row's agent from the thread (a row with `removable`). Absent: no Remove. */
  onRemove?: (row: RecipientRow) => void;
  /** Each session's title, where it has one. */
  labels?: SessionLabels;
  /** The folder a session works in. */
  folderOf?: (session: string) => string;
  /** A phone: the pane its sheet is drawn in. */
  section?: HTMLElement | null;
}

/** The reply's skills: the button in the row and the list a `/` opens. Absent from the box: neither shows. */
export interface ReplyBoxSkills {
  /** The button: open the list at the caret. */
  onOpen: () => void;
  /** "No skills are installed" shows in the row (the button found none). */
  noneHint: boolean;
  /** Which skills the list offers and paints. Keep its identity stable. */
  filter?: (entry: SkillCatalogEntry) => boolean;
  /** The host's own commands, listed with the skills. Keep its identity stable. */
  commands?: readonly ComposerCommand[];
}

/** The reply's voice. Absent from the box: no microphone, no voice line, and no voice code loaded. */
export interface ReplyBoxVoice {
  /** The box's voice session; `others.busy`: another take Send waits for (an Other answer's on a question card). */
  handle: VoiceHandle & { others: { busy: boolean } };
  /** What draws it, from the voice entry (components/reply/replyVoice.ts `replyVoiceParts`). */
  parts: ReplyVoiceParts;
}

/** The voice entry's parts: the row's microphone and status line, and the note in the field. */
export interface ReplyVoiceParts {
  MicButton: typeof VoiceMicButton;
  StatusLine: typeof VoiceStatusLine;
  Note: typeof VoiceNote;
}
