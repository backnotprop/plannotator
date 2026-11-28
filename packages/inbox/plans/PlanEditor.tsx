/**
 * The plan page's editor (approval "plans-editing"): the shared Markdown editor plan review edits with
 * (@plannotator/ui/components/MarkdownEditor, CodeMirror with live preview), on the newest version's text. Loaded
 * only when Edit opens (PlanEditing.tsx imports this file lazily), so a plan that is only read never loads it.
 */
import type { MutableRefObject } from 'react';
import { MarkdownEditor, type MarkdownEditorHandle } from '@plannotator/ui/components/MarkdownEditor';

export default function PlanEditor({ text, documentId, handle, onChange, onBlur }: { text: string; documentId: string; handle: MutableRefObject<MarkdownEditorHandle | null>; onChange: (markdown: string) => void; onBlur?: () => void }) {
  return (
    <div className="ib-plan-editor" data-plan-editor="" onBlur={onBlur}>
      <MarkdownEditor markdown={text} documentId={documentId} editorHandleRef={handle} onMarkdownChange={onChange} maxWidth={null} />
    </div>
  );
}
