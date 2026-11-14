import React, { useEffect, useRef } from 'react';
import { agentFaceArtReady, mountAgentMark, setAgentFaceArt, unmountAgentMark } from './motion';
import { GLASS_COLOURS, glassDataUrl } from './glassArt';
import type { OurFace } from './faceChoices';
import './agentFace.css';

const picture = (src: string) => `<img class="am-art" src="${src}" alt="" draggable="false">`;
const black = glassDataUrl(GLASS_COLOURS.find((colour) => colour.id === 'glass') ?? GLASS_COLOURS[0]!);

function glassArt(): Record<OurFace, string> {
  const art = Object.fromEntries(GLASS_COLOURS.map((colour) => [colour.id, picture(glassDataUrl(colour))])) as Record<string, string>;
  return { ...art, transparent: picture(black), totman: picture(black) } as Record<OurFace, string>;
}

export default function PowerUpGuyLive({ size }: { size: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!agentFaceArtReady()) setAgentFaceArt(glassArt());
    mountAgentMark(el, { rig: null, face: 'glass', size, seed: 'power-up' });
    return () => unmountAgentMark(el);
  }, [size]);
  return (
    <span
      ref={ref}
      className="am"
      data-power-up-guy-live=""
      style={{ ['--am' as string]: `${size}px`, position: 'relative', display: 'inline-grid', placeItems: 'center', width: size, height: size } as React.CSSProperties}
    />
  );
}
