import { useEffect } from 'react';
import { sliceText } from '@plannotator/core/inbox-questions';
import { Tip } from './Tip';

export function FileName({ name, className, wrap = false }: { name: string; className?: string; wrap?: boolean }) {
  useEffect(keepNamesWholeOnCopy, []);
  const [head, tail] = splitFileName(name);
  const cls = `ib-fname${wrap ? ' ib-fname-wrap' : ''}${className ? ` ${className}` : ''}`;
  if (wrap) {
    return (
      <span className={cls} dir="auto">
        <span className="ib-fname-h">{name}</span>
      </span>
    );
  }
  if (!tail) {
    return (
      <Tip content={name} cut>
        <span className={cls} dir="auto">
          <span className="ib-fname-h">{name}</span>
        </span>
      </Tip>
    );
  }
  return (
    <Tip content={name} cut>
      <span className={cls} dir="auto" data-name={name}>
        <span className="ib-fname-h" aria-hidden="true">
          {head}
        </span>
        <span className="ib-fname-t" aria-hidden="true">
          {tail}
        </span>
      </span>
    </Tip>
  );
}

let copyListeners = 0;

function keepNamesWholeOnCopy(): () => void {
  if (copyListeners++ === 0) document.addEventListener('copy', onCopy);
  return () => {
    if (--copyListeners === 0) document.removeEventListener('copy', onCopy);
  };
}

function onCopy(event: ClipboardEvent): void {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !event.clipboardData) return;
  const text = selection.toString();
  let whole = text;
  for (const el of document.querySelectorAll<HTMLElement>('.ib-fname[data-name]')) {
    if (!selection.containsNode(el, true)) continue;
    const head = el.querySelector('.ib-fname-h')?.textContent ?? '';
    const tail = el.querySelector('.ib-fname-t')?.textContent ?? '';
    if (!head || !tail) continue;
    whole = whole.split(`${head.slice(-1)}\n${tail.slice(0, 1)}`).join(`${head.slice(-1)}${tail.slice(0, 1)}`);
  }
  if (whole === text) return;
  event.clipboardData.setData('text/plain', whole);
  event.preventDefault();
}

const SHORT = 16;
const TAIL_STEM = 12;

export function splitFileName(name: string): [string, string] {
  if (name.length <= SHORT) return [name, ''];
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && /^\.[\p{L}\p{N}]{1,8}$/u.test(name.slice(dot)) ? name.slice(dot) : '';
  const stem = ext ? name.slice(0, -ext.length) : name;
  const sep = Math.max(stem.lastIndexOf('-'), stem.lastIndexOf('_'), stem.lastIndexOf(' '), stem.lastIndexOf('.'));
  let keep: string;
  if (sep > 0 && stem.length - sep <= TAIL_STEM + 1) keep = stem.slice(sep);
  else {
    const start = sliceText(stem, Math.max(0, stem.length - 6));
    keep = stem.slice(start.length);
  }
  const tail = `${keep}${ext}`;
  const head = name.slice(0, name.length - tail.length);
  return head ? [head, tail] : [name, ''];
}
