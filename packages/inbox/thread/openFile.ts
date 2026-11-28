import type { RefObject } from 'react';
import { readRoute, type Route } from '../app/route';
import { closeTo } from '../app/focus';
import { currentHash, hashOf, writeRoute } from '../app/writeRoute';
import { sameScreenAnyView } from '../fileView';
import { fileEntryOp, pageBackPastSwitch, type FrameMove } from '../fullScreenOrigin';
import { backBy, backTo } from '../history';
import type { ThreadPaneProps } from './paneProps';

/** A thread pane's file opener (ThreadPane's `onOpenFile`): the file in the address, its frames kept as history entries. */
export function fileOpener(routeRef: RefObject<Route>): ThreadPaneProps['onOpenFile'] {
  return (file, options) => {
    if (!file) return closeTo({ ...routeRef.current, file });
    // A call that names no view keeps the one in the address (the pane names it for a step, a version, a linked page).
    const keepView = file.view === undefined ? (routeRef.current.file?.view ?? null) : file.view;
    const next = { ...routeRef.current, ref: null, file: { ...file, view: keepView } };
    /** Show `next` the way fullScreenOrigin.ts names (the history is the stack of frames). */
    const show = (request: { move?: FrameMove; replace?: boolean }) => {
      const op = fileEntryOp({ hash: currentHash(), state: window.history.state }, hashOf(next), request);
      if (op.kind === 'back') {
        // Back onto the entry beside the thread; where asked, it then shows the file on screen now (a step inside full screen kept).
        const land = op.land;
        const landThere =
          land === null
            ? undefined
            : () => {
                if (currentHash() !== land && readRoute().thread === next.thread) writeRoute(next, { replace: true });
              };
        if (backBy(op.steps, window.history, landThere)) return;
        return writeRoute(next, { replace: true, fullMark: null });
      }
      if (op.kind === 'replace') writeRoute(next, op.keep ? { replace: true } : { replace: true, fullMark: op.mark });
      else writeRoute(next, { fullMark: op.mark });
    };
    if (options?.back) {
      // A linked page's Back in a full screen the switch entered on that page: back past the switch's entry and the
      // page beside the thread, then full screen again with the switch, so × and Back still come back beside the thread.
      if (
        pageBackPastSwitch({ hash: currentHash(), state: window.history.state }, hashOf(next), sameScreenAnyView) &&
        backBy(2, window.history, () => {
          if (readRoute().thread === next.thread) show({ move: 'switch-full' });
        })
      ) {
        return;
      }
      // Back through a linked page's stack: the browser's Back when this entry was opened from there,
      // whatever view that entry names (a pick swapped only the entry on screen); once it lands,
      // the view the person is in now replaces the one it named.
      const view = next.file.view;
      const viewThere = view
        ? () => {
            const now = readRoute();
            if (now.file && now.file.view !== view) writeRoute({ ...now, file: { ...now.file, view } }, { replace: true });
          }
        : undefined;
      if (backTo(hashOf(next), window.history, sameScreenAnyView, viewThere)) return;
    }
    show({ move: options?.move, replace: options?.replace });
  };
}
