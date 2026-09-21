import {
  AnnotationToolstrip,
  type AnnotationToolstripProps,
} from '@plannotator/ui/components/AnnotationToolstrip';

/** Compile-only proof that the published subpath exposes the additive opt-out. */
export function PublishedAnnotationToolstripConsumer(
  props: Omit<AnnotationToolstripProps, 'hideQuickLabel'>,
) {
  return <AnnotationToolstrip {...props} hideQuickLabel />;
}
