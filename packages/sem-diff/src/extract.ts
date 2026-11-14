// Extracted-function detection. Extraction is inlining run backwards: if the
// new file inlined back into the old one would be an inline of helper H into
// caller C, then the change old -> new extracted H out of C. We run the inline
// detector with the versions swapped and mirror its operation: old and new
// trade places, removed becomes introduced.
import type { Node } from 'web-tree-sitter';
import { detectInlined, DEFAULT_INLINE_OPTIONS, type InlineOptions } from './inline.ts';
import type { LanguageConfig } from './parse.ts';
import type { SemanticDiffOperation, SemanticDiffSpan } from './pierre-types.ts';

function mirrorSpan(s: SemanticDiffSpan): SemanticDiffSpan {
  // Role and kind are copied from a valid span, so their pairing (kind only on
  // focus spans) still holds; TypeScript cannot follow that through the union.
  const keep = { role: s.role, ...(s.kind ? { kind: s.kind } : {}) } as Pick<SemanticDiffSpan, 'role' | 'kind'>;
  if (s.relation === 'removed') return { ...keep, relation: 'introduced', new: s.old, ...(s.anchors ? { anchors: s.anchors } : {}) } as SemanticDiffSpan;
  if (s.relation === 'introduced') return { ...keep, relation: 'removed', old: s.new, ...(s.anchors ? { anchors: s.anchors } : {}) } as SemanticDiffSpan;
  return {
    ...keep,
    relation: s.relation,
    old: s.new,
    new: s.old,
    linePairs: s.linePairs.map((p) => ({ old: p.new, new: p.old })),
  } as SemanticDiffSpan;
}

export function detectExtracted(
  oldRoot: Node,
  newRoot: Node,
  newText: string,
  cfg: LanguageConfig,
  options: InlineOptions = DEFAULT_INLINE_OPTIONS
): SemanticDiffOperation[] {
  return detectInlined(newRoot, oldRoot, newText, cfg, { ...options, mirrored: true }).map((op) => ({
    type: 'extractedFunction',
    spans: op.spans.map(mirrorSpan),
    lines: { old: op.lines.new, new: op.lines.old },
  }));
}
