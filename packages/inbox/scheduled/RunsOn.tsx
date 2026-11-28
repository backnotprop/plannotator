/**
 * The editor's "Runs on this computer while the Inbox is running": which computer the routine lives and runs on. A
 * saved one names its computer ("Runs on Studio while the Inbox is running"); a new one, while more than one computer
 * can take routines (this one with Routines on, and each linked one with them on there), makes the name a quiet pick,
 * as the schedule's time zone is (`st-tz`). Picking another computer starts its folder over, since a folder is that
 * computer's.
 */
import { Icon } from '../icons';

/** A computer a routine can be made on: `id` null for this one. */
export interface RoutineHome {
  id: string | null;
  name: string;
}

export const THIS_COMPUTER = 'this computer';

export function RunsOn({ home, homes, onPick }: { home: RoutineHome; homes: readonly RoutineHome[]; onPick: ((next: RoutineHome) => void) | null }) {
  if (!onPick || homes.length < 2) return <span className="st-wrap">Runs on {home.name} while the Inbox is running</span>;
  return (
    <span className="st-wrap" data-scheduled-runs-on="">
      Runs on{' '}
      <label className="st-tz st-home">
        <span>{home.name}</span>
        <Icon name="chevD" size={12} />
        <select aria-label="Computer" value={home.id ?? ''} onChange={(event) => onPick(homes.find((h) => (h.id ?? '') === event.target.value) ?? home)}>
          {homes.map((h) => (
            <option key={h.id ?? ''} value={h.id ?? ''}>
              {h.name}
            </option>
          ))}
        </select>
      </label>{' '}
      while the Inbox is running
    </span>
  );
}
