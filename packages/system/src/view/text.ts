import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { DEFAULT_TEXT, fontsReady, setText, type TextSetting } from '../layout/measure.ts';

export function readText(el: Element | null): TextSetting {
  if (!el || typeof getComputedStyle !== 'function') return DEFAULT_TEXT;
  const cs = getComputedStyle(el);
  const type = Number.parseFloat(cs.getPropertyValue('--ib-type'));
  const sans = cs.getPropertyValue('--font-sans').trim();
  const mono = cs.getPropertyValue('--font-mono').trim();
  return {
    type: Number.isFinite(type) && type > 0 ? type : DEFAULT_TEXT.type,
    sans: sans || DEFAULT_TEXT.sans,
    mono: mono || DEFAULT_TEXT.mono,
  };
}

const same = (a: TextSetting, b: TextSetting) => a.type === b.type && a.sans === b.sans && a.mono === b.mono;

export function useText(ref: RefObject<Element | null>): { text: TextSetting; epoch: number } {
  const [text, setT] = useState<TextSetting>(DEFAULT_TEXT);
  const [epoch, setEpoch] = useState(0);
  useLayoutEffect(() => {
    const t = readText(ref.current);
    setT((was) => (same(was, t) ? was : t));
  });
  useEffect(() => {
    let live = true;
    fontsReady(text).then(() => live && setEpoch((n) => n + 1));
    return () => {
      live = false;
    };
  }, [text]);
  setText(text);
  return { text, epoch };
}

export function useSize(ref: RefObject<Element | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
