import {
  StickyHeaderLane,
  type StickyHeaderLaneProps,
  type StickyHeaderLaneVisibility,
} from '@plannotator/ui/components/StickyHeaderLane';

/** Compile-only proof that the published subpath exposes both host seams. */
export function PublishedStickyHeaderLaneConsumer(
  props: Omit<StickyHeaderLaneProps, 'visibility' | 'sticky'>,
) {
  const visibility: StickyHeaderLaneVisibility = 'always';
  return <StickyHeaderLane {...props} visibility={visibility} sticky={false} />;
}
