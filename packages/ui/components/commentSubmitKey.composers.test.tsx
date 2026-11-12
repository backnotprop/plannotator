import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AnnotationType, type Annotation, type CodeAnnotation } from '../types';
import {
  describeCommentSubmitKeys,
  pressKey,
  setEnterSavesComment,
  typeInto,
} from '../test-setup/commentSubmitKeys';
import {
  resetSkillCatalogCache,
  resetSkillCatalogTransport,
  setSkillCatalogTransport,
} from '../utils/skillCatalog';

const hasDom = typeof document !== 'undefined';
const skip = !hasDom;

// Lazily loaded so the DOM-less default `bun test` run never imports them.
const { CommentPopover } = hasDom ? await import('./CommentPopover') : ({} as typeof import('./CommentPopover'));
const { AnnotationPanel } = hasDom ? await import('./AnnotationPanel') : ({} as typeof import('./AnnotationPanel'));
const { DecisionNoteField } = hasDom ? await import('./DecisionControl') : ({} as typeof import('./DecisionControl'));
const { DiagramComposer } = hasDom ? await import('./diagram/DiagramComposer') : ({} as typeof import('./diagram/DiagramComposer'));
const { Settings } = hasDom ? await import('./Settings') : ({} as typeof import('./Settings'));
const { configStore } = await import('../config/configStore');

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(node: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  await act(async () => {});
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
  resetSkillCatalogCache();
  resetSkillCatalogTransport();
});

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

async function mountPopover(text: string, onSubmit: () => void, skillReferences = false) {
  await render(
    <CommentPopover
      anchorRect={new DOMRect(100, 100, 60, 20)}
      contextText="selected text"
      isGlobal={false}
      onSubmit={onSubmit}
      onClose={() => {}}
      skillReferences={skillReferences}
    />,
  );
  await typeInto(must<HTMLTextAreaElement>('[data-comment-popover] textarea'), text);
}

describeCommentSubmitKeys('CommentPopover', async (text) => {
  let saves = 0;
  await mountPopover(text, () => { saves++; });
  return { field: () => must('[data-comment-popover] textarea'), saves: () => saves };
}, { skip });

describe('CommentPopover with the skill menu open', () => {
  test.skipIf(skip)('on: Enter on an arrowed-to row inserts the skill and does not save', async () => {
    try {
      await setEnterSavesComment(true);
      setSkillCatalogTransport(async () => [{ name: 'animate', root: 'claude', humanOnly: false }]);
      let saves = 0;
      await mountPopover('use /an', () => { saves++; }, true);
      const el = must<HTMLTextAreaElement>('[data-comment-popover] textarea');
      await typeInto(el, 'use /an');
      await act(async () => {});
      expect(document.querySelector('[data-skill-menu]')).not.toBeNull();
      await pressKey(el, 'ArrowDown');
      const enter = await pressKey(el, 'Enter');
      expect(enter.defaultPrevented).toBe(true);
      expect(saves).toBe(0);
      expect(el.value).toContain('animate');
    } finally {
      await setEnterSavesComment(false);
    }
  });
});

describe('CommentPopover with the skill menu open and no row active', () => {
  test.skipIf(skip)('on: Enter saves (the menu takes Enter only for an arrowed-to row)', async () => {
    try {
      await setEnterSavesComment(true);
      setSkillCatalogTransport(async () => [{ name: 'animate', root: 'claude', humanOnly: false }]);
      let saves = 0;
      await mountPopover('use /an', () => { saves++; }, true);
      const el = must<HTMLTextAreaElement>('[data-comment-popover] textarea');
      await act(async () => {});
      expect(document.querySelector('[data-skill-menu]')).not.toBeNull();
      expect(document.querySelector('[data-skill-item-active]')).toBeNull();
      const enter = await pressKey(el, 'Enter');
      expect(enter.defaultPrevented).toBe(true);
      expect(saves).toBe(1);
    } finally {
      await setEnterSavesComment(false);
    }
  });
});

const ANNOTATION: Annotation = {
  id: 'a1',
  blockId: 'b1',
  startOffset: 0,
  endOffset: 5,
  type: AnnotationType.COMMENT,
  text: 'ping',
  originalText: 'hello world',
  createdA: 1700000000000,
  author: 'someone',
};

