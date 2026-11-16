/**
 * Playback speed for a video or a recording: a small "1x" button that opens a
 * short list of speeds (1x, 1.2x, 1.5x, 1.7x, 2x). The film's button sits in
 * the native control bar's row, left of its volume button, and comes and goes
 * with those controls (paused, or the pointer over the film); its list opens
 * upward. The recording's sits after its time.
 *
 * The speed picked holds for every video and recording opened in this tab
 * until it closes (sessionStorage), so a person who watches at 1.5x does not
 * pick it again for each file. A speed set from the browser's own player menu
 * shows here too.
 */
import { Menu } from '@base-ui/react/menu';
import { Icon } from '../icons';

export const PLAYBACK_RATES = [1, 1.2, 1.5, 1.7, 2] as const;

export const PLAYBACK_RATE_KEY = 'plannotator-inbox-playback-rate';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function sessionStore(): Store | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** A usable speed: a finite number the browser plays at (it refuses past 16x). */
function validRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > 0 && rate <= 16;
}

/** The speed picked earlier in this tab, else 1. */
export function readPlaybackRate(store: Store | null = sessionStore()): number {
  try {
    const rate = Number(store?.getItem(PLAYBACK_RATE_KEY));
    return validRate(rate) ? rate : 1;
  } catch {
    return 1;
  }
}

/** Remember a speed for the rest of this tab's life. */
export function writePlaybackRate(rate: number, store: Store | null = sessionStore()): void {
  if (!validRate(rate)) return;
  try {
    store?.setItem(PLAYBACK_RATE_KEY, String(rate));
  } catch {
    // Storage full or blocked: the speed still holds for this file.
  }
}

/** "1x", "1.2x", "0.75x". */
export function formatPlaybackRate(rate: number): string {
  return `${Number(rate.toFixed(2))}x`;
}

export function PlaybackSpeed({ rate, onRate, side, className }: { rate: number; onRate: (rate: number) => void; side: 'top' | 'bottom'; className?: string }) {
  const label = formatPlaybackRate(rate);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger className={`ib-speed${className ? ` ${className}` : ''}`} aria-label={`Playback speed, ${label}`} data-playback-speed={rate}>
        {label}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="ib-pm-pos" side={side} align="end" sideOffset={6}>
          <Menu.Popup className="ib-pm ib-speed-menu" aria-label="Playback speed" data-playback-speed-menu="">
            <Menu.RadioGroup value={rate} onValueChange={(next: number) => onRate(next)}>
              {PLAYBACK_RATES.map((value) => (
                <Menu.RadioItem key={value} value={value} closeOnClick className="ib-pmi" label={formatPlaybackRate(value)} data-playback-rate={value}>
                  {value === rate ? <Icon name="check" size={13} /> : <span className="ib-pmi-slot" aria-hidden="true" />}
                  {formatPlaybackRate(value)}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
