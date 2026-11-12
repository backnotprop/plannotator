import { copyTextToClipboard } from './clipboard';
import { restoreClipboardLists } from './richClipboardLists';

export const MAX_RICH_CLIPBOARD_HTML_LENGTH = 256 * 1024;
export const MAX_RICH_CLIPBOARD_OUTPUT_LENGTH = 512 * 1024;

export type RichCopySource =
  | { html: string; text: string; truncated?: boolean }
  | { tooLarge: true; text: string; truncated?: boolean }
  | null;

export interface RichCopyOutcome {
  copied: 'rich' | 'plain';
  reason?: 'unavailable' | 'too-large' | 'no-markup';
  truncatedTo?: number;
}

export function richCopyOutcomeLabel(outcome: RichCopyOutcome): string {
  const notes: string[] = [];
  if (outcome.copied === 'plain') {
    notes.push(
      outcome.reason === 'too-large' ? 'too large for rich text'
      : outcome.reason === 'no-markup' ? 'formatting not available'
      : 'rich clipboard unavailable',
    );
  }
  if (outcome.truncatedTo !== undefined) {
    notes.push(`first ${outcome.truncatedTo.toLocaleString('en-US')} characters only`);
  }
  const base = outcome.copied === 'rich' ? 'Copied as rich text' : 'Copied as plain text';
  return notes.length > 0 ? `${base} (${notes.join('; ')})` : base;
}

const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong',
  'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

const DROP_WITH_CONTENT = new Set([
  'AUDIO', 'BUTTON', 'CANVAS', 'EMBED', 'FORM', 'IFRAME', 'INPUT', 'OBJECT',
  'OPTION', 'SCRIPT', 'SELECT', 'STYLE', 'SVG', 'TEMPLATE', 'TEXTAREA', 'VIDEO',
]);

const DROP_SELECTORS = [
  '.annotation-exclude',
  '.annotation-toolbar',
  '[data-comment-popover="true"]',
  '[data-floating-picker="true"]',
  '[data-print-hide]',
  'button',
].join(',');

function safeIntegerAttribute(element: Element, name: string, minimum: number): string | null {
  const value = element.getAttribute(name);
  if (!value || !/^-?\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? String(number) : null;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost'
    || host.endsWith('.localhost')
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    || host === '0.0.0.0'
    || host === '[::1]'
    || host === '[::]'
    || /^\[::(ffff:)?7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

function safeLinkHref(href: string): string | null {
  try {
    const baseUrl = new URL(document.baseURI);
    const url = new URL(href, baseUrl);
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return null;
    if (
      (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.origin === baseUrl.origin || isLoopbackHostname(url.hostname))
    ) return null;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return null;
  }
}

function appendSanitizedNode(source: Node, target: Node): void {
  if (source.nodeType === Node.TEXT_NODE) {
    target.appendChild(document.createTextNode(source.textContent ?? ''));
    return;
  }
  if (!(source instanceof Element)) return;
  if (DROP_WITH_CONTENT.has(source.tagName.toUpperCase()) || source.matches(DROP_SELECTORS)) return;

  const tag = source.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) {
    source.childNodes.forEach((child) => appendSanitizedNode(child, target));
    return;
  }

  const clean = document.createElement(tag);
  const element = source;
  if (tag === 'a') {
    const href = element.getAttribute('href');
    const safeHref = href ? safeLinkHref(href) : null;
    if (safeHref) clean.setAttribute('href', safeHref);
  }
  if (tag === 'ol') {
    const start = safeIntegerAttribute(element, 'start', -2147483648);
    if (start) clean.setAttribute('start', start);
  }
  if (tag === 'li') {
    const value = safeIntegerAttribute(element, 'value', -2147483648);
    if (value) clean.setAttribute('value', value);
  }
  if (tag === 'td' || tag === 'th') {
    for (const name of ['colspan', 'rowspan']) {
      const span = safeIntegerAttribute(element, name, 1);
      if (span && Number(span) <= 1000) clean.setAttribute(name, span);
    }
    const scope = element.getAttribute('scope');
    if (scope && ['row', 'col', 'rowgroup', 'colgroup'].includes(scope)) {
      clean.setAttribute('scope', scope);
    }
  }
  if (tag === 'ol' || tag === 'ul' || tag === 'li') {
    const dir = element.getAttribute('dir');
    if (dir && ['ltr', 'rtl', 'auto'].includes(dir)) clean.setAttribute('dir', dir);
  }
  source.childNodes.forEach((child) => appendSanitizedNode(child, clean));
  target.appendChild(clean);
}

function sanitizeFragment(fragment: ParentNode): string {
  const clean = document.createElement('div');
  fragment.childNodes.forEach((node) => appendSanitizedNode(node, clean));
  return clean.innerHTML;
}

export function selectionRangeToHtml(range: Range): string | null {
  if (range.toString().length > MAX_RICH_CLIPBOARD_OUTPUT_LENGTH) return null;
  const fragment = range.cloneContents();
  let ancestor = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  while (ancestor && ancestor !== document.body) {
    if (ancestor.matches('a,b,blockquote,code,del,em,h1,h2,h3,h4,h5,h6,i,li,ol,p,pre,s,strong,sub,sup,table,tbody,td,tfoot,th,thead,tr,u,ul,[data-rich-list-level]')) {
      const wrapper = ancestor.cloneNode(false);
      while (fragment.firstChild) wrapper.appendChild(fragment.firstChild);
      fragment.appendChild(wrapper);
    }
    ancestor = ancestor.parentElement;
  }
  restoreClipboardLists(fragment);
  const html = sanitizeFragment(fragment);
  return html.length <= MAX_RICH_CLIPBOARD_OUTPUT_LENGTH ? html : null;
}

export function richCopySourceFromRange(range: Range, text: string): RichCopySource {
  try {
    const html = selectionRangeToHtml(range);
    if (html === null) return { tooLarge: true, text };
    return html ? { html, text } : null;
  } catch {
    return null;
  }
}

export function sanitizeRichHtml(html: string): string | null {
  if (!html || html.length > MAX_RICH_CLIPBOARD_HTML_LENGTH) return null;
  try {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return sanitizeFragment(parsed.body);
  } catch {
    return null;
  }
}

function copyRichTextWithFallback(html: string, text: string): boolean {
  const activeElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const selection = window.getSelection();
  const savedRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange())
    : [];
  let copied = false;

  const handleCopy = (event: ClipboardEvent) => {
    event.stopImmediatePropagation();
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;
    try {
      clipboardData.setData('text/html', html);
      clipboardData.setData('text/plain', text);
      event.preventDefault();
      copied = true;
    } catch {
      copied = false;
    }
  };

  window.addEventListener('copy', handleCopy, true);
  try {
    copied = document.execCommand('copy') && copied;
  } catch {
    copied = false;
  } finally {
    window.removeEventListener('copy', handleCopy, true);
  }

  if (activeElement?.isConnected) {
    activeElement.focus({ preventScroll: true });
  }
  if (selection && savedRanges.length > 0) {
    selection.removeAllRanges();
    savedRanges.forEach((range) => selection.addRange(range));
  }
  return copied;
}

export type RichClipboardResult = 'rich' | 'plain' | 'too-large' | false;

export async function copyRichTextToClipboard(html: string, text: string): Promise<RichClipboardResult> {
  if (html.length > MAX_RICH_CLIPBOARD_OUTPUT_LENGTH) {
    return await copyTextToClipboard(text) ? 'too-large' : false;
  }
  if (!html) {
    return await copyTextToClipboard(text) ? 'plain' : false;
  }
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return 'rich';
    }
  } catch {
  }
  try {
    if (copyRichTextWithFallback(html, text)) return 'rich';
  } catch {
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return 'plain';
    }
  } catch {
  }
  return false;
}

