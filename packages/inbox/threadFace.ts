import { createElement, useMemo } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostMark } from '@plannotator/ui/components/inbox-thread/icons';
import { useShownAgentFace } from './agents/projectFace';
import { useAgentFaceSources } from './agents/faceArtLoad';
import { isOwnFace } from './agents/faceChoices';
import { ownIconSrc } from './agents/ownIcons';
import { isSetFace, setFaceParts, setIconSrc } from './agents/iconSets';

/**
 * The agent's own mark (the face drawn as markup) as an SVG image address, for a canvas. Marks without their own
 * colours get a mid grey, readable on light and dark tab strips. Null when the host draws no SVG.
 */
export function hostMarkSrc(host: string | null | undefined): string | null {
  const html = renderToStaticMarkup(createElement(HostMark, { host }));
  const svg = /<svg[\s\S]*?<\/svg>/.exec(html)?.[0];
  if (!svg) return /<img[^>]*\ssrc="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? null;
  const root = /^<svg[^>]*>/.exec(svg)?.[0] ?? '';
  const extra = ['xmlns="http://www.w3.org/2000/svg"', 'width="64"', 'height="64"', 'fill="#8a8a96"', 'color="#8a8a96"'].filter((attr) => !root.includes(` ${attr.split('=')[0]}=`));
  const out = svg.replace('<svg', `<svg ${extra.join(' ')}`);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(out)}`;
}

/**
 * The picture of the face the Inbox shows for an agent (the thread's row: `rowAgent`), for a thread tab's favicon:
 * an uploaded or set icon's address, or one of ours (the light picture). A face drawn as markup (the agent's own
 * mark, a project's letter tile) gives the agent's host mark; null only when that draws nothing either.
 */
export function useThreadFaceSrc(agent: string | null | undefined, host: string | null | undefined): string | null {
  const face = useShownAgentFace(agent);
  const drawn = face === 'agent' || face === 'mark' || face === 'project';
  const ours = useAgentFaceSources(!drawn && !isOwnFace(face) && !isSetFace(face));
  const mark = useMemo(() => (drawn ? hostMarkSrc(host) : null), [drawn, host]);
  if (drawn) return mark;
  if (isOwnFace(face)) return ownIconSrc(face, true);
  if (isSetFace(face)) {
    const { set, icon } = setFaceParts(face);
    return setIconSrc(set, icon);
  }
  const src = ours?.[face];
  return typeof src === 'string' ? src : (src?.light ?? null);
}
