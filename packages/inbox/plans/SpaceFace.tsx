/**
 * A space's face on the home (approval "plans-home"): the real top of its plan's main page, made with no AI and no
 * judgment. A document is its newest version drawn by the renderer the plan page uses (ui's BlockRenderer, through
 * RenderedMarkdown) under the same rules for a plan's own words (planContent.tsx), at the sheet's type scale, cut off
 * by the card; a first heading that repeats the title is left out (`faceMarkdown`). An HTML main page is the page
 * itself in a frame that runs and loads nothing (the plan page's own sandbox and policy, `planHtmlSrcdoc`), drawn at
 * a desktop width and scaled. The card draws a face only once it is near the screen, inert and hidden from screen
 * readers; until its text comes, the well stays its quiet ground.
 */
import { useMemo } from 'react';
import type { PlanSummary } from '@plannotator/core/plans';
import { RenderedMarkdown } from '@plannotator/ui/components/RenderedMarkdown';
import { PlanContentRules, planHtmlSrcdoc, resolvePlanImage, resolvePlanLink } from './planContent';
import { faceMarkdown } from './spacesModel';
import { useVersionText } from './store';

/** The width an HTML page is laid out at before the card scales it (the face's own width is 420). */
const PAGE_WIDTH = 1024;

export function SpaceFace({ plan }: { plan: PlanSummary }) {
  const head = plan.head_version_number >= 1 ? plan.head_version_number : null;
  const { text } = useVersionText(plan.id, head, 0);
  if (text === null) return null;
  if (plan.primary_kind === 'html') return <PageFace html={text} />;
  return <DocumentFace text={text} title={plan.name} kind={plan.primary_kind ?? 'markdown'} />;
}

function DocumentFace({ text, title, kind }: { text: string; title: string; kind: string }) {
  // A diagram's main page shows its source as the plan page shows a diagram that may not be drawn: as code.
  const markdown = useMemo(() => (kind === 'mermaid' || kind === 'graphviz' ? `\`\`\`${kind === 'graphviz' ? 'dot' : 'mermaid'}\n${text.split('\n').slice(0, 40).join('\n')}\n\`\`\`` : faceMarkdown(text, title)), [text, title, kind]);
  return (
    <div className="ib-spc-face" data-space-face="document">
      <PlanContentRules>
        <RenderedMarkdown markdown={markdown} resolveLocalLink={resolvePlanLink} resolveImage={resolvePlanImage} />
      </PlanContentRules>
    </div>
  );
}

function PageFace({ html }: { html: string }) {
  const srcDoc = useMemo(() => planHtmlSrcdoc(html), [html]);
  return (
    <div className="ib-spc-pageface" data-space-face="page">
      <iframe title="" srcDoc={srcDoc} sandbox="" referrerPolicy="no-referrer" tabIndex={-1} aria-hidden="true" loading="lazy" style={{ width: PAGE_WIDTH, height: PAGE_WIDTH * 0.75, transform: `scale(${420 / PAGE_WIDTH})` }} />
    </div>
  );
}
