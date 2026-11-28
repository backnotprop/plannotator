/**
 * Which Mermaid fences in a plan are drawn. A plan is an agent's text, and Mermaid loads a node picture (`img:`) with
 * `new Image()` while it draws, before any sanitizer, so a fence that could load anything is shown as its source. What
 * regresses if this fails: opening a plan tells a third party you read it, or a click in a diagram takes the tab.
 */
import { expect, test } from 'bun:test';
import { isMovingDataImage, mermaidMayLoad, mermaidMayReachAnotherHost, planBlocks } from './planContent';
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
  // Re-check 3: a numeric reference without `;` (an HTML parser decodes it) on an attribute that loads.
  'flowchart TD\n  A["<table background=\'https&#58tracker.example/p.png\'><tr><td>x</td></tr></table>"]',
  'flowchart TD\n  A["<td background=\'https&#x3atracker.example/p.png\'>x</td>"]',
  'flowchart TD\n  A["https&colontracker.example/p.png"]',
  'flowchart TD\n  A["<td background=\'p.png\'>x</td>"]',
  'flowchart TD\n  A["</b>"]',
  'flowchart TD\n  A["<!-- x -->"]',
  'flowchart TD\n  A["<?xml x?>"]',
  'flowchart TD\n  A["<br onload=x>"]',
  // Mermaid's `#amp;` could rebuild an `&` reference.
  'flowchart TD\n  A["https#amp;#35;58;tracker.example"]',
  // Re-check 4: Mermaid's own placeholders (`ﬂ°°` is `&#`, `ﬂ°` is `&`, `¶ß` is `;` across the svg it writes).
  'sequenceDiagram\n  participant Alice\n  properties Alice: {"icon": "httpsﬂ°°58¶ßﬂ°°47¶ßﬂ°°47¶ßtracker.example/p.png"}\n  Alice->>Bob: hi',
  'sequenceDiagram\n  participant Alice\n  properties Alice: {"icon": "httpsﬂ°colon¶ßﬂ°sol¶ßﬂ°sol¶ßtracker.example/p.png"}\n  Alice->>Bob: hi',
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
    // A repo layout, Mermaid's quote escape, a line break, the `&` join with spaces, a class annotation, arrows.
    'flowchart LR\n  src --> build --> dist',
    'flowchart TD\n  A[src/app.ts] --> B[dist/app.js]',
    'flowchart TD\n  A["He said #quot;hi#quot;"]',
    'flowchart TD\n  A["one<br/>two"] --> B["three<br>four<BR />five"]',
    'flowchart TD\n  A & B --> C',
    'classDiagram\n  class Shape {\n    <<interface>>\n    +area() double\n  }\n  Shape <|-- Circle',
    'flowchart LR\n  A <--> B\n  B <-.-> C',
  ];
  for (const source of plain) expect([source, mermaidMayLoad(source)]).toEqual([source, false]);
  // Accepted: Mermaid's join written without spaces shows as source (`&` and a letter is a named reference).
  expect(mermaidMayLoad('flowchart TD\n  A&B --> C')).toBe(true);
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

test('a moving picture is caught however it is written; a still one is not', () => {
  const svg = (body: string) => `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100%'>${body}</svg>`;
  // A bare "%" in a utf8 SVG (its width) does not make it read as still.
  expect(isMovingDataImage(svg("<circle r='4'><animate attributeName='r' values='4;8' dur='1s'/></circle>"))).toBe(true);
  expect(isMovingDataImage(svg("<circle r='4'/>"))).toBe(false);
  // CSS motion inside it, by any of its names: `animation-name`, a vendor's keyframes, a transition.
  expect(isMovingDataImage(svg('<style>circle{animation-name:x}</style><circle r="4"/>'))).toBe(true);
  expect(isMovingDataImage(svg('<style>@-webkit-keyframes x{to{opacity:0}}</style>'))).toBe(true);
  expect(isMovingDataImage(svg('<style>circle{transition-duration:1s}</style>'))).toBe(true);
  // Written with XML references or CSS escapes.
  expect(isMovingDataImage(svg('<style>circle{&#97;nimation:x 1s}</style>'))).toBe(true);
  expect(isMovingDataImage(svg('<style>circle{\\61nimation:x 1s}</style>'))).toBe(true);
  // An entity could add one; a picture inside it that moves.
  expect(isMovingDataImage(svg('<!ENTITY a "b">'))).toBe(true);
  // Percent-encoded, and base64.
  expect(isMovingDataImage(`data:image/svg+xml,${encodeURIComponent("<svg><set attributeName='x' to='1'/></svg>")}`)).toBe(true);
  expect(isMovingDataImage(`data:image/svg+xml;base64,${btoa("<svg><animateTransform attributeName='transform'/></svg>")}`)).toBe(true);
  expect(isMovingDataImage('data:image/svg+xml;base64,@@not base64@@')).toBe(true);
  // A GIF of two frames moves; one frame does not. An APNG moves; a type it does not know counts as moving.
  const still = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  expect(isMovingDataImage(`data:image/gif;base64,${still}`)).toBe(false);
  const two = atob(still).replace(/;$/, '') + atob(still).slice(atob(still).indexOf(',')) ;
  expect(isMovingDataImage(`data:image/gif;base64,${btoa(two)}`)).toBe(true);
  expect(isMovingDataImage(`data:image/png;base64,${btoa('\x89PNG\r\n\x1a\n....acTL')}`)).toBe(true);
  expect(isMovingDataImage('data:image/jxl;base64,AAAA')).toBe(true);
  expect(isMovingDataImage('data:image/jpeg;base64,/9j/4AAQ')).toBe(false);
});
