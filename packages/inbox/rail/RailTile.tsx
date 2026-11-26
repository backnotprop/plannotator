/**
 * One place on the project rail (PlaceRail.tsx) and on a phone's pin row (RailPinRow.tsx): its mark, its name (another
 * computer's under it), and what waits on the person there. The place on screen wears the sidebar's soft fill
 * (`--ib-cur-bg`), nothing on its edge.
 */
import type { ButtonHTMLAttributes, Ref } from 'react';
import { formatCount } from '../format';
import { Icon } from '../icons';
import { hueOf, LetterMark, projectLetters } from '../letterMarks';
import { TagIcon } from '../components/InitiativePeek';
import type { RailPlace } from './railModel';

/** The mark: a project's letters (letterMarks.tsx's tile, hued by the project), a tag's `#`, Inbox's tray. */
export function RailMark({ place }: { place: Pick<RailPlace, 'kind' | 'id' | 'name'> | 'inbox' }) {
  if (place === 'inbox')
    return (
      <span className="ib-rail-ibx" aria-hidden="true">
        <Icon name="inbox" size={16} />
      </span>
    );
  // The letters an agent's project tile takes (letterMarks.tsx `projectLetters`: "fern-api" FA, "harbor" HR).
  if (place.kind === 'project') return <LetterMark name={place.name} seed={place.id} letters={projectLetters(place.name)} size={30} />;
  return (
    <span className="ib-lm" data-size="30" data-hue={hueOf(place.id)} aria-hidden="true">
      <TagIcon size={15} />
    </span>
  );
}

type TileProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  place: Pick<RailPlace, 'kind' | 'id' | 'name' | 'machine' | 'count' | 'on'> | { kind: 'inbox'; name: string; machine: null; count: number; on: boolean };
  buttonRef?: Ref<HTMLButtonElement>;
};

export function RailTile({ place, buttonRef, className, ...rest }: TileProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`ib-rail-tile${className ? ` ${className}` : ''}`}
      aria-current={place.on ? 'page' : undefined}
      data-on={place.on ? '' : undefined}
      {...rest}
    >
      <span className="ib-rail-mk">
        <RailMark place={place.kind === 'inbox' ? 'inbox' : place} />
        {place.count > 0 && (
          <span className="ib-rail-n" aria-hidden="true" data-rail-count="">
            {formatCount(place.count)}
          </span>
        )}
      </span>
      <span className="ib-rail-l" dir="auto">
        {place.name}
      </span>
      {place.machine && (
        <span className="ib-rail-m" dir="auto">
          {place.machine}
        </span>
      )}
      {/* As the sidebar's rows and the title's picker say it. */}
      {place.count > 0 && <span className="ib-sr">, {formatCount(place.count)} waiting on you</span>}
    </button>
  );
}
