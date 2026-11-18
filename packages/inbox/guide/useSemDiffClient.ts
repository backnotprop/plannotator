import { useEffect, useMemo, useRef } from 'react';
import { useConfigValue } from '@plannotator/ui/config';
import { parseSemDiffAdvert } from '@plannotator/review-editor/semDiff/protocol';
import { createSemDiffClient, type SemDiffClient } from '@plannotator/review-editor/semDiff/semDiffClient';
import { loadSemDiffWorker } from '@plannotator/review-editor/semDiff/loadSemDiffWorker';
import { semDiffAdvertNow, useSemDiffAdvert } from '../semDiffAdvert';

export function useSemDiffClient(): SemDiffClient | null {
  useSemDiffAdvert();
  const latched = useRef<{ value: unknown } | null>(null);
  if (!latched.current && semDiffAdvertNow() !== undefined) latched.current = { value: semDiffAdvertNow() };
  const raw = latched.current?.value ?? null;
  const enabled = useConfigValue('semanticDiffEnabled');
  const on = useConfigValue('diffSemantic');
  const wanted = useRef(false);
  if (on) wanted.current = true;
  const asked = wanted.current;
  const advert = useMemo(() => parseSemDiffAdvert(raw), [raw]);
  const client = useMemo(
    () => (advert && enabled && asked ? createSemDiffClient({ advert, origin: window.location.origin, createWorker: loadSemDiffWorker }) : null),
    [advert, enabled, asked],
  );
  useEffect(() => () => client?.dispose(), [client]);
  return client;
}
