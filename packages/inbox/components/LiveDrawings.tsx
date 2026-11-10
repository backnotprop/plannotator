import { useEffect, useMemo, useRef } from 'react';
import { themedSvg } from '@plannotator/core/html-embed';
import { useEmbedTheme } from '@plannotator/ui/components/html-embed/HtmlEmbedBlock';
import { draftingLanded, drawablePartialSvg, useLiveDrafts, type LiveDraft } from '../drafting';

const lessMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The drawings of messages being written into this thread, at its end, each
 * growing as its agent writes it (prototype; ../drafting.ts), each new shape
 * scaling and fading in. Through `<img>`,
 * as a finished ```svg fence is drawn (SvgFenceBlock): no script runs and
 * nothing loads. Gone when the message lands: `messages` is the thread's
 * message count.
 */
export function LiveDrawings({ threadId, messages }: { threadId: string; messages: number }) {
  const drafts = useLiveDrafts(threadId);
  useEffect(() => draftingLanded(threadId), [threadId, messages]);
  return (
    <>
      {drafts.map((draft) => (
        <LiveDrawing key={draft.call} draft={draft} />
      ))}
    </>
  );
}

function LiveDrawing({ draft }: { draft: LiveDraft }) {
  if (!draft.drawings.some((drawing) => /<svg[\s>]/i.test(drawing.source))) return null;
  return (
    <div className="ib-drafting" data-drafting={draft.call} data-done={draft.done ? '' : undefined}>
      <p className="ib-drafting-line" role="status">
        {draft.done ? 'Sending…' : 'Drawing…'}
      </p>
      {draft.drawings.map((drawing, index) => (
        <LiveFence key={index} source={drawing.source} />
      ))}
    </div>
  );
}

/** One drawing of the message. A finished one keeps its image: only the one being written is worked out again. */
function LiveFence({ source }: { source: string }) {
  const theme = useEmbedTheme();
  // When each of its shapes was first drawn, so each comes in once (drafting.ts).
  const seen = useRef(new Map<number, number>());
  const src = useMemo(() => {
    const svg = drawablePartialSvg(source, { seen: seen.current, now: performance.now(), reduced: lessMotion() });
    return svg === null ? null : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themedSvg(svg, theme))}`;
  }, [source, theme]);
  return src === null ? null : <img src={src} alt="" className="ib-drafting-svg" />;
}
