import React, { useEffect, useRef, useState } from 'react';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { RenderedMarkdown } from '@plannotator/ui/components/RenderedMarkdown';
import type { PRArtifact } from '../../utils/prArtifacts';
import {
  type ArtifactProviderLocation,
  artifactContentProxyUrl,
  injectArtifactBaseUrl,
  rewriteArtifactMarkdownReferences,
  useRemoteArtifactDocument,
} from './artifactDocument';
import { PRArtifactIcon } from './PRArtifactIcon';

function DocumentPreview({
  artifact,
  provider,
}: {
  readonly artifact: PRArtifact;
  readonly provider: ArtifactProviderLocation;
}): React.JSX.Element {
  const previewRef = useRef<HTMLDivElement>(null);
  const markdownRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);
  useEffect(() => {
    const target = previewRef.current;
    if (target === null) return;
    if (typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const state = useRemoteArtifactDocument(artifact.url, isNearViewport);
  useEffect(() => {
    if (state.status === 'ready' && artifact.kind === 'markdown' && markdownRef.current !== null) {
      rewriteArtifactMarkdownReferences(markdownRef.current, artifact.url, provider);
    }
  }, [artifact.kind, artifact.url, provider, state]);

  if (state.status !== 'ready') {
    return (
      <div ref={previewRef} className="flex h-full items-center justify-center bg-muted/35">
        <PRArtifactIcon
          kind={artifact.kind}
          className="h-14 w-14 opacity-55"
        />
      </div>
    );
  }
  if (artifact.kind === 'html') {
    return (
      <div ref={previewRef} className="absolute inset-0 overflow-hidden bg-white">
        <iframe
          title={`${artifact.name} preview`}
          srcDoc={injectArtifactBaseUrl(state.content, artifact.url, provider)}
          sandbox=""
          tabIndex={-1}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 h-[250%] w-[250%] origin-top-left scale-[0.4] border-0 bg-white"
        />
      </div>
    );
  }
  return (
    <div ref={previewRef} className="absolute inset-0 overflow-hidden bg-background text-foreground">
      <div ref={markdownRef} className="pointer-events-none h-[200%] w-[200%] origin-top-left scale-50 overflow-hidden p-7">
        <RenderedMarkdown markdown={state.content} className="md-compact max-w-none" />
      </div>
    </div>
  );
}

function ArtifactPreview({
  artifact,
  provider,
}: {
  readonly artifact: PRArtifact;
  readonly provider: ArtifactProviderLocation;
}): React.JSX.Element {
  const [mediaFailed, setMediaFailed] = useState(false);
  if (mediaFailed) {
    return (
      <div className="flex h-full items-center justify-center bg-muted/35">
        <PRArtifactIcon kind={artifact.kind} className="h-14 w-14 opacity-55" />
      </div>
    );
  }
  switch (artifact.kind) {
    case 'image':
    case 'gif':
      return (
        <img
          src={artifactContentProxyUrl(artifact.url)}
          alt=""
          aria-hidden="true"
          draggable={false}
          loading="lazy"
          decoding="async"
          className="h-full w-full bg-muted/20 object-contain"
          onError={() => setMediaFailed(true)}
        />
      );
    case 'video':
      return (
        <video
          src={artifactContentProxyUrl(artifact.url)}
          muted
          playsInline
          preload="metadata"
          tabIndex={-1}
          aria-hidden="true"
          className="h-full w-full bg-black object-contain"
          onError={() => setMediaFailed(true)}
          onLoadedMetadata={(event) => {
            if (event.currentTarget.duration > 0.04 && event.currentTarget.currentTime === 0) {
              event.currentTarget.currentTime = 0.04;
            }
          }}
        />
      );
    case 'html':
    case 'markdown':
      return <DocumentPreview artifact={artifact} provider={provider} />;
  }
}

/**
 * Visual-first canvas for a PR artifact catalog. Tiles retain only the artifact
 * name and media mark; provenance and review controls stay in the detail view.
 */
export function PRArtifactGallery({
  artifacts,
  provider,
  onSelectArtifact,
}: {
  readonly artifacts: readonly PRArtifact[];
  readonly provider: ArtifactProviderLocation;
  readonly onSelectArtifact: (artifactId: string) => void;
}): React.JSX.Element {
  if (artifacts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No visible artifacts
      </div>
    );
  }
  return (
    <OverlayScrollArea className="h-full">
      <div
        className="mx-auto grid max-w-[76rem] gap-3 p-4 sm:p-5"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(13.5rem, 100%), 1fr))' }}
      >
        {artifacts.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            aria-label={`Open ${artifact.name}`}
            className="group relative aspect-square overflow-hidden rounded-[6px] bg-card text-left shadow-sm ring-1 ring-inset ring-border/55 transition-[transform,box-shadow] duration-150 ease-out hover:shadow-md hover:ring-foreground/20 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            onClick={() => onSelectArtifact(artifact.id)}
          >
            <ArtifactPreview artifact={artifact} provider={provider} />
            <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 via-black/50 to-transparent px-3 pb-2.5 pt-10 text-white">
              <PRArtifactIcon kind={artifact.kind} className="h-5 w-5 shrink-0 drop-shadow-sm" />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium leading-tight drop-shadow-sm">
                {artifact.name}
              </span>
            </span>
          </button>
        ))}
      </div>
    </OverlayScrollArea>
  );
}
