/**
 * "Enter saves a comment" (#1934) on code review's comment composers,
 * against the REAL components (DOM-gated, DOM_TESTS=1): the line-comment
 * toolbar (also the Inbox's guide comments), its expanded dialog, a file
 * comment's edit box, the sidebar's "+ Global comment", and an outdated
 * comment's edit box.
 *
 * Shared cases (off / on / Shift+Enter / Cmd+Enter / IME) come from
 * `describeCommentSubmitKeys`; the extra case here guards the suggested-code
 * field, where Enter must stay a new line whatever the setting says.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation } from '@plannotator/ui/types';
import {
  describeCommentSubmitKeys,
  pressKey,
  setEnterSavesComment,
  typeInto,
} from '../../ui/test-setup/commentSubmitKeys';

const hasDom = typeof document !== 'undefined';
const skip = !hasDom;

const { AnnotationToolbar } = hasDom ? await import('./AnnotationToolbar') : ({} as typeof import('./AnnotationToolbar'));
const { ExpandedCommentDialog } = hasDom ? await import('./ExpandedCommentDialog') : ({} as typeof import('./ExpandedCommentDialog'));
const { FileCommentCard } = hasDom ? await import('./FileCommentBanner') : ({} as typeof import('./FileCommentBanner'));
const { ReviewSidebar } = hasDom ? await import('./ReviewSidebar') : ({} as typeof import('./ReviewSidebar'));

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
});

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

// --- The line-comment toolbar ---

function Toolbar({ onSubmit, showSuggestedCode = false }: { onSubmit: () => void; showSuggestedCode?: boolean }) {
  const [comment, setComment] = useState('');
  const [code, setCode] = useState('');
  const ref = React.useRef<HTMLDivElement>(null);
  return (
    <AnnotationToolbar
      toolbarState={{ position: { top: 100, left: 300 }, range: { start: 6, end: 6, side: 'additions' } }}
      toolbarRef={ref}
      commentText={comment}
      setCommentText={setComment}
      suggestedCode={code}
      setSuggestedCode={setCode}
      showSuggestedCode={showSuggestedCode}
      setShowSuggestedCode={() => {}}
      askAIMode={false}
      setAskAIMode={() => {}}
      setShowCodeModal={() => {}}
      setShowCommentModal={() => {}}
      onSubmit={onSubmit}
      onDismiss={() => {}}
      onCancel={() => {}}
      conventionalCommentsEnabled={false}
      conventionalLabel={null}
      onConventionalLabelChange={() => {}}
      decorations={[]}
      onDecorationsChange={() => {}}
    />
  );
}

const COMMENT_FIELD = '.review-toolbar textarea[placeholder="Leave feedback..."]';

describeCommentSubmitKeys('review line comment toolbar', async (text) => {
  let saves = 0;
  await render(<Toolbar onSubmit={() => { saves++; }} />);
  await typeInto(must<HTMLTextAreaElement>(COMMENT_FIELD), text);
  return { field: () => must(COMMENT_FIELD), saves: () => saves };
}, { skip });

describe('review line comment toolbar: suggested code', () => {
  test.skipIf(skip)('on: Enter in the suggested code is a new line, not a save', async () => {
    try {
      await setEnterSavesComment(true);
      let saves = 0;
      await render(<Toolbar onSubmit={() => { saves++; }} showSuggestedCode />);
      const code = must<HTMLTextAreaElement>('.review-toolbar textarea.suggested-code-input');
      await typeInto(code, 'const a = 1;');
      const enter = await pressKey(code, 'Enter');
      expect(enter.defaultPrevented).toBe(false);
      expect(saves).toBe(0);
      await pressKey(code, 'Enter', { ctrlKey: true });
      expect(saves).toBe(1);
    } finally {
      await setEnterSavesComment(false);
    }
  });
});

// --- The expanded comment dialog ---

describeCommentSubmitKeys('review expanded comment dialog', async (text) => {
  let saves = 0;
  function Harness() {
    const [value, setValue] = useState('');
    return (
      <ExpandedCommentDialog
        title="Line 12"
        commentText={value}
        setCommentText={setValue}
        isEditing={false}
        canSubmit={value.trim().length > 0}
        onSubmit={() => { saves++; }}
        onCollapse={() => {}}
        onCancel={() => {}}
        autoFocus={false}
      />
    );
  }
  await render(<Harness />);
  await typeInto(must<HTMLTextAreaElement>('[role="dialog"] textarea'), text);
  return { field: () => must('[role="dialog"] textarea'), saves: () => saves };
}, { skip });

// --- A file comment's edit box ---

const FILE_COMMENT: CodeAnnotation = {
  id: 'f1',
  type: 'comment',
  scope: 'file',
  filePath: 'src/a.ts',
  lineStart: 0,
  lineEnd: 0,
  side: 'new',
  text: 'old file remark',
  createdAt: 1,
};

describeCommentSubmitKeys('review file comment edit', async (text) => {
  const edits: string[] = [];
  await render(
    <FileCommentCard
      comment={FILE_COMMENT}
      isSelected={false}
      onSelect={() => {}}
      onEdit={(_id, value) => { edits.push(value); }}
      onDelete={() => {}}
    />,
  );
  await act(async () => must<HTMLButtonElement>('[data-annotation-id="f1"] button[title="Edit"]').click());
  await typeInto(must<HTMLTextAreaElement>('[data-annotation-id="f1"] textarea'), text);
  return { field: () => must('[data-annotation-id="f1"] textarea'), saves: () => edits.length };
}, { skip });

// --- The sidebar: "+ Global comment" and an outdated comment's edit box ---

describeCommentSubmitKeys('review sidebar general comment', async (text) => {
  const added: string[] = [];
  await render(
    <ReviewSidebar
      isOpen
      onClose={() => {}}
      activeTab="annotations"
      annotations={[]}
      files={[]}
      selectedAnnotationId={null}
      onSelectAnnotation={() => {}}
      onNavigateToAnnotation={() => {}}
      onDeleteAnnotation={() => {}}
      onAddGeneralComment={(value) => added.push(value)}
    />,
  );
  await act(async () => must<HTMLButtonElement>('[data-add-general-comment]').click());
  const field = '[data-review-general-composer] [data-decision-note-input]';
  await typeInto(must<HTMLTextAreaElement>(field), text);
  return { field: () => must(field), saves: () => added.length };
}, { skip });

const OUTDATED: CodeAnnotation = {
  id: 'stale',
  type: 'comment',
  scope: 'line',
  filePath: 'src/a.ts',
  lineStart: 9,
  lineEnd: 9,
  side: 'new',
  text: 'stale remark',
  createdAt: 1,
  outdated: true,
};

describeCommentSubmitKeys('review sidebar outdated comment edit', async (text) => {
  const edits: string[] = [];
  await render(
    <ReviewSidebar
      isOpen
      onClose={() => {}}
      activeTab="annotations"
      annotations={[OUTDATED]}
      files={[]}
      selectedAnnotationId={null}
      onSelectAnnotation={() => {}}
      onNavigateToAnnotation={() => {}}
      onDeleteAnnotation={() => {}}
      onEditAnnotationText={(_id, value) => edits.push(value)}
    />,
  );
  const card = [...document.querySelectorAll<HTMLElement>('div.group')].find((d) => d.textContent?.includes('stale remark'));
  await act(async () => card!.querySelector<HTMLButtonElement>('button[title="Edit"]')!.click());
  const field = 'textarea[aria-label="Edit comment"]';
  await typeInto(must<HTMLTextAreaElement>(field), text);
  return { field: () => must(field), saves: () => edits.length };
}, { skip });
