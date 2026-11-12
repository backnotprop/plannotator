import type { CodeNavHoverResponse } from '@plannotator/shared/code-nav';
import { SOURCES } from './fixture';

const KIND: [RegExp, string][] = [
  [/\bfunction\s+NAME\b/, 'function'],
  [/\b(?:const|let)\s+NAME\b/, 'const'],
  [/\binterface\s+NAME\b/, 'interface'],
  [/\btype\s+NAME\b/, 'type'],
];

function docAbove(lines: string[], i: number): string | null {
  let j = i - 1;
  if (j < 0) return null;
  if (/^\s*\/\/\s?/.test(lines[j])) return lines[j].replace(/^\s*\/\/\s?/, '').trim();
  if (!/\*\/\s*$/.test(lines[j])) return null;
  const out: string[] = [];
  for (; j >= 0; j--) {
    const l = lines[j];
    out.unshift(l.replace(/^\s*\/?\*+\/?\s?/, '').replace(/\*\/\s*$/, '').trim());
    if (/^\s*\/\*\*?/.test(l)) break;
  }
  const text = out.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 260 ? text.slice(0, 257).trimEnd() + '…' : text || null;
}

export function hoverFor(symbol: string): CodeNavHoverResponse | null {
  if (!/^[A-Za-z_$][\w$]{2,}$/.test(symbol)) return null;
  if (/^(const|function|return|export|import|type|interface|string|number|boolean|null|true|false|readonly|from|new|this|let|for|if|else)$/.test(symbol)) return null;
  let def: CodeNavHoverResponse['definition'] = null;
  const refs: CodeNavHoverResponse['references'] = [];
  for (const [path, text] of Object.entries(SOURCES)) {
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      if (!def) {
        for (const [rx, kind] of KIND) {
          if (new RegExp(rx.source.replace('NAME', symbol.replace(/\$/g, '\\$'))).test(l)) {
            def = {
              filePath: path, line: i + 1, column: l.indexOf(symbol) + 1, confidence: 'likely',
              symbolKind: kind as never, signature: l.trim().replace(/\s*\{\s*$/, '').slice(0, 160),
              signatureApproximate: true, doc: docAbove(lines, i), preview: null, otherCandidateCount: 0,
            };
            return;
          }
        }
      }
      const at = l.search(new RegExp(`\\b${symbol.replace(/\$/g, '\\$')}\\b`));
      if (at >= 0) refs.push({ filePath: path, line: i + 1, column: at + 1, snippet: l.trim() });
    });
  }
  if (!def) return null;
  const d = def as NonNullable<CodeNavHoverResponse['definition']>;
  const others = refs.filter((r) => !(r.filePath === d.filePath && r.line === d.line));
  return {
    backend: 'search', source: 'search', symbol, definition: d, alternateDefinition: null,
    references: others.slice(0, 4), referenceCount: others.length, capped: false, stats: { elapsedMs: 0 },
  } as CodeNavHoverResponse;
}
