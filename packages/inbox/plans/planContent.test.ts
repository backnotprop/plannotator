/**
 * Which Mermaid fences in a plan are drawn. A plan is an agent's text, and Mermaid loads a node picture (`img:`) with
 * `new Image()` while it draws, before any sanitizer, so a fence that could load anything is shown as its source. What
 * regresses if this fails: opening a plan tells a third party you read it, or a click in a diagram takes the tab.
 */
import { expect, test } from 'bun:test';
import { mermaidMayLoad, mermaidMayReachAnotherHost, planBlocks } from './planContent';
import type { Block } from '@plannotator/ui/types';

const reachesAnotherHost = [
  // The re-check's bypasses: a quoted key and a scheme with no `//` (`https:host/x` resolves to `host`).
  'flowchart TD\n  A@{ "img": "https:tracker.example/p.png" }',
  "flowchart TD\n  A@{ 'img': 'https:tracker.example/p.png' }",
  'flowchart TD\n  A@{ "im\\x67": "https:\\x2F\\x2Ftracker.example/p.png" }',
  'flowchart TD\n  A@{ label: "x", "pic": "HTTPS:tracker.example/p.png" }',
  'kanban\n  todo[Todo]\n    t1[Task]@{ "img": "https:tracker.example/k.png" }',
  '%%{init: {"themeCSS": ".node rect { background-image: u\\\\72l(https:tracker.example/f.png) }"}}%%\nflowchart TD\n  A --> B',
  'flowchart TD\n  A --> B\n  classDef c background:u\\72l(tracker.example/f.png)',
  // Spelled indirectly: a tab or line break inside the scheme (a URL parser drops them), a backslash, references.
  'flowchart TD\n  A@{ "pic": "ht\ttps:tracker.example/p.png" }',
  'flowchart TD\n  A@{ "pic": "ht\ntps:tracker.example/p.png" }',
  'flowchart TD\n  A@{ "pic": "\\\\\\\\tracker.example/p.png" }',
  'flowchart TD\n  A["https&#58;tracker.example"]',
  'flowchart TD\n  A["https#58;tracker.example"]',
  'flowchart TD\n  A["https#058;tracker.example"]',
  'flowchart TD\n  A["https&#x3a;tracker.example"]',
  'flowchart TD\n  A["https&colon;tracker.example"]',
  'flowchart TD\n  A["#sol;#sol;tracker.example"]',
  'flowchart TD\n  A["&amp;#58;"]',
];

test('a Mermaid source that could load something, or navigate on a click, is caught; a plain diagram is not', () => {
  const loads = [
    'flowchart TD\n  A@{ img: "https://tracker.example/p.png" }',
    'flowchart TD\n  A@{ img: "shots/a.png", label: "x" }',
    'flowchart TD\n  A@{ IMG : "//tracker.example/p.png" }',
    'flowchart TD\n  A["<img src=\'https://tracker.example/p.png\'>"]',
    'flowchart TD\n  A["#lt;img src=x#gt;"]',
    'flowchart TD\n  A["&lt;img src=x&gt;"]',
    'flowchart TD\n  A["#60;image href=x#62;"]',
    '%%{init: {"themeCSS": ".node rect { fill: url(https://tracker.example/f.svg) }"}}%%\nflowchart TD\n  A --> B',
    '%%{init: {"themeCSS": "@import \'x.css\';"}}%%\nflowchart TD\n  A --> B',
    'flowchart TD\n  A --> B\n  style A fill:url(#x)',
    'flowchart TD\n  A --> B\n  click A href "docs/spec.md"',
    'flowchart TD\n  A --> B\n  click A "docs/spec.md"',
    'flowchart TD\n  A["see https://example.com"]',
  ];
  for (const source of [...loads, ...reachesAnotherHost]) expect([source, mermaidMayLoad(source)]).toEqual([source, true]);
  // The principle holds on its own, whatever the feature: every address to another host, however spelled, is caught.
  for (const source of reachesAnotherHost) expect([source, mermaidMayReachAnotherHost(source)]).toEqual([source, true]);

  const plain = [
    'flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship]\n  B -->|no| A',
    'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi',
    'flowchart TD\n  A@{ shape: rounded, label: "Image pipeline" }',
    'flowchart TD\n  imgCache[Image cache] --> clickHandler[Click handler]',
    // `:` in labels, `%%` comments, plain colours (with and without a trailing `;`), a non-ASCII reference.
    'flowchart LR\n  %% the release path\n  A["Step 1: build"] --> B["Step 2: ship"]\n  style A fill:#f9f,stroke:#333,stroke-width:4px\n  classDef done fill:#9f6,color:#fff;\n  class B done',
    'flowchart TD\n  A["Caf#233;"] --> B["#9829; it"]',
    'stateDiagram-v2\n  [*] --> Draft\n  Draft --> Review: submit\n  Review --> [*]',
  ];
  for (const source of plain) expect([source, mermaidMayLoad(source)]).toEqual([source, false]);
});

test('only a Mermaid fence that could load something is shown as its source; other blocks are untouched', () => {
  const code = (id: string, language: string, content: string): Block => ({ id, type: 'code', language, content, order: 0, startLine: 1 }) as Block;
  const blocks = [
    code('a', 'mermaid', 'flowchart TD\n  A@{ img: "https://tracker.example/p.png" }'),
    code('b', 'mermaid', 'flowchart TD\n  A --> B'),
    code('c', 'ts', 'const url = "https://example.com";'),
  ];
  expect(planBlocks(blocks).map((b) => b.language)).toEqual(['text', 'mermaid', 'ts']);
  expect(planBlocks(blocks)[0]!.content).toBe(blocks[0]!.content);
});
