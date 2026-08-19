import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CallFlowNode, CallFlowTree } from '@plannotator/shared/call-flow-types';
import {
  annotationSelectionForCallFlowNode,
  annotationTargetForCallFlowNode,
  CallFlowTreeView,
  selectionForCallFlowNode,
} from './CallFlowTreeView';

function node(overrides: Partial<CallFlowNode>): CallFlowNode {
  return {
    key: 'checkout -> authorize',
    label: 'authorize()',
    status: 'added',
    kind: 'call',
    file: 'src/checkout.ts',
    line: 41,
    children: [],
    ...overrides,
  };
}

function callTree(entry: string, tree: CallFlowNode): CallFlowTree {
  return { entry, raw: entry, rawLineStart: 1, tree };
}

describe('Call Flow source selections', () => {
  test('maps added and removed nodes to the native diff sides', () => {
    expect(selectionForCallFlowNode(node({ status: 'added', line: 41, endLine: 43 }))).toEqual({
      start: 41,
      end: 43,
      side: 'additions',
    });
    expect(selectionForCallFlowNode(node({ status: 'removed', line: 17 }))).toEqual({
      start: 17,
      end: 17,
      side: 'deletions',
    });
  });

  test('offers annotation source ranges for changed and unchanged located steps', () => {
    expect(annotationSelectionForCallFlowNode(node({ status: 'same' }))).toEqual({
      start: 41,
      end: 41,
      side: 'additions',
    });
    expect(annotationSelectionForCallFlowNode(node({ line: undefined }))).toBeNull();
    expect(annotationSelectionForCallFlowNode(node({ status: 'added' }))).toEqual({
      start: 41,
      end: 41,
      side: 'additions',
    });
  });

  test('carries the entry and source anchor into a durable Call Flow target', () => {
    expect(annotationTargetForCallFlowNode(node({ endLine: 43 }), 'checkout()', 'checkout:0/authorize:0')).toEqual({
      treePath: 'checkout:0/authorize:0',
      entry: 'checkout()',
      label: 'authorize()',
      filePath: 'src/checkout.ts',
      lineStart: 41,
      lineEnd: 43,
      side: 'new',
    });
  });

  test('carries a source-less structural row as a durable Call Flow target', () => {
    expect(annotationTargetForCallFlowNode(
      node({ kind: 'branch', file: undefined, line: undefined }),
      'checkout()',
      'checkout:0/branch:0',
    )).toEqual({
      treePath: 'checkout:0/branch:0',
      entry: 'checkout()',
      label: 'authorize()',
      side: 'new',
    });
  });

  test('keeps outside-patch rows annotatable while disabling only source navigation', () => {
    const treeNode = node({});
    const outside = renderToStaticMarkup(React.createElement(CallFlowTreeView, {
      trees: [callTree('checkout()', treeNode)],
      onOpenNode: () => {},
      onAnnotateTargets: () => true,
      canInteractWithNode: () => false,
    }));
    const inside = renderToStaticMarkup(React.createElement(CallFlowTreeView, {
      trees: [callTree('checkout()', treeNode)],
      onOpenNode: () => {},
      onAnnotateTargets: () => true,
      canInteractWithNode: () => true,
    }));

    expect(outside).toContain('disabled=""');
    expect(outside).toContain('Outside the reviewed patch');
    expect(outside).toContain('Comment on authorize() as Call Flow feedback');
    expect(outside).toContain('call-flow-row-selectable');
    expect(inside).toContain('Comment on authorize()');
    expect(inside).not.toContain('call-flow-comment');
  });

  test('separates entry paths at real cross-file boundaries', () => {
    const treeNode = node({
      children: [
        node({ key: 'same-file', label: 'validate()', file: 'src/checkout.ts', line: 42 }),
        node({ key: 'other-file', label: 'authorize()', file: 'src/auth.ts', line: 10 }),
      ],
    });
    const markup = renderToStaticMarkup(React.createElement(CallFlowTreeView, {
      trees: [callTree('checkout()', treeNode)],
      onOpenNode: () => {},
    }));

    expect(markup.match(/class="call-flow-file-boundary"/g)).toHaveLength(2);
    expect(markup).toContain('File boundary: src/checkout.ts');
    expect(markup).toContain('File boundary: src/auth.ts');
  });

  test('does not repeat a file boundary for consecutive sibling calls in the same file', () => {
    const treeNode = node({
      file: 'src/CallFlowFileBadge.tsx',
      children: [
        node({ key: 'memo-1', label: 'useMemo()', file: 'src/CallFlowTreeView.tsx', line: 303 }),
        node({ key: 'memo-2', label: 'useMemo()', file: 'src/CallFlowTreeView.tsx', line: 304 }),
        node({ key: 'state', label: 'useState()', file: 'src/CallFlowTreeView.tsx', line: 331 }),
      ],
    });
    const markup = renderToStaticMarkup(React.createElement(CallFlowTreeView, {
      trees: [callTree('CallFlowTreeView({})', treeNode)],
      onOpenNode: () => {},
    }));

    expect(markup.match(/class="call-flow-file-boundary"/g)).toHaveLength(2);
    expect(markup.match(/File boundary: src\/CallFlowTreeView\.tsx/g)).toHaveLength(1);
  });

  test('renders changed paths first while keeping full unchanged context available on demand', () => {
    const treeNode = node({
      status: 'same',
      children: [
        node({
          key: 'unchanged-context',
          label: 'unchangedContext()',
          status: 'same',
          children: [node({ key: 'deep-context', label: 'deepContext()', status: 'same' })],
        }),
        node({
          key: 'changed-path',
          label: 'changedPath()',
          status: 'same',
          children: [node({ key: 'changed-call', label: 'changedCall()', status: 'added' })],
        }),
      ],
    });
    const markup = renderToStaticMarkup(React.createElement(CallFlowTreeView, {
      trees: [callTree('checkout()', treeNode)],
      onOpenNode: () => {},
    }));

    expect(markup).not.toContain('unchangedContext()');
    expect(markup).not.toContain('deepContext()');
    expect(markup).toContain('changedPath()');
    expect(markup).toContain('changedCall()');
    expect(markup).toContain('aria-label="Collapse changedPath()"');
    expect(markup).toContain('more context steps hidden');
    expect(markup).toContain('Show all context');
  });

  test('shows adjacent structural context without expanding the complete tree', () => {
    const treeNode = node({
      status: 'same',
      children: [
        node({
          key: 'nearby-context',
          label: 'nearbyContext()',
          status: 'same',
          children: [node({ key: 'deep-context', label: 'deepContext()', status: 'same' })],
        }),
        node({ key: 'changed-call', label: 'changedCall()', status: 'added' }),
        node({ key: 'after-context', label: 'afterContext()', status: 'same' }),
      ],
    });
    const markup = renderToStaticMarkup(React.createElement(CallFlowTreeView, {
      trees: [callTree('checkout()', treeNode)],
      onOpenNode: () => {},
      initialContext: 'nearby',
    }));

    expect(markup).toContain('nearbyContext()');
    expect(markup).toContain('changedCall()');
    expect(markup).toContain('afterContext()');
    expect(markup).not.toContain('deepContext()');
    expect(markup).toContain('Show all context');
  });
});
