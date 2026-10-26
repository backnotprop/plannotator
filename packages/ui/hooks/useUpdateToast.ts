import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { copyTextToClipboard } from '../utils/clipboard';
import { claimUpdateToast, describeUpdateToast, requestUpdateNow, type UpdateAdvert } from '../utils/updateNotice';

/** First look after the page settles: past the first-run announcements' own 4 s window. */
export const UPDATE_TOAST_DELAY_MS = 5_000;
/** While something blocks it (a first-run dialog, a focused composer), look again this often. */
const RETRY_MS = 5_000;
/** Give up for this load after this long; the next load (or the menu) says it. */
const GIVE_UP_MS = 120_000;

function isTypingSomewhere(): boolean {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || (el as HTMLElement).isContentEditable) return true;
  // An open dialog owns the screen; the toast waits for it.
  return !!el.closest('[role="dialog"], dialog[open]');
}

/**
 * The review windows' "a new version is out" toast (design §4.5): from the
 * server's advert only, at most once per version and once a day
 * (claimUpdateToast), queued behind the first-run dialogs (`blocked`) and
 * never while a composer or dialog has focus. A blocked attempt is not
 * consumed: it looks again, and gives up for this load after two minutes.
 *
 * Actions: What's new (the release on GitHub) and, for the binary the install
 * script manages, Update (POST /api/update runs it now); elsewhere Copy
 * command (the right command for the host).
 */
export function useUpdateToast(input: {
  advert: UpdateAdvert | null;
  /** A first-run dialog is showing or may still show this load. */
  blocked: boolean;
  /** Auto-update will install it; the post-update toast speaks instead. */
  autoUpdateActive: boolean;
  /** A share link or archive: nobody to tell. */
  suppressed?: boolean;
  position?: 'top-right' | 'bottom-right';
}): void {
  const blockedRef = useRef(input.blocked);
  blockedRef.current = input.blocked;
  const shown = useRef(false);
  const { advert, autoUpdateActive, suppressed, position } = input;

  useEffect(() => {
    if (!advert || autoUpdateActive || suppressed || shown.current) return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (blockedRef.current || isTypingSomewhere()) {
        if (Date.now() - started < GIVE_UP_MS) timer = setTimeout(attempt, RETRY_MS);
        return;
      }
      if (!claimUpdateToast(advert.version, Date.now())) return;
      shown.current = true;
      const { title, description, primary } = describeUpdateToast(advert);
      toast(title, {
        description,
        duration: 12_000,
        ...(position && { position }),
        closeButton: true,
        cancel: {
          label: "What's new",
          onClick: () => window.open(advert.releaseUrl, '_blank', 'noopener,noreferrer'),
        },
        action:
          primary === 'update'
            ? {
                label: 'Update',
                onClick: () => {
                  void requestUpdateNow().then((result) => {
                    if (!("error" in result)) {
                      toast(`Updating to ${result.version}…`, {
                        description: 'The install script runs in the background. This review keeps working.',
                        duration: 8_000,
                        ...(position && { position }),
                      });
                    } else {
                      toast("The update didn't start", { description: result.error, duration: 10_000, ...(position && { position }) });
                    }
                  });
                },
              }
            : {
                label: 'Copy command',
                onClick: () => {
                  void copyTextToClipboard(advert.command).then((copied) => {
                    if (copied) toast('Command copied', { description: advert.command, duration: 4_000, ...(position && { position }) });
                  });
                },
              },
        classNames: { toast: '!w-auto', description: '!text-foreground/70 select-text' },
      });
    };
    timer = setTimeout(attempt, UPDATE_TOAST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [advert, autoUpdateActive, suppressed, position]);
}
