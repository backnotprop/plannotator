/**
 * A ```svg fence drawn as an image (approval "inbox-inline-html"), for a host
 * with `htmlEmbeds`. Through `<img>` an SVG runs no script and loads nothing,
 * so it needs no frame. Code shows the source in its place.
 */

import { Code } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Block } from '../../types';
import { CodeBlock } from '../blocks/CodeBlock';

/** Larger than this, the drawing stays code. */
const SVG_MAX_CHARS = 512 * 1024;

export function SvgFenceBlock({ block }: { block: Block }) {
  const [showCode, setShowCode] = useState(false);
  const [broken, setBroken] = useState(false);
  const src = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(block.content)}`, [block.content]);
  const drawable = block.content.length <= SVG_MAX_CHARS && /<svg[\s>]/i.test(block.content);
  if (!drawable) return <CodeBlock block={block} isHovered={false} />;
  return (
    <figure data-block-id={block.id} data-svg-fence="" className="my-4">
      {showCode || broken ? (
        <CodeBlock block={block} isHovered={false} />
      ) : (
        <img src={src} alt="" className="block h-auto max-w-full" onError={() => setBroken(true)} />
      )}
      <figcaption className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <Code aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span>SVG</span>
        <span className="flex-1" />
        {!broken && (
          <button
            type="button"
            data-svg-fence-code=""
            aria-pressed={showCode}
            className={`rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground ${showCode ? 'bg-muted text-foreground' : ''}`}
            onClick={() => setShowCode((value) => !value)}
          >
            Code
          </button>
        )}
      </figcaption>
    </figure>
  );
}
