import {
  Viewer,
  type ViewerAnnotationHeaderConfig,
  type ViewerProps,
} from '@plannotator/ui/components/Viewer';

const annotationHeader: ViewerAnnotationHeaderConfig = {
  onInputMethodChange: () => {},
  onModeChange: () => {},
  hideQuickLabel: true,
};

export function PublishedViewerDocumentHeaderConsumer(props: ViewerProps) {
  return <Viewer {...props} annotationHeader={annotationHeader} stickyActions={false} />;
}
