import {
  StickyHeaderLane,
  type StickyHeaderLaneProps,
  type StickyHeaderLaneVisibility,
} from '@plannotator/ui/components/StickyHeaderLane';

export function PublishedStickyHeaderLaneConsumer(
  props: Omit<StickyHeaderLaneProps, 'visibility' | 'sticky'>,
) {
  const visibility: StickyHeaderLaneVisibility = 'always';
  return <StickyHeaderLane {...props} visibility={visibility} sticky={false} />;
}
