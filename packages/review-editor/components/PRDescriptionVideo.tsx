import React, { useEffect, useState } from 'react';
import type { Block } from '@plannotator/ui/types';
import { artifactContentProxyUrl } from '../dock/panels/artifactDocument';

const attachmentPattern =
  /^https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[^\s<>]+$/;

function attachmentUrl(text: string): string | null {
  const src = text.trim();
  if (!attachmentPattern.test(src)) return null;
  return src;
}

export function renderPRDescriptionVideo(
  block: Block,
  fallback: React.ReactNode,
): React.ReactNode {
  const src = attachmentUrl(block.content);
  return src ? (
    <PRDescriptionVideo
      key={src}
      src={src}
      blockId={block.id}
      fallback={fallback}
    />
  ) : (
    fallback
  );
}

interface PRDescriptionVideoProps {
  src: string;
  blockId: string;
  fallback: React.ReactNode;
}

function PRDescriptionVideo({
  src,
  blockId,
  fallback,
}: PRDescriptionVideoProps) {
  const [state, setState] = useState<'link' | 'loading' | 'video'>('link');
  const proxy = artifactContentProxyUrl(src);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(proxy, {
          headers: { Range: 'bytes=0-0' },
          signal: controller.signal,
        });
        const isVideo =
          response.ok &&
          response.headers
            .get('content-type')
            ?.toLowerCase()
            .startsWith('video/');
        await response.body?.cancel();
        if (!controller.signal.aborted && isVideo) setState('loading');
      } catch {}
    })();
    return () => controller.abort();
  }, [proxy]);

  if (state === 'link') return <>{fallback}</>;
  // The link stays until the player knows its size, so the page shifts once.
  const loading = state === 'loading';
  return (
    <>
      {loading && fallback}
      <div
        data-block-id={loading ? undefined : blockId}
        hidden={loading}
        className="mb-2"
      >
        <video
          src={proxy}
          aria-label="PR attachment video"
          controls
          playsInline
          preload="metadata"
          className="max-h-[70vh] max-w-full rounded-md bg-black"
          onLoadedMetadata={() => setState('video')}
          onError={() => setState('link')}
        />
      </div>
    </>
  );
}
