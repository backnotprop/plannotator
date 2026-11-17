/**
 * A space's face on the home (approval "plans-home"): the real top of its plan's main page, made with no AI and no
 * judgment. A document is its newest version drawn by the renderer the plan page uses (ui's BlockRenderer, through
 * RenderedMarkdown) under the same rules for a plan's own words (planContent.tsx), at the sheet's type scale, cut off
 * by the card; it starts below a first heading that repeats the title or a generic first section heading, and a
 * table, steps or code near the top is brought into view (`faceMarkdown`). An HTML main page is the page itself in a
 * frame that runs, loads and moves nothing (`planFaceSrcdoc`), drawn at a desktop width and scaled; a page above
 * 512 KB is not drawn (the card's ground for its kind). A diagram's main page shows its source as code: the plan
 * page draws diagrams with the Mermaid and Graphviz libraries, which is neither cheap nor static enough for a face.
 *
 * Only the top is read (`GET …/versions/:n?face=1`: a document's first 16 KB). The card draws a face only near the
 * screen and lets it go when it is far (frameCardStandIn.tsx); a newer version replaces the face only once it has
 * come (the old one stays meanwhile), with the arrival's short fade.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { PlanSummary } from '@plannotator/core/plans';
import { RenderedMarkdown } from '@plannotator/ui/components/RenderedMarkdown';
import { PlanContentRules, planFaceSrcdoc, resolvePlanImage, resolvePlanLink } from './planContent';
import { faceMarkdown } from './spacesModel';
import { useFaceText } from './store';
import { arrive } from './frameCardStandIn';

/** The width an HTML page is laid out at before the card scales it (the face's own width is 420). */
const PAGE_WIDTH = 1024;

export function SpaceFace({ plan }: { plan: PlanSummary }) {
  const head = plan.head_version_number >= 1 ? plan.head_version_number : null;
  const face = useFaceText(plan.id, head);
  if (!face || face.text === null) return null;
  if (plan.primary_kind === 'html') return <PageFace html={face.text} />;
  return <DocumentFace text={face.text} title={plan.name} kind={plan.primary_kind ?? 'markdown'} />;
}

/** A face whose content changed in place: the arrival's short fade on its well (not on the first draw). */
function useArrival(text: string) {
  const box = useRef<HTMLDivElement>(null);
  const was = useRef(text);
  useEffect(() => {
    if (was.current === text) return;
    was.current = text;
    arrive(box.current?.closest('[data-card-face]') ?? null);
  }, [text]);
  return box;
}

function DocumentFace({ text, title, kind }: { text: string; title: string; kind: string }) {
  const box = useArrival(text);
  const markdown = useMemo(() => (kind === 'mermaid' || kind === 'graphviz' ? `\`\`\`${kind === 'graphviz' ? 'dot' : 'mermaid'}\n${text.split('\n').slice(0, 40).join('\n')}\n\`\`\`` : faceMarkdown(text, title)), [text, title, kind]);
  return (
    <div className="ib-spc-face" data-space-face="document" ref={box}>
      <PlanContentRules>
        <RenderedMarkdown markdown={markdown} resolveLocalLink={resolvePlanLink} resolveImage={resolvePlanImage} />
      </PlanContentRules>
    </div>
  );
}

function PageFace({ html }: { html: string }) {
  const box = useArrival(html);
  const srcDoc = useMemo(() => planFaceSrcdoc(html), [html]);
  return (
    <div className="ib-spc-pageface" data-space-face="page" ref={box}>
      <iframe title="" srcDoc={srcDoc} sandbox="" referrerPolicy="no-referrer" tabIndex={-1} aria-hidden="true" loading="lazy" style={{ width: PAGE_WIDTH, height: PAGE_WIDTH * 0.75, transform: `scale(${420 / PAGE_WIDTH})` }} />
    </div>
  );
}
