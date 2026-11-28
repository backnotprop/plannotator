/** A list row's tag colour (approval "inbox-thread-tags", step 3, look C): the tint's attributes and the tag's name on the row. */
import type { ReactNode } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { rowTintTitle, tintAttrs, type RowTint } from '../tagColours';

/** What the list needs for tag colours: the ⋮'s switch and each row's tint. */
export interface ListTagColours {
  show: boolean;
  /** Absent where the list carries no switch (a phone): the ⋮ has no item. */
  setShow?: (on: boolean) => void;
  tintOf: (row: Pick<InboxListRow, 'thread_id' | 'tags' | 'machine'>) => RowTint | null;
  /** The same by thread id, for search's results: null for a thread the list does not hold. */
  tintOfThread?: (threadId: string) => RowTint | null;
}

/** A row's tint as ListRow takes it: strings only, so a row whose tint did not change is not drawn again (its memo). */
export interface RowTintFields {
  /** Its tag colour (tagColours.ts `rowTint`): a preset or `#rrggbb`; absent, the row looks as usual. */
  tint?: string;
  /** The tag the colour comes from, named on the row. */
  tintName?: string;
  /** The row's other coloured tags, one per line (a tag's name holds no line break): "+1" on the row, named in the name's tooltip. */
  tintAlso?: string;
}

/** A row shape's share: the colour and the tag's name drawn for it. */
export interface RowTintProps {
  tint?: string;
  tagName: ReactNode;
}

export function rowTintOf(colours: ListTagColours | undefined, row: InboxListRow): RowTintFields {
  const tint = colours?.tintOf(row) ?? null;
  if (!tint) return {};
  return { tint: tint.colour, tintName: tint.name, tintAlso: tint.also.length > 0 ? tint.also.join('\n') : undefined };
}

export function sameTint(a: RowTintFields, b: RowTintFields): boolean {
  return a.tint === b.tint && a.tintName === b.tintName && a.tintAlso === b.tintAlso;
}

/** A tinted row's attributes (threadTags.css), on the row's button. */
export function tintProps(tint: string | undefined): { 'data-tint'?: string } {
  return tint ? tintAttrs(tint) : {};
}

/** The tag a tinted row names (look C): quiet, cut with "…", "+1" for each other coloured tag; null on a plain row. */
export function RowTagName({ tint, tintName, tintAlso }: RowTintFields) {
  if (!tint || !tintName) return null;
  const others = tintAlso ? tintAlso.split('\n') : [];
  return (
    <span className="ib-rtag" dir="auto" title={rowTintTitle({ colour: tint, name: tintName, also: others })} data-row-tag="">
      <span className="ib-rtag-n">{tintName}</span>
      {others.length > 0 && <span className="ib-rtag-more"> +{others.length}</span>}
    </span>
  );
}
