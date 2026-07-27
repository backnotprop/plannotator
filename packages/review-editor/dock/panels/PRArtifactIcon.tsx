import React from 'react';
import type { PRArtifactKind } from '../../utils/prArtifacts';

const ARTIFACT_ICON: Record<PRArtifactKind, string> = {
  image: new URL('../../assets/pr-artifact-icons/image.png', import.meta.url).href,
  gif: new URL('../../assets/pr-artifact-icons/gif.png', import.meta.url).href,
  video: new URL('../../assets/pr-artifact-icons/video.png', import.meta.url).href,
  html: new URL('../../assets/pr-artifact-icons/html.png', import.meta.url).href,
  markdown: new URL('../../assets/pr-artifact-icons/markdown.png', import.meta.url).href,
};

/** Brand media icon for one PR artifact kind. */
export function PRArtifactIcon({
  kind,
  className = 'h-7 w-7',
}: {
  readonly kind: PRArtifactKind;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <img
      src={ARTIFACT_ICON[kind]}
      alt=""
      aria-hidden="true"
      className={`${className} object-contain`}
    />
  );
}
