import React from 'react';
import type { TouchSelectionOffer } from '../hooks/useAnnotationHighlighter';
import { getRichCopyEnabled } from '../utils/richCopyPolicy';
import { AnnotationToolbar } from './AnnotationToolbar';

/** The props a host gives its painted selection toolbar; the offer's takes the same. */
type SharedToolbarProps = Pick<
  React.ComponentProps<typeof AnnotationToolbar>,
  'commentOnly' | 'showDelete' | 'selectionActions' | 'selectionActionsIcon' | 'onSide' | 'sideButton' | 'quickLabels'
>;

/**
 * The selection toolbar of a text selection made with a finger
 * (`useAnnotationHighlighter`'s `touchSelectionOffer`): the toolbar a painted
 * selection gets, drawn above the selection, clear of the system's edit menu,
 * while the selection is still the system's.
 * Nothing is painted until a button is tapped, so the person can drag the
 * selection's handles; a button then takes the selection and does what it does
 * on a painted one. Comment mode has no Delete and no labels, so its toolbar
 * offers Comment alone. A host that passes `AnnotationToolbar` props to its
 * painted toolbar passes the same here.
 */
export const TouchSelectionToolbar: React.FC<{ offer: TouchSelectionOffer } & SharedToolbarProps> = ({
  offer,
  commentOnly,
  ...shared
}) => (
  <AnnotationToolbar
    {...shared}
    element={offer.element}
    positionMode="center-above"
    unpainted
    touchAnchorRect={offer.getAnchorRect}
    commentOnly={commentOnly || offer.mode === 'comment' || undefined}
    copyText={offer.selectionText}
    getRichCopy={getRichCopyEnabled() ? offer.getRichCopy : undefined}
    onAnnotate={offer.onAnnotate}
    onRequestComment={offer.onRequestComment}
    onQuickLabel={offer.mode === 'comment' ? undefined : offer.onQuickLabel}
    onClose={offer.onClose}
  />
);
