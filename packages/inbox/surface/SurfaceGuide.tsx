import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { parseGuideSnapshot } from '@plannotator/core/guide-format';
import type { SurfaceOpenGuide } from '@plannotator/core/inbox-types';
import { postToShell } from './bridge';

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