describeCommentSubmitKeys('AnnotationPanel text comment edit', async (text) => {
  const edits: unknown[] = [];
  await render(
    <AnnotationPanel
      isOpen
      blocks={[]}
      annotations={[ANNOTATION]}
      selectedId={null}
      onSelect={() => {}}
      onDelete={() => {}}
      onEdit={(_id, updates) => { edits.push(updates); }}
      mentionSource={{ people: [{ id: 'u1', label: 'Marcus Chen', kind: 'user', detail: null, canOpen: true }] }}
    />,
  );
  await act(async () => must<HTMLButtonElement>('button[title="Edit annotation"]').click());
  await typeInto(must<HTMLTextAreaElement>('[data-annotation-id] textarea'), text);
  return { field: () => must('[data-annotation-id] textarea'), saves: () => edits.length };
}, { skip });

describe('AnnotationPanel edit box with the mention menu open', () => {
  test.skipIf(skip)('on: Enter on an arrowed-to person inserts them and does not save', async () => {
    try {
      await setEnterSavesComment(true);
      const edits: unknown[] = [];
      await render(
        <AnnotationPanel
          isOpen
          blocks={[]}
          annotations={[ANNOTATION]}
          selectedId={null}
          onSelect={() => {}}
          onDelete={() => {}}
          onEdit={(_id, updates) => { edits.push(updates); }}
          mentionSource={{ people: [{ id: 'u1', label: 'Marcus Chen', kind: 'user', detail: null, canOpen: true }] }}
        />,
      );
      await act(async () => must<HTMLButtonElement>('button[title="Edit annotation"]').click());
      const el = must<HTMLTextAreaElement>('[data-annotation-id] textarea');
      await typeInto(el, 'ping @mar');
      await pressKey(el, 'ArrowDown');
      const enter = await pressKey(el, 'Enter');
      expect(enter.defaultPrevented).toBe(true);
      expect(el.value).toBe('ping @Marcus Chen ');
      expect(edits).toEqual([]);
      await pressKey(el, 'Enter');
      expect(edits.length).toBe(1);
    } finally {
      await setEnterSavesComment(false);
    }
  });
});

describe('AnnotationPanel edit box with the mention menu open and no row active', () => {
  test.skipIf(skip)('on: Enter saves', async () => {
    try {
      await setEnterSavesComment(true);
      const edits: unknown[] = [];
      await render(
        <AnnotationPanel
          isOpen
          blocks={[]}
          annotations={[ANNOTATION]}
          selectedId={null}
          onSelect={() => {}}
          onDelete={() => {}}
          onEdit={(_id, updates) => { edits.push(updates); }}
          mentionSource={{ people: [{ id: 'u1', label: 'Marcus Chen', kind: 'user', detail: null, canOpen: true }] }}
        />,
      );
      await act(async () => must<HTMLButtonElement>('button[title="Edit annotation"]').click());
      const el = must<HTMLTextAreaElement>('[data-annotation-id] textarea');
      await typeInto(el, 'ping @ma');
      expect(document.querySelector('[data-mention-picker]')).not.toBeNull();
      expect(el.hasAttribute('aria-activedescendant')).toBe(false);
      await pressKey(el, 'Enter');
      expect(edits).toEqual([{ text: 'ping @ma' }]);
    } finally {
      await setEnterSavesComment(false);
    }
  });
});

const CODE_ANNOTATION: CodeAnnotation = {
  id: 'c1',
  type: 'comment',
  filePath: 'src/a.ts',
  lineStart: 3,
  lineEnd: 3,
  side: 'new',
  text: 'old remark',
  createdAt: 1,
};

describeCommentSubmitKeys('AnnotationPanel code comment edit', async (text) => {
  const edits: unknown[] = [];
  await render(
    <AnnotationPanel
      isOpen
      blocks={[]}
      annotations={[]}
      codeAnnotations={[CODE_ANNOTATION]}
      selectedId={null}
      onSelect={() => {}}
      onDelete={() => {}}
      onEditCodeAnnotation={(_id, updates) => { edits.push(updates); }}
    />,
  );
  await act(async () => must<HTMLButtonElement>('[data-annotation-id="c1"] button[title="Edit annotation"]').click());
  await typeInto(must<HTMLTextAreaElement>('[data-annotation-id="c1"] textarea'), text);
  return { field: () => must('[data-annotation-id="c1"] textarea'), saves: () => edits.length };
}, { skip });

