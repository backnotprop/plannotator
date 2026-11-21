/**
 * `mermaidSourceLoads`: the Mermaid sources `renderDiagram` shows as their
 * source because Mermaid would load from another host while drawing them,
 * before any sanitizer runs (proven in a browser by
 * tests/e2e/diagram-label-scrub.spec.ts).
 *
 * What regresses if these fail: a spelling of CSS that names another host
 * (an escape, an entity, a directive, front matter, a style line) or a
 * picture node gets drawn and fetched; or a diagram that loads nothing
 * (a `#fragment`, a relative or `data:` address, prose that mentions `url`)
 * stops drawing.
 */
import { describe, expect, test } from 'bun:test';
import { mermaidSourceLoads } from './mermaidSourceLoads';

const flow = (label: string) => `flowchart LR\n  A["${label}"] --> B`;

const LOADS = [
  flow("<span style='background:url(https://evil.test/a.png)'>x</span>"),
  flow("<span style='background:url( \"//evil.test/a.png\" )'>x</span>"),
  flow("<span style='background:URL(HTTPS://evil.test/a.png)'>x</span>"),
  flow("<span style='background-image:image-set(\"a.png\" 1x, \"https://evil.test/b.png\" 2x)'>x</span>"),
  flow("<span style='background-image:-webkit-image-set(url(https://evil.test/b.png) 1x)'>x</span>"),
  flow("<span style='background:u\\72l(https://evil.test/a.png)'>x</span>"),
  flow("<span style='background:url(https\\3a //evil.test/a.png)'>x</span>"),
  flow("<span style='background:url(ht\\9 tps://evil.test/a.png)'>x</span>"),
  flow("<span style='background:url&#40;https://evil.test/a.png)'>x</span>"),
  flow("<span style='background:url&#x28;https://evil.test/a.png)'>x</span>"),
  flow("<span style='background:url#40;https://evil.test/a.png)'>x</span>"),
  flow("<span style='background:url(\\\\evil.test/a.png)'>x</span>"),
  '%%{init: {"themeCSS": ".nodeLabel { background: url(https://evil.test/t.png) }"}}%%\nflowchart LR\n  A --> B',
  '%%{init: {"themeCSS": "@import \\"https://evil.test/i.css\\";"}}%%\nflowchart LR\n  A --> B',
  '%%{init: {"fontFamily": "x; background-image: url(https://evil.test/f.png)"}}%%\nflowchart LR\n  A --> B',
  '---\nconfig:\n  themeCSS: ".nodeLabel { background: url(https://evil.test/m.png) }"\n---\nflowchart LR\n  A --> B',
  'stateDiagram-v2\n  classDef bad background-image:url(https://evil.test/s.png)\n  [*] --> s1\n  class s1 bad',
  'classDiagram\n  class A\n  style A fill:url(https://evil.test/c.svg)',
  // A picture node loads its picture before anything is drawn, whatever its address.
  'flowchart LR\n  A@{ img: "https://evil.test/p.png", label: "pic" } --> B',
  'flowchart LR\n  A@{ img: "logo.png" } --> B',
  'flowchart LR\n  A@{ "img": "https://evil.test/p.png" } --> B',
  'flowchart LR\n  A@{ "\\x69mg": "https://evil.test/p.png" } --> B',
  'flowchart LR\n  A@{ label: "x",\n    img: https://evil.test/p.png } --> B',
];

const DRAWS = [
  'flowchart LR\n  A[Start] -->|yes| B{Decide}\n  B --> C(Done)\n  classDef hot fill:#f96,stroke:#333,color:#fff\n  class A hot\n  style B fill:#bbf,stroke:#f66,stroke-width:2px,color:#fff,stroke-dasharray: 5 5',
  flow("<b>Bold</b> <i>it</i><br><span style='color:red;font-size:18px'>red</span>"),
  flow('see <a href=\'https://example.org/docs\'>docs</a> at https://example.org'),
  flow('fill: url(#grad), url(img.png), url(data:image/png;base64,AAAA//8=) and src(local.woff)'),
  flow('curl(https://example.org) and @import order'),
  'flowchart LR\n  A --> B\n  click A "https://example.org" "tip"',
  '%%{init: {"theme": "forest", "fontFamily": "Inter, sans-serif", "themeCSS": ".node rect { fill: url(#g) }"}}%%\nflowchart LR\n  A --> B',
  'flowchart LR\n  A@{ shape: rounded, label: "Image of a cat" } --> B',
  'flowchart LR\n  A["R&D #amp; ops #quot;x#quot; color:#fff;"] --> B',
];

describe('mermaidSourceLoads', () => {
  test('refuses every spelling of CSS that names another host, and every picture node', () => {
    for (const source of LOADS) expect([source, mermaidSourceLoads(source)]).toEqual([source, true]);
  });

  test('lets every diagram that loads nothing draw', () => {
    for (const source of DRAWS) expect([source, mermaidSourceLoads(source)]).toEqual([source, false]);
  });
});

describe.if(typeof document !== 'undefined')('mermaidSourceLoads with the page\'s HTML parser', () => {
  test('reads named character references the way the page will', () => {
    expect(mermaidSourceLoads(flow("<span style='background:url&lpar;https&colon;&sol;&sol;evil.test/a.png)'>x</span>"))).toBe(true);
    expect(mermaidSourceLoads(flow('R&amp;D &lt;b&gt; &lpar;note&rpar;'))).toBe(false);
  });
});
