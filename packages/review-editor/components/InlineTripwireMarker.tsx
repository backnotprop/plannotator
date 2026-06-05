/**
 * Amber warning badge injected into the diff gutter when a change touches a
 * slop-free zone (a tripwire). Rendered inside @pierre/diffs via the
 * DiffViewer's widget slot — clicking it scrolls to the tripwire in the
 * sidebar. Read-only: tripwires are informational and can't be edited.
 */
import React from 'react';
import { ShieldAlert } from 'lucide-react';

interface InlineTripwireMarkerProps {
  annotationId: string;
  note: string;
  onClick: (annotationId: string) => void;
}

export const InlineTripwireMarker: React.FC<InlineTripwireMarkerProps> = ({
  annotationId,
  note,
  onClick,
}) => {
  return (
    <button
      data-annotation-id={annotationId}
      onClick={() => onClick(annotationId)}
      className="tripwire-marker"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.375rem',
        padding: '0.1875rem 0.625rem',
        fontSize: '0.6875rem',
        border: 'none',
        background: 'none',
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
      }}
      title={note}
    >
      <ShieldAlert className="w-2.5 h-2.5 flex-shrink-0" />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {note}
      </span>
    </button>
  );
};