describeCommentSubmitKeys('DecisionNoteField as a comment (enterSubmits from the setting)', async (text) => {
  let saves = 0;
  function Harness() {
    const [value, setValue] = React.useState('');
    const enterSaves = configStore.get('enterSavesComment');
    return (
      <DecisionNoteField
        text={value}
        onTextChange={setValue}
        onSubmit={() => { saves++; }}
        onCancel={() => {}}
        enterSubmits={enterSaves}
      />
    );
  }
  await render(<Harness />);
  await typeInto(must<HTMLTextAreaElement>('[data-decision-note-input]'), text);
  return { field: () => must('[data-decision-note-input]'), saves: () => saves };
}, { skip });

describe('DecisionNoteField in the decision control (no enterSubmits)', () => {
  test.skipIf(skip)('on: Enter stays a new line; only Cmd/Ctrl+Enter fires the decision', async () => {
    try {
      await setEnterSavesComment(true);
      let saves = 0;
      function Harness() {
        const [value, setValue] = React.useState('');
        return <DecisionNoteField text={value} onTextChange={setValue} onSubmit={() => { saves++; }} onCancel={() => {}} />;
      }
      await render(<Harness />);
      const el = must<HTMLTextAreaElement>('[data-decision-note-input]');
      await typeInto(el, 'a note');
      const enter = await pressKey(el, 'Enter');
      expect(enter.defaultPrevented).toBe(false);
      expect(saves).toBe(0);
      await pressKey(el, 'Enter', { ctrlKey: true });
      expect(saves).toBe(1);
    } finally {
      await setEnterSavesComment(false);
    }
  });
});

describe('DiagramComposer', () => {
  async function mountDiagram(onSubmit: () => void) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    await render(
      <DiagramComposer
        draft={{ primary: { element, target: { family: 'flowchart', kind: 'node', id: 'A', label: 'Start' } }, additional: [], sourceLine: [1, 1] }}
        anchorRect={{ left: 10, top: 10, width: 20, height: 20 }}
        hostWidth={800}
        sourceDirty={false}
        submitting={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    const el = must<HTMLTextAreaElement>('textarea');
    await typeInto(el, 'why this node');
    return el;
  }

  for (const on of [false, true]) {
    test.skipIf(skip)(`setting ${on ? 'on' : 'off'}: Enter saves, Shift+Enter and an IME Enter do not`, async () => {
      try {
        await setEnterSavesComment(on);
        let saves = 0;
        const el = await mountDiagram(() => { saves++; });
        await pressKey(el, 'Enter', { shiftKey: true });
        await pressKey(el, 'Enter', { isComposing: true, keyCode: 229 });
        await pressKey(el, 'Enter', { keyCode: 229 });
        expect(saves).toBe(0);
        await pressKey(el, 'Enter');
        expect(saves).toBe(1);
      } finally {
        await setEnterSavesComment(false);
      }
    });
  }
});

describe('Settings → General → "Enter saves a comment"', () => {
  for (const mode of ['plan', 'annotate', 'review'] as const) {
    test.skipIf(skip)(`${mode}: off by default, and the switch turns the setting on and off`, async () => {
      try {
        await setEnterSavesComment(false);
        await render(
          <Settings
            taterMode={false}
            onTaterModeChange={() => {}}
            mode={mode}
            annotateParity={mode === 'annotate'}
            externalOpen
          />,
        );
        const toggle = must<HTMLButtonElement>('[data-enter-saves-comment-setting] button[role="switch"]');
        expect(toggle.getAttribute('aria-label')).toBe('Enter saves a comment');
        expect(toggle.getAttribute('aria-checked')).toBe('false');
        await act(async () => toggle.click());
        expect(configStore.get('enterSavesComment')).toBe(true);
        expect(toggle.getAttribute('aria-checked')).toBe('true');
        await act(async () => toggle.click());
        expect(configStore.get('enterSavesComment')).toBe(false);
      } finally {
        await setEnterSavesComment(false);
      }
    });
  }

  test.skipIf(skip)('a host that passes hideEnterSavesComment gets no row', async () => {
    await render(<Settings taterMode={false} onTaterModeChange={() => {}} mode="plan" externalOpen hideEnterSavesComment />);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-enter-saves-comment-setting]')).toBeNull();
  });
});
