import { useEffect, useMemo, useRef } from 'react';
import { themedSvg } from '@plannotator/core/html-embed';
import { liveSvgFences } from '@plannotator/core/inbox-drafting';
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
  const theme = useEmbedTheme();
  // Per drawing of the message: when each of its shapes was first drawn, so each comes in once (drafting.ts).
  const seen = useRef<Map<number, number>[]>([]);
  const sources = useMemo(
    () =>
      liveSvgFences(draft.body)
        .map((fence, index) => drawablePartialSvg(fence.source, { seen: (seen.current[index] ??= new Map()), now: performance.now(), reduced: lessMotion() }))
        .filter((svg): svg is string => svg !== null)
        .map((svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(themedSvg(svg, theme))}`),
    [draft.body, theme],
  );
  if (sources.length === 0) return null;
  return (
    <div className="ib-message ib-drafting" data-drafting={draft.call} data-done={draft.done ? '' : undefined}>
      <p className="ib-drafting-line" role="status">
        {draft.done ? 'Sending…' : 'Drawing…'}
      </p>
      {sources.map((src, index) => (
        <img key={index} src={src} alt="" className="ib-drafting-svg" />
      ))}
    </div>
  );
}
