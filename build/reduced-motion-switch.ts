interface CssNode {
  type: string;
  parent?: CssNode;
  name?: string;
  params?: string;
  nodes?: CssNode[];
  selectors?: string[];
  clone(): CssNode;
  after(node: CssNode | CssNode[]): void;
  walkRules(callback: (rule: CssNode) => void): void;
  walkAtRules(name: string, callback: (atRule: CssNode) => void): void;
}

const REDUCE = /\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/i;
const NO_PREFERENCE = /\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/i;
const REDUCED = '[data-motion="reduced"]';

export function underMotion(selector: string, reduced: boolean): string {
  const mark = reduced ? REDUCED : `:not(${REDUCED})`;
  const trimmed = selector.trim();
  const root = /^(html|:root)(?![\w-])/i.exec(trimmed);
  if (root) return `${root[1]}:where(${mark})${trimmed.slice(root[1]!.length)}`;
  return `:where(:root${mark}) ${trimmed}`;
}

export function withoutReduce(params: string): string {
  return params
    .split(/\s+and\s+/i)
    .filter((part) => !REDUCE.test(part))
    .join(' and ')
    .trim();
}

function inKeyframes(rule: CssNode): boolean {
  for (let parent = rule.parent; parent; parent = parent.parent) if (parent.type === 'atrule' && /keyframes$/i.test(parent.name ?? '')) return true;
  return false;
}

function scope(container: CssNode, reduced: boolean): void {
  container.walkRules((rule) => {
    if (inKeyframes(rule) || !rule.selectors) return;
    rule.selectors = rule.selectors.map((selector) => underMotion(selector, reduced));
  });
}

export function reducedMotionSwitch() {
  return {
    postcssPlugin: 'plannotator-reduced-motion-switch',
    OnceExit(root: CssNode) {
      const reduce: CssNode[] = [];
      root.walkAtRules('media', (media) => {
        const params = media.params ?? '';
        if (NO_PREFERENCE.test(params)) scope(media, false);
        else if (REDUCE.test(params)) reduce.push(media);
      });
      for (const media of reduce) {
        const copy = media.clone();
        scope(copy, true);
        const rest = withoutReduce(media.params ?? '');
        if (rest) {
          copy.params = rest;
          media.after(copy);
        } else media.after([...(copy.nodes ?? [])]);
      }
    },
  };
}
