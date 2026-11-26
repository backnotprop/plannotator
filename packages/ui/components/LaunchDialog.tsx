import { useRef } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { DialogDescription, DialogTitle } from './ui/dialog';
import { AnnouncementShell, type AnnouncementSize } from './InboxAnnouncementDialog';
import { LAUNCH_ART_ALT, LAUNCH_DIALOG_WORDS, launchArtUrl } from '../utils/launchDialogWords';

/**
 * The launch dialog (the launch switch, packages/shared/launch-switch.ts): once per computer, on plan review, code
 * review, annotate and the Inbox. Loaded only when a claim says it shows (LaunchAnnouncement.tsx), so it adds nothing
 * to a page's first paint.
 *
 * The Inbox announcement's shell (InboxAnnouncementDialog `AnnouncementShell`): the shared dialog (Base UI), modal,
 * focus trapped and restored on close, focus starting on "See the launch", Escape and Mod+Enter taken on the capture
 * phase. 720 wide (LAUNCH_DIALOG_SIZE), the full width on a phone, narrower on a short window so it never scrolls. An
 * art band on top (16:9) edge to edge under the rounded top corners with a hairline below it, then the title, the line
 * and two buttons side by side, right-aligned (the owner's pick, c2c). No close button: "Not now", Escape and the
 * backdrop close it.
 *
 * `art`: the host already loaded the picture (or gave up on it) before opening, so the dialog is drawn once, with its
 * band or with its words alone, and its layout never changes while it is read.
 *
 * "See the launch" is a plain link from the person's click (new tab, rel noopener) and answers `opened`; "Not now",
 * Escape and the backdrop answer `dismissed`. No keyboard shortcut of its own.
 */

export type LaunchDialogAnswer = 'opened' | 'dismissed';

/** 720 wide (art band 720×405); 13rem is the words and buttons. */
export const LAUNCH_DIALOG_SIZE: AnnouncementSize = { width: 720, footerRem: 13 };

export interface LaunchDialogProps {
  readonly campaign: string;
  /** The launch page (the switch's url, already checked by the server's parser). */
  readonly url: string;
  /** The art band: true when the host preloaded the art in time; false, the words alone. */
  readonly art: boolean;
  /** Called once, with how it ended; the host closes it. */
  readonly onAnswer: (answer: LaunchDialogAnswer) => void;
}

export function LaunchDialog({ campaign, url, art, onAnswer }: LaunchDialogProps) {
  const openRef = useRef<HTMLAnchorElement>(null);
  const answered = useRef(false);
  const onAnswerRef = useRef(onAnswer);
  onAnswerRef.current = onAnswer;
  const answer = (how: LaunchDialogAnswer) => {
    if (answered.current) return;
    answered.current = true;
    onAnswerRef.current(how);
  };

  const artSrc = art ? launchArtUrl(campaign) : null;
  const button = 'min-h-10 text-sm';

  return (
    <AnnouncementShell
      onClose={() => answer('dismissed')}
      initialFocus={openRef}
      size={LAUNCH_DIALOG_SIZE}
      media={artSrc ? <img src={artSrc} alt={LAUNCH_ART_ALT} width={1120} height={630} referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" /> : undefined}
      data-launch-dialog
      data-launch-art={artSrc ? 'ready' : 'gone'}
    >
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 pb-5 pt-5 sm:gap-6 sm:px-7 sm:pb-6 sm:pt-7">
        <div className="min-w-0">
          <DialogTitle className="text-balance text-xl font-semibold tracking-tight">{LAUNCH_DIALOG_WORDS.title}</DialogTitle>
          <DialogDescription className="mt-1.5 text-pretty leading-relaxed">{LAUNCH_DIALOG_WORDS.line}</DialogDescription>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            data-launch-not-now
            onClick={() => answer('dismissed')}
            className={`flex-1 whitespace-nowrap rounded-lg border border-border px-4 font-medium ${button} text-foreground outline-none transition-colors motion-reduce:transition-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card sm:flex-none sm:px-5`}
          >
            {LAUNCH_DIALOG_WORDS.notNow}
          </button>
          <a
            ref={openRef}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            data-launch-open
            // Answered on the next task: a link removed from the page during its own click is not followed.
            onClick={() => {
              setTimeout(() => answer('opened'), 0);
            }}
            className={`inline-flex flex-1 items-center whitespace-nowrap justify-center gap-1.5 rounded-lg bg-primary px-5 font-medium ${button} text-primary-foreground outline-none transition-opacity motion-reduce:transition-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card sm:flex-none sm:px-6`}
          >
            {LAUNCH_DIALOG_WORDS.open}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </a>
        </div>
      </div>
    </AnnouncementShell>
  );
}

export default LaunchDialog;
