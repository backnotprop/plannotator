/**
 * Design prototype "file-refs-open-pane": a code span in an agent's message that is a file's path
 * (`packages/inbox/App.tsx:42`, `docs/plan.md`, `shots/after.png`) opens that file beside the thread. On a computer
 * with Code review on, a code file still shows its code on hover (OpenInCodeHover) and the click opens the pane; on a
 * touch screen the tap goes straight to the pane.
 */
import { useMemo, type MutableRefObject, type ReactNode } from 'react';
import { CodeSpanContext, CodeSpanMatchContext } from '@plannotator/ui/components/LocalLinkContext';
import { isCodeFilePath } from '@plannotator/core/code-file';
import { fileRefOf, looksLikeFilePath, type FileRef } from '../fileRefs';
import { openAttachmentTitle } from '../links';
import { OpenInCodeHover } from './OpenIn';
import { useTouchScreen } from '../phone';

function FileRefSpan({ text, code, hover, scope, openRef }: { text: string; code: ReactNode; hover: boolean; scope: { thread: string; message: string }; openRef: MutableRefObject<((ref: FileRef) => void) | undefined> }) {
  const touch = useTouchScreen();
  const ref = fileRefOf(text);
  if (!ref) return <>{code}</>;
  const open = () => openRef.current?.(ref);
  const peek = hover && !touch && isCodeFilePath(text);
  const span = (
    <span
      className="ib-fileref"
      role={peek ? undefined : 'button'}
      tabIndex={peek ? -1 : 0}
      title={peek ? undefined : openAttachmentTitle(ref.path)}
      data-file-ref={ref.path}
      onClick={(event) => {
        if (window.getSelection()?.isCollapsed === false) return;
        event.preventDefault();
        event.stopPropagation();
        open();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      }}
    >
      {code}
    </span>
  );
  if (!peek) return span;
  return (
    <OpenInCodeHover scope={scope} path={ref.path} line={ref.line} lineEnd={ref.lineEnd}>
      {span}
    </OpenInCodeHover>
  );
}

/** Every code span in `children` that is a file's path opens it (`on`); `hover`: Code review's peek on a computer. */
export function FileRefCodeSpans({ on, hover, scope, openRef, children }: { on: boolean; hover: boolean; scope: { thread: string; message: string }; openRef: MutableRefObject<((ref: FileRef) => void) | undefined>; children: ReactNode }) {
  const key = JSON.stringify(scope);
  const render = useMemo(
    () => (on ? (text: string, code: ReactNode) => <FileRefSpan text={text} code={code} hover={hover} scope={scope} openRef={openRef} /> : null),
    // `key` names the scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, on, hover],
  );
  if (!on) return <>{children}</>;
  return (
    <CodeSpanMatchContext.Provider value={looksLikeFilePath}>
      <CodeSpanContext.Provider value={render}>{children}</CodeSpanContext.Provider>
    </CodeSpanMatchContext.Provider>
  );
}
