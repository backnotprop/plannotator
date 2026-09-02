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

/** Compile-only proof of the published Viewer-owned document-header API. */
export function PublishedViewerDocumentHeaderConsumer(props: ViewerProps) {
  return <Viewer {...props} annotationHeader={annotationHeader} stickyActions={false} />;
}
