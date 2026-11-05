// The board's short text (the claim, `views.know`): links,
// `code`, **bold**, and `[^n]` for reference bubble n. Nothing else, so an
// agent's text cannot carry markup.
import React from 'react';
import { CodeSpan } from '../LocalLinkContext';
import { Bubble } from './refs';

const TOKEN = /\[\^(\d{1,3})\]|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
/** What may follow a number on its own line's end, never start the next one. */
const AFTER_NUMBER = /^[.,;:!?…)\]}'"’”»]+/;

/** Takes the word (or the bold, link or code) right before a number off the end of `out`. */
function takeWordBefore(out: React.ReactNode[]): React.ReactNode[] {
  const prev = out.pop();
  if (typeof prev !== 'string') return prev === undefined ? [] : [prev];
  const word = prev.match(/\S*\s*$/)![0];
  if (prev.length > word.length) out.push(prev.slice(0, prev.length - word.length));
  // A space there is a place to break: a no-break space looks the same.
  const kept = word.replace(/\s+$/, '\u00a0');
  return word.trim() || !out.length ? [kept] : [out.pop(), kept];
}

export function ShapeInline({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1]) {
      // A number stays with the word before it and the punctuation after it: neither starts a line.
      const before = takeWordBefore(out);
      const after = text.slice(at + m[0].length).match(AFTER_NUMBER)?.[0] ?? '';
      out.push(<span key={key++} className="shp-rb-with">{before}<span className="shp-rb-end"><Bubble n={Number(m[1])} />{after}</span></span>);
      last = at + m[0].length + after.length;
      continue;
    }
    if (m[2]) out.push(<a key={key++} href={m[3]} target="_blank" rel="noreferrer">{m[2]}</a>);
    else if (m[4]) out.push(<CodeSpan key={key++} text={m[4]}><code>{m[4]}</code></CodeSpan>);
    else if (m[5]) out.push(<b key={key++}><ShapeInline text={m[5]} /></b>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** The text without its markup, for a quote or a label. */
export function shapePlainText(text: string): string {
  return text
    .replace(/\[\^\d{1,3}\]/g, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
