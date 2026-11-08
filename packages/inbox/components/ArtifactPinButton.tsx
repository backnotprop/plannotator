/**
 * Pin / Unpin one artifact (approval "inbox-artifact-stars"; the word is Pin):
 * on an Artifacts card (shown on hover, and always once pinned), in the file
 * viewer's bar, and on a picture of the Artifacts wall. The icon set's pin,
 * outlined when not pinned and filled when pinned, in a quiet colour (never
 * the thread stars' amber).
 */

import { useState } from 'react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@plannotator/ui/components/ui/dropdown-menu';
import { Icon } from '../icons';
import { artifactPinnable, setArtifactPinned, useArtifactPins } from '../artifactPins';
import { Tip } from './Tip';

/**
 * How the pin looks, in one place (the owner's pick from
 * /tmp/artifact-pins/build-shots/pin-look): `tilted` (B, the pin turned 45°,
 * filled in ink), `upright` (A, standing, filled in the muted grey) or `chip`
 * (C, standing, filled on a small muted chip). inbox.css draws each.
 */
export const ARTIFACT_PIN_LOOK: 'tilted' | 'upright' | 'chip' = 'tilted';

export function ArtifactPinButton({
  threadId,
  artifactKey,
  name,
  surface,
  big = false,
}: {
  threadId: string;
  artifactKey: string;
  /** The artifact's name: "Pin checkout-a.png". */
  name: string;
  surface: 'card' | 'bar' | 'wall';
  /** A phone's viewer bar: a 44 px target. */
  big?: boolean;
}) {
  const { byKey } = useArtifactPins();
  const [pop, setPop] = useState(0);
  if (!artifactPinnable(threadId)) return null;
  const pinned = byKey.has(artifactKey);
  const verb = pinned ? 'Unpin' : 'Pin';
  return (
    <Tip content={verb}>
      <button
        type="button"
        className={`ib-apin ib-apin-${surface}${pinned ? ' ib-apin-on' : ''}${big ? ' ib-apin-big' : ''}`}
        data-look={ARTIFACT_PIN_LOOK}
        aria-label={`${verb} ${name}`}
        aria-pressed={pinned}
        data-artifact-pin={artifactKey}
        data-pop={pop > 0 && pinned ? pop : undefined}
        onClick={(event) => {
          // On a card the pin sits over the tile: the press is the pin's, never the tile's.
          event.preventDefault();
          event.stopPropagation();
          if (!pinned) setPop((n) => n + 1);
          void setArtifactPinned(threadId, artifactKey, !pinned);
        }}
      >
        <Icon key={pinned ? `on-${pop}` : 'off'} name="pin" size={big ? 20 : 16} />
      </button>
    </Tip>
  );
}

/**
 * Pin / Unpin as an item of full screen's ⋯ (OpenIn.tsx `FullScreenMore`): a phone's HTML page, whose toolbar
 * shares its row with the reply and has no room for one more 44 px button at 320 px. The same pin as the bar's,
 * then a separator before the menu's other items. Nothing for a thread that cannot pin (the tour).
 */
export function ArtifactPinMenuItem({ threadId, artifactKey, name }: { threadId: string; artifactKey: string; name: string }) {
  const { byKey } = useArtifactPins();
  if (!artifactPinnable(threadId)) return null;
  const pinned = byKey.has(artifactKey);
  const verb = pinned ? 'Unpin' : 'Pin';
  return (
    <>
      <DropdownMenuItem
        className="text-xs"
        aria-label={`${verb} ${name}`}
        data-artifact-pin-item={artifactKey}
        data-pinned={pinned ? '' : undefined}
        onClick={() => void setArtifactPinned(threadId, artifactKey, !pinned)}
      >
        <Icon name="pin" size={15} className="ib-appi ib-glyph" />
        <span className="flex-1">{verb}</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}
