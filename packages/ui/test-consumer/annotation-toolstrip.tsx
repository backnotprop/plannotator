import {
  AnnotationToolstrip,
  type AnnotationToolstripProps,
} from '@plannotator/ui/components/AnnotationToolstrip';

export function PublishedAnnotationToolstripConsumer(
  props: Omit<AnnotationToolstripProps, 'hideQuickLabel'>,
) {
  return <AnnotationToolstrip {...props} hideQuickLabel />;
}
