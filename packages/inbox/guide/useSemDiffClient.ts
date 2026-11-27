import { useEffect, useMemo, useRef } from 'react';
import { useConfigValue } from '@plannotator/ui/config';
import { parseSemDiffAdvert } from '@plannotator/review-editor/semDiff/protocol';
import { createSemDiffClient, type SemDiffClient } from '@plannotator/review-editor/semDiff/semDiffClient';
import { loadSemDiffWorker } from '@plannotator/review-editor/semDiff/loadSemDiffWorker';
import { semDiffAdvertNow, useSemDiffAdvert } from '../semDiffAdvert';
import { useReviewAnalysisRead } from '../reviewAnalysis';

export function useSemDiffClient(): SemDiffClient | null {
  useSemDiffAdvert();
  // Code review's "Semantic changes" switch, once config.json's value is in (reviewAnalysis.ts): off, no client.
  const switchOn = useConfigValue('semanticDiffEnabled');
  const enabled = useReviewAnalysisRead() && switchOn;
  const on = useConfigValue('diffSemantic');
  const wanted = useRef(false);
  const latched = useRef<{ value: unknown } | null>(null);
  const now = semDiffAdvertNow();
  const unused = !enabled || !wanted.current;
  if (now !== undefined && (!latched.current || (latched.current.value == null && now != null && unused))) latched.current = { value: now };
  if (on) wanted.current = true;
  const asked = wanted.current;
  const raw = latched.current?.value ?? null;
  const advert = useMemo(() => parseSemDiffAdvert(raw), [raw]);
  const client = useMemo(
    () => (advert && enabled && asked ? createSemDiffClient({ advert, origin: window.location.origin, createWorker: loadSemDiffWorker }) : null),
    [advert, enabled, asked],
  );
  useEffect(() => () => client?.dispose(), [client]);
  return client;
}
