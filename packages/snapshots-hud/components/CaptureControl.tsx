import type { KeyboardEvent } from 'react';
import type { SnapshotsCaptureMode } from '@plannotator/shared/snapshots/types';
import { Icon } from '../icons';

const MODES: Record<SnapshotsCaptureMode, { name: string; short: string; go: string; help: string; icon: 'region' | 'appCapture' }> = {
  screen: {
    name: 'Screen Capture',
    short: 'Screen',
    go: 'New Screen Capture (⌥⇧⌘4)',
    help: 'Screen Capture: drag a box (Space for a window, F for the screen). Picture only. (⌥⇧⌘4)',
    icon: 'region',
  },
  app: {
    name: 'App Capture',
    short: 'App',
    go: 'New App Capture: click a window (⌥⇧⌘5 takes the front one)',
    help: 'App Capture: click a window to take it with its text, for the agent to read. (⌥⇧⌘5 takes the front window)',
    icon: 'appCapture',
  },
};

/**
 * Start a new snapshot, and choose which kind: a + button and a two-segment
 * toggle (Screen / App). The toggle is remembered (hub setting `captureMode`)
 * and decides what + takes; it never captures by itself.
 */
export function CaptureControl(props: { mode: SnapshotsCaptureMode; onMode: (mode: SnapshotsCaptureMode) => void; onCapture: () => void }) {
  const current = MODES[props.mode];
  const order: SnapshotsCaptureMode[] = ['screen', 'app'];
  // A radio group moves with the arrow keys; the HUD's own arrow keys (previous / next snapshot) stay out of it.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    event.stopPropagation();
    const next = props.mode === 'screen' ? 'app' : 'screen';
    props.onMode(next);
    (event.currentTarget.parentElement?.querySelector(`[data-mode="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="cap" role="group" aria-label="New snapshot">
      <button type="button" className="cap-go" onClick={props.onCapture} aria-label={`New ${current.name}`} title={current.go}>
        <Icon name="plus" />
      </button>
      <div className="cap-seg" role="radiogroup" aria-label="Capture mode">
        {order.map((mode) => {
          const item = MODES[mode];
          const checked = props.mode === mode;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={item.name}
              tabIndex={checked ? 0 : -1}
              data-mode={mode}
              className={checked ? 'on' : undefined}
              title={item.help}
              onClick={() => props.onMode(mode)}
              onKeyDown={onKeyDown}
            >
              <Icon name={item.icon} size={14} />
              <span>{item.short}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The native capture kind for a mode: App opens the overlay on picking a window (with its text). */
export function captureKindFor(mode: SnapshotsCaptureMode): 'region' | 'app-pick' {
  return mode === 'app' ? 'app-pick' : 'region';
}
