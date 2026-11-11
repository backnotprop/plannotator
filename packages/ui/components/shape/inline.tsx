// Nothing else, so an agent's text cannot carry markup.
import React from 'react';
import { CodeSpan } from '../LocalLinkContext';
import { Bubble } from './refs';

const TOKEN = /\[\^(\d{1,3})\]|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;

export function ShapeInline({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1]) out.push(<Bubble key={key++} n={Number(m[1])} />);
    else if (m[2]) out.push(<a key={key++} href={m[3]} target="_blank" rel="noreferrer">{m[2]}</a>);
    else if (m[4]) out.push(<CodeSpan key={key++} text={m[4]}><code>{m[4]}</code></CodeSpan>);
    else if (m[5]) out.push(<b key={key++}><ShapeInline text={m[5]} /></b>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export function shapePlainText(text: string): string {
  return text
    .replace(/\[\^\d{1,3}\]/g, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