interface CopyPlan {
  html: string | null;
  text: string;
  reason?: 'too-large' | 'no-markup';
  truncatedTo?: number;
}

function planCopy(source: RichCopySource, fallbackText: string): CopyPlan {
  if (!source) return { html: null, text: fallbackText, reason: 'no-markup' };
  const text = source.text || fallbackText;
  const truncatedTo = source.truncated ? text.length : undefined;
  if ('tooLarge' in source) return { html: null, text, reason: 'too-large', truncatedTo };
  if (!source.html) return { html: null, text, reason: 'no-markup', truncatedTo };
  if (source.html.length > MAX_RICH_CLIPBOARD_OUTPUT_LENGTH) {
    return { html: null, text, reason: 'too-large', truncatedTo };
  }
  return { html: source.html, text, truncatedTo };
}

export function plainTextClipboardHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<pre>${escaped}</pre>`;
}

async function copyPlanned(plan: CopyPlan): Promise<RichCopyOutcome | false> {
  if (plan.html === null) {
    return await copyTextToClipboard(plan.text)
      ? { copied: 'plain', reason: plan.reason, truncatedTo: plan.truncatedTo }
      : false;
  }
  const result = await copyRichTextToClipboard(plan.html, plan.text);
  if (result === 'rich') return { copied: 'rich', truncatedTo: plan.truncatedTo };
  if (result === 'plain') return { copied: 'plain', reason: 'unavailable', truncatedTo: plan.truncatedTo };
  if (result === 'too-large') return { copied: 'plain', reason: 'too-large', truncatedTo: plan.truncatedTo };
  return false;
}

export async function copyRichSelection(
  build: () => RichCopySource | Promise<RichCopySource>,
  fallbackText: string,
): Promise<RichCopyOutcome | false> {
  let source: RichCopySource | Promise<RichCopySource>;
  try {
    source = build();
  } catch {
    source = null;
  }
  if (!(source instanceof Promise)) return copyPlanned(planCopy(source, fallbackText));

  const plan = source.then(
    (value) => planCopy(value, fallbackText),
    () => planCopy(null, fallbackText),
  );
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({
        'text/html': plan.then((p) =>
          new Blob([p.html ?? plainTextClipboardHtml(p.text)], { type: 'text/html' })),
        'text/plain': plan.then((p) => new Blob([p.text], { type: 'text/plain' })),
      });
      await navigator.clipboard.write([item]);
      const done = await plan;
      return done.html !== null
        ? { copied: 'rich', truncatedTo: done.truncatedTo }
        : { copied: 'plain', reason: done.reason, truncatedTo: done.truncatedTo };
    } catch {
    }
  }
  return copyPlanned(await plan);
}
