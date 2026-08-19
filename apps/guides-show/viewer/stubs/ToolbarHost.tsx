import React from 'react';
/**
 * Build-time stand-in for review-editor's ToolbarHost in the portable viewer.
 * AllFilesCodeView never renders it in readOnly mode; aliasing it away keeps
 * the annotation composer (and its dependency tail) out of the CDN bundle
 * without touching the app's own import graph.
 */
export const ToolbarHost = React.forwardRef<unknown, Record<string, unknown>>(function StubToolbarHost() {
  return null;
});
