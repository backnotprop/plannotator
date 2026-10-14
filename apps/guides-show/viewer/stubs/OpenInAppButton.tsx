import React from 'react';
/**
 * Build-time stand-in — guides.show has no server, so a read-only guide can
 * never open a file in an app (FileHeader already skips it when `readOnly`).
 */
export const OpenInAppButton: React.FC<Record<string, unknown>> = () => null;
