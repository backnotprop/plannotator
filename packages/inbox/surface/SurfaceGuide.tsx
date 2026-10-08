/**
 * A guided review in the surface (6.1, 6.2): the sections with their
 * reviewed ticks and Continue, then one section per screen with Previous,
 * Reviewed and Next. The reader (the guide chain over review-editor's diff
 * renderer) mounts through a dynamic import, as the Inbox window's does.
 * Ticks go to the shell, which saves them through the door.
 */

import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { parseGuideSnapshot } from '@plannotator/core/guide-format';
import type { SurfaceOpenGuide } from '@plannotator/core/inbox-types';
import { postToShell } from './bridge';

// `#surface-guide-reader` is packages/inbox/guide/SurfaceGuideReader.tsx (package.json `imports`).
const SurfaceGuideReader = lazy(() => import('#surface-guide-reader'));

interface Props {
  open: SurfaceOpenGuide;
  section: number | null;
  onSection: (section: number | null, sections: number) => void;
}

export function SurfaceGuide({ open, section, onSection }: Props) {
  const parsed = useMemo(() => parseGuideSnapshot(open.snapshot), [open.snapshot]);
  const [reviewed, setReviewed] = useState<boolean[]>(() => open.reviewed ?? []);

  useEffect(() => {
    if (!parsed.ok) postToShell({ type: 'error', code: 'guide_invalid', message: `${parsed.error.path}: ${parsed.error.message}` });
  }, [parsed]);

  if (!parsed.ok) return null;
  return (
    <div className="sf-guide" data-surface-guide={open.message_id}>
      <Suspense fallback={null}>
        <SurfaceGuideReader
          snapshot={parsed.value}
          reviewed={reviewed}
          onReviewedChange={(next) => {
            setReviewed(next);
            postToShell({ type: 'reviewed', message_id: open.message_id, reviewed: next });
          }}
          section={section}
          onSection={onSection}
        />
      </Suspense>
    </div>
  );
}
