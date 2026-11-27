/**
 * Settings → Reviews in the window's own chunk: whether it is listed, and its body, which draws the page
 * (ReviewsSettings.tsx) from its own chunk (`#reviews-settings`, lazyParts.tsx); one that cannot arrive says so here.
 */
import { useEffect } from 'react';
import { PanePart, ReviewsSettingsPart } from '../lazyParts';
import type { SettingsModel } from '../api';

/** Listed while Code review is on (its address opens either way); its chunk is asked for as soon as it is. */
export function useReviewsShown(settings: SettingsModel | null): boolean {
  const shown = settings?.code_review?.on === true;
  useEffect(() => {
    if (shown) void ReviewsSettingsPart.preload().catch(() => {});
  }, [shown]);
  return shown;
}

export function ReviewsSection({ phone }: { phone: boolean }) {
  return (
    <PanePart loading={<div className="ib-skel" aria-hidden="true" />} onFailed={ReviewsSettingsPart.retry}>
      <ReviewsSettingsPart.Part phone={phone} />
    </PanePart>
  );
}
