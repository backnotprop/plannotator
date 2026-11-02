import type { CSSProperties } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import android from './panel-art/android.png';
import androidDark from './panel-art/android-dark.png';
import anvil from './panel-art/anvil.png';
import anvilDark from './panel-art/anvil-dark.png';
import astronaut from './panel-art/astronaut.png';
import astronautDark from './panel-art/astronaut-dark.png';
import blackhole from './panel-art/blackhole.png';
import blackholeDark from './panel-art/blackhole-dark.png';
import dividers from './panel-art/dividers.png';
import dividersDark from './panel-art/dividers-dark.png';
import keycap from './panel-art/keycap.png';
import keycapDark from './panel-art/keycap-dark.png';
import moon from './panel-art/moon.png';
import moonDark from './panel-art/moon-dark.png';
import newton from './panel-art/newton.png';
import newtonDark from './panel-art/newton-dark.png';
import pilot from './panel-art/pilot.png';
import pilotDark from './panel-art/pilot-dark.png';
import saturn from './panel-art/saturn.png';
import saturnDark from './panel-art/saturn-dark.png';
import sketchbook from './panel-art/sketchbook.png';
import sketchbookDark from './panel-art/sketchbook-dark.png';
import telescope from './panel-art/telescope.png';
import telescopeDark from './panel-art/telescope-dark.png';
import vacuumtube from './panel-art/vacuumtube.png';
import vacuumtubeDark from './panel-art/vacuumtube-dark.png';
import vise from './panel-art/vise.png';
import viseDark from './panel-art/vise-dark.png';
import voyager from './panel-art/voyager.png';
import voyagerDark from './panel-art/voyager-dark.png';

/**
 * The pieces, in the approved order: the owner asked for them spread out, so the helmets and faces never sit next to
 * each other (`.product/approved/inbox-thread-panel-art/`). Each is a mask at twice its drawn size, with a dark-mode
 * cut of its own; both are inlined by the single-file build, which the window's `img-src data:` allows.
 */
const PIECES = [
  { slug: 'keycap', light: keycap, dark: keycapDark },
  { slug: 'saturn', light: saturn, dark: saturnDark },
  { slug: 'anvil', light: anvil, dark: anvilDark },
  { slug: 'android', light: android, dark: androidDark },
  { slug: 'newton', light: newton, dark: newtonDark },
  { slug: 'moon', light: moon, dark: moonDark },
  { slug: 'sketchbook', light: sketchbook, dark: sketchbookDark },
  { slug: 'pilot', light: pilot, dark: pilotDark },
  { slug: 'vacuumtube', light: vacuumtube, dark: vacuumtubeDark },
  { slug: 'blackhole', light: blackhole, dark: blackholeDark },
  { slug: 'vise', light: vise, dark: viseDark },
  { slug: 'voyager', light: voyager, dark: voyagerDark },
  { slug: 'dividers', light: dividers, dark: dividersDark },
  { slug: 'astronaut', light: astronaut, dark: astronautDark },
  { slug: 'telescope', light: telescope, dark: telescopeDark },
];

/**
 * What the thread panel shows with no thread open (threadPanel.ts): one piece, a click on it the next. `piece` is held
 * by the caller, because this panel unmounts while a thread is open and the rotation outlives that. Nothing is saved:
 * the Inbox opens on the keycap. A plain button, so Tab, Enter and Space work with no shortcut of its own.
 */
export function EmptyThreadPanel({ piece, onPiece }: { piece: number; onPiece: (next: number) => void }) {
  const { resolvedMode } = useTheme();
  const art = PIECES[piece % PIECES.length]!;
  const mask = resolvedMode === 'light' ? art.light : art.dark;
  return (
    <>
      <button
        type="button"
        className="ib-pempty-art"
        aria-label="Show another picture"
        data-piece={art.slug}
        onClick={() => onPiece((piece + 1) % PIECES.length)}
      >
        <span className="ib-pempty-piece" style={{ '--ib-pempty-mask': `url("${mask}")` } as CSSProperties} />
      </button>
      <p>No thread selected</p>
    </>
  );
}
