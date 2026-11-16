/**
 * Which Mermaid fences in a plan are drawn. A plan is an agent's text, and Mermaid loads a node picture (`img:`) with
 * `new Image()` while it draws, before any sanitizer, so a fence that could load anything is shown as its source. What
 * regresses if this fails: opening a plan tells a third party you read it, or a click in a diagram takes the tab.
 */
import { expect, test } from 'bun:test';
import { mermaidMayLoad, planBlocks } from './planContent';
import type { Block } from '@plannotator/ui/types';

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
  for (const source of loads) expect([source, mermaidMayLoad(source)]).toEqual([source, true]);

  const plain = [
    'flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship]\n  B -->|no| A',
    'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi',
    'flowchart TD\n  A@{ shape: rounded, label: "Image pipeline" }',
    'flowchart TD\n  imgCache[Image cache] --> clickHandler[Click handler]',
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
