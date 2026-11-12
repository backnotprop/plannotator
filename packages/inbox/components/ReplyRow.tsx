import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useInboxTextSize } from '../textSize';

export function ReplyRow({
  phone,
  keepOpen,
  send,
  clip,
  skills,
  mic,
  status,
  files,
  chips,
  summary,
  pill,
  discard,
  hint = null,
  fold,
  onFold,
  fitKey,
}: {
  phone: boolean;
  keepOpen: boolean;
  send: ReactNode;
  clip: ReactNode;
  skills: ReactNode;
  mic: ReactNode;
  status: ReactNode;
  files: ReactNode;
  chips: ReactNode;
  summary: ReactNode;
  pill: ReactNode;
  discard: ReactNode;
  hint?: ReactNode;
  fold: boolean;
  onFold: (fold: boolean) => void;
  fitKey: string;
}) {
  const midRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const textSize = useInboxTextSize();
  const [width, setWidth] = useState(0);
  const [fonts, setFonts] = useState(0);
  const key = `${fitKey}|${textSize}|${width}|${fonts}|${pill ? 1 : 0}|${files ? 1 : 0}`;
  const measured = useRef(key);
  const checked = useRef<boolean | null>(null);
  const [, setLeft] = useState(0);
  useLayoutEffect(() => {
    if (phone) return;
    const layer = layerRef.current;
    if (!layer) return;
    const changed = measured.current !== key;
    if (!changed && checked.current === fold) return;
    if (inCell(layer)) return;
    if (changed && fold) {
      measured.current = key;
      checked.current = null;
      onFold(false);
      return;
    }
    measured.current = key;
    checked.current = fold;
    if (!fold && layer.scrollWidth > layer.clientWidth + 1) onFold(true);
  });
  useEffect(() => {
    const mid = midRef.current;
    if (phone || !mid || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(Math.round(mid.clientWidth)));
    observer.observe(mid);
    return () => observer.disconnect();
  }, [phone]);
  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => live && setFonts((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);

  if (phone) {
    return (
      <div className={`ib-rrow${keepOpen ? ' ib-keep' : ''}`} data-reply-row="" data-phone="">
        <div className="ib-rmid">
          <div className="ib-rlayer">
            {clip}
            {skills}
            {pill}
            {files}
            {hint && (
              <span className="ib-rhint" data-reply-hint="">
                {hint}
              </span>
            )}
          </div>
          {status}
        </div>
        {mic}
        {send}
      </div>
    );
  }
  return (
    <div className={`ib-rrow${keepOpen ? ' ib-keep' : ''}`} data-reply-row="">
      <div className="ib-rlead">
        {send}
        {clip}
        {skills}
        {mic}
      </div>
      <div className="ib-rmid" ref={midRef} data-fold={fold ? '' : undefined} data-hint={hint ? '' : undefined}>
        <div
          className="ib-rlayer"
          ref={layerRef}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setLeft((n) => n + 1);
          }}
        >
          {files}
          {fold ? summary : <span className="ib-rchips">{chips}</span>}
          {pill && <span className="ib-rto-cell">{pill}</span>}
        </div>
        {hint && (
          <span className="ib-rhint" data-reply-hint="">
            {hint}
          </span>
        )}
        {status}
      </div>
      {discard}
    </div>
  );
}

function inCell(layer: HTMLElement): boolean {
  const active = document.activeElement;
  return (active !== null && active !== layer && layer.contains(active)) || layer.querySelector('[aria-expanded="true"]') !== null;
}
