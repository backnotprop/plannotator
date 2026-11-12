import type { ShapeBoxSelection } from '@plannotator/ui/components/shape';

export interface ShapeReplyPart {
  words: string;
  file: File | null;
}

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

const BREAK = '﻿';
export const plainQuote = (text: string) =>
  text
    .replace(/[\\`*_~$[\]#]/g, (c) => `\\${c}`)
    .replace(/([@<])/g, `$1${BREAK}`)
    .replace(/:\/\//g, `:${BREAK}//`);
const plain = plainQuote;

export function shapeReplyWords(selection: Pick<ShapeBoxSelection, 'label' | 'parts' | 'words'>, text: string): string {
  const label = selection.label?.trim() ?? '';
  const quoted = selection.parts.length > 1 && selection.words.trim() ? ` · “${plain(clip(selection.words, 80))}”` : '';
  const head = label ? `> ${plain(label)}${quoted}` : '';
  const typed = text.trim();
  return head && typed ? `${head}\n\n${typed}` : head || typed;
}

export function shapeReplyFileName(selection: Pick<ShapeBoxSelection, 'parts' | 'view'>): string {
  const name = (selection.parts.join('-') || selection.view).replace(/[^\w.-]+/g, '-').slice(0, 60);
  return `${name || 'board'}.png`;
}

export async function shapeReplyPart(selection: ShapeBoxSelection, text: string): Promise<ShapeReplyPart> {
  const words = shapeReplyWords(selection, text);
  const picture = await selection.picture.catch(() => null);
  if (!picture) return { words, file: null };
  const comma = picture.indexOf(',');
  const binary = atob(picture.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { words, file: new File([bytes], shapeReplyFileName(selection), { type: 'image/png' }) };
}

export function replyWordsCount(reply: string, words: string): number {
  if (!words) return 0;
  let n = 0;
  for (let at = reply.indexOf(words); at >= 0; at = reply.indexOf(words, at + words.length)) n++;
  return n;
}

export function withoutReplyWords(reply: string, words: string, nth = 0): string {
  if (!words) return reply;
  let at = reply.indexOf(words);
  for (let i = 0; i < nth && at >= 0; i++) at = reply.indexOf(words, at + words.length);
  if (at < 0) return reply;
  const before = reply.slice(0, at).trimEnd();
  const after = reply.slice(at + words.length).trimStart();
  return before && after ? `${before}\n\n${after}` : before || after;
}

export function freeName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (taken.includes(`${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}

export function withFreeName(file: File, taken: readonly string[]): File {
  const name = freeName(file.name, taken);
  return name === file.name ? file : new File([file], name, { type: file.type });
}
