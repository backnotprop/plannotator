import { useState } from 'react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@plannotator/ui/components/ui/dropdown-menu';
import { Icon } from '../icons';
import { artifactPinnable, setArtifactPinned, useArtifactPins } from '../artifactPins';
import { Tip } from './Tip';

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
  name: string;
  surface: 'card' | 'bar' | 'wall';
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
