import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildDiagramAnchorValue,
  diagramFirstSourceLine,
  type DiagramAnchor,
  type DiagramFamily,
  type DiagramTarget,
} from '@plannotator/core/diagram-anchor';
import type { DiagramFinder } from '../../utils/diagram-anchor';

/**
 * Diagram comments: the html-annotation grammar adapted to an app-owned
 * svg. Hover outlines a part, click opens the composer at it, Enter saves,
 * shift-click adds targets to the one draft (up to the host's cap); a saved
 * comment paints as a ring and a numbered badge, numbers from the
 * `comments` array order. Restore runs the engine's finder
 * (`finder.findTarget`, from the renderer slot) per comment after every
 * render (the svg is replaced, so element references are re-resolved), and
 * the ids that resolve to nothing are reported as the unanchored set,
 * exactly as the html viewer reports its own.
 *
 * The host's storage never enters here: `comments` come in as the adapter
 * shape and a new comment leaves through `onCreateComment(anchor, text,
 * additionalTargets)`.
 */

/** One comment the host holds on this diagram (the adapter's input shape). */
export interface DiagramComment {
  readonly id: string;
  readonly anchor: DiagramAnchor;
  /** Shift-click targets the one comment also covers; absent for most. */
  readonly additionalTargets?: readonly DiagramTarget[];
  readonly text: string;
  readonly author?: string;
  readonly resolved?: boolean;
}

/** The adapter's output: a comment the person composed on a part. The
 * anchor's `sourceLine` already carries the host's document-line offset. */
export type DiagramCreateComment = (
  anchor: DiagramAnchor,
  text: string,
  additionalTargets: readonly DiagramTarget[],
) => void | Promise<unknown>;

export interface ResolvedDiagramComment {
  readonly id: string;
  /** Array position in the host's list, 1-based. */
  readonly number: number;
  readonly element: Element | null;
  readonly additional: readonly Element[];
  readonly label: string;
  readonly resolved: boolean;
  /** The comment is on the WHOLE diagram: its ring is the content bounds
   * and its badge sits top-left. */
  readonly whole: boolean;
}

export interface DiagramHover {
  readonly element: Element;
  readonly target: DiagramTarget;
}

export interface DiagramComposerDraft {
  readonly primary: DiagramHover;
  readonly additional: readonly DiagramHover[];
  /** The primary target's line in the SAVED text, offset into the host's
   * document; null when the part only exists in an unsaved draft (the
   * composer says so). */
  readonly sourceLine: readonly [number, number] | null;
}

export function useDiagramComments({
  finder,
  svgRoot,
  renderId,
  renderVersion,
  comments,
  savedSource,
  sourceLineOffset,
  sourceDirty,
  maxAdditionalTargets,
  canCreate,
  onCreateComment,
  onSelectComment,
  onUnanchoredChange,
  onResolutionChange,
  familyOf,
}: {
  /** The engine's id grammar (mermaid or graphviz), from the renderer
   * slot: the one place the kind reaches this hook. */
  readonly finder: DiagramFinder;
  readonly svgRoot: SVGSVGElement | null;
  readonly renderId: string | null;
  readonly renderVersion: number;
  readonly comments: readonly DiagramComment[];
  /** The baseline (saved) diagram text the anchor's `sourceLine` counts in. */
  readonly savedSource: string;
  /** Lines to add so a written `sourceLine` names DOCUMENT lines: 0 when
   * the document IS the diagram, the fence's opening line for a fence. */
  readonly sourceLineOffset: number;
  readonly sourceDirty: boolean;
  readonly maxAdditionalTargets: number;
  /** Whether a click may open the composer at all. */
  readonly canCreate: boolean;
  readonly onCreateComment: DiagramCreateComment | undefined;
  readonly onSelectComment: ((id: string | null) => void) | undefined;
  readonly onUnanchoredChange: ((ids: ReadonlySet<string>) => void) | undefined;
  /** Every comment's verdict (true: its part is in this render), whenever
   * any verdict or the comment list changes. `onUnanchoredChange` only
   * speaks when the unanchored SET changes, which says nothing about a new
   * comment that resolved. */
  readonly onResolutionChange: ((resolution: ReadonlyMap<string, boolean>) => void) | undefined;
  /** The family a whole-diagram comment records (the engine's, from the
   * rendered svg). */
  readonly familyOf: (svg: Element) => DiagramFamily;
}): {
  readonly resolved: readonly ResolvedDiagramComment[];
  readonly hover: DiagramHover | null;
  readonly composer: DiagramComposerDraft | null;
  readonly submitting: boolean;
  /** The last submit's failure, shown in the composer; cleared on retry. */
  readonly submitError: string | null;
  readonly setHoverElement: (element: Element | null) => void;
  /** A click without a drag on the canvas: opens or extends the draft. */
  readonly clickElement: (element: Element | null, shiftKey: boolean) => void;
  /** The canvas's priority rule over everything under the pointer: a node,
   * then an edge, then a cluster. */
  readonly pickTarget: (candidates: readonly Element[]) => Element | null;
  readonly submit: (body: string) => Promise<void>;
  readonly cancel: () => void;
} {
  const [hover, setHover] = useState<DiagramHover | null>(null);
  const [composer, setComposer] = useState<DiagramComposerDraft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const composerOpenRef = useRef(false);
  composerOpenRef.current = composer !== null;

  // Resolve every comment's parts against the current render. The
  // renderVersion dependency is the re-resolution after a re-render: the
  // elements are new objects even when the ids did not change.
  const resolved = useMemo<readonly ResolvedDiagramComment[]>(() => {
    void renderVersion;
    return comments.map((comment, index) => {
      const anchor = comment.anchor;
      if (svgRoot === null || renderId === null) {
        return {
          id: comment.id,
          number: index + 1,
          element: null,
          additional: [],
          label: anchor.label,
          resolved: comment.resolved === true,
          whole: anchor.kind === 'diagram',
        };
      }
      const element = finder.findTarget(svgRoot, anchor, renderId);
      const additional = (comment.additionalTargets ?? [])
        .map((target) => finder.findTarget(svgRoot, target, renderId))
        .filter((el): el is Element => el !== null);
      return {
        id: comment.id,
        number: index + 1,
        element,
        additional,
        label: anchor.label,
        resolved: comment.resolved === true,
        whole: anchor.kind === 'diagram',
      };
    });
  }, [comments, finder, renderId, renderVersion, svgRoot]);

  const lastResolutionRef = useRef<string | null>(null);
  useEffect(() => {
    if (svgRoot === null || onResolutionChange === undefined) return;
    const key = resolved.map((entry) => `${entry.id}:${entry.element === null ? 0 : 1}`).join('\n');
    if (key === lastResolutionRef.current) return;
    lastResolutionRef.current = key;
    onResolutionChange(new Map(resolved.map((entry) => [entry.id, entry.element !== null])));
  }, [onResolutionChange, resolved, svgRoot]);

  // The unanchored set: comments whose primary part is gone from this
  // render. Reported only when the membership changes, so the host's state
  // does not churn per render.
  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (svgRoot === null || onUnanchoredChange === undefined) return;
    const ids = new Set(resolved.filter((entry) => entry.element === null).map((entry) => entry.id));
    const key = [...ids].sort().join('\n');
    if (key === lastReportedRef.current) return;
    lastReportedRef.current = key;
    onUnanchoredChange(ids);
  }, [onUnanchoredChange, resolved, svgRoot]);

  // A re-render drops stale element references from the draft and the
  // hover; the composer re-opens at the same part when it still exists.
  useEffect(() => {
    setHover(null);
    setComposer((current) => {
      if (current === null || svgRoot === null || renderId === null) return null;
      const primary = finder.findTarget(svgRoot, current.primary.target, renderId);
      if (primary === null) return null;
      return {
        ...current,
        primary: { element: primary, target: current.primary.target },
        additional: current.additional.flatMap((extra) => {
          const el = finder.findTarget(svgRoot, extra.target, renderId);
          return el === null ? [] : [{ element: el, target: extra.target }];
        }),
      };
    });
  }, [finder, renderId, renderVersion, svgRoot]);

  const describe = useCallback(
    (element: Element | null): DiagramHover | null => {
      if (element === null || svgRoot === null || renderId === null) return null;
      const target = finder.targetFromElement(svgRoot, element, renderId);
      if (target === null) return null;
      // The part's ONE element: an edge label resolves to its edge, a
      // sequence actor's bottom box to the same actor as its top box.
      return { element: finder.findTarget(svgRoot, target, renderId) ?? element, target };
    },
    [finder, renderId, svgRoot],
  );

  const pickTarget = useCallback(
    (candidates: readonly Element[]): Element | null => {
      if (svgRoot === null || renderId === null) return candidates[0] ?? null;
      const kinds = candidates.map((el) => finder.targetFromElement(svgRoot, el, renderId)?.kind ?? null);
      for (const kind of ['node', 'edge', 'cluster'] as const) {
        const at = kinds.indexOf(kind);
        if (at !== -1) return candidates[at] ?? null;
      }
      return null;
    },
    [finder, renderId, svgRoot],
  );

  const setHoverElement = useCallback(
    (element: Element | null) => {
      setHover((current) => {
        if (element === null) return current === null ? current : null;
        if (current !== null && current.element === element) return current;
        return describe(element);
      });
    },
    [describe],
  );

  const clickElement = useCallback(
    (element: Element | null, shiftKey: boolean) => {
      let part = describe(element);
      if (part === null) {
        // The background, a marker, a part no family addresses. A click
        // there closes an open draft; with none open it comments on the
        // WHOLE diagram, so a click never does nothing (a sequence note
        // the codec misses, a gitGraph, a pie, anything future).
        if (shiftKey) return;
        if (composerOpenRef.current || !canCreate || svgRoot === null) {
          setComposer(null);
          return;
        }
        part = {
          element: svgRoot,
          target: { family: familyOf(svgRoot), kind: 'diagram', label: diagramFirstSourceLine(savedSource) },
        };
      }
      if (!canCreate) return;
      setSubmitError(null);
      setComposer((current) => {
        if (shiftKey && current !== null && part.target.kind !== 'diagram' && current.primary.target.kind !== 'diagram') {
          const already =
            current.primary.element === part.element || current.additional.some((extra) => extra.element === part.element);
          if (already || current.additional.length >= maxAdditionalTargets) {
            return current;
          }
          return { ...current, additional: [...current.additional, part] };
        }
        const line = finder.sourceLine(savedSource, part.target);
        return {
          primary: part,
          additional: [],
          sourceLine: line === null ? null : [line[0] + sourceLineOffset, line[1] + sourceLineOffset],
        };
      });
    },
    [canCreate, describe, familyOf, finder, maxAdditionalTargets, savedSource, sourceLineOffset, svgRoot],
  );

  const cancel = useCallback(() => {
    setComposer(null);
    setSubmitError(null);
  }, []);

  const submit = useCallback(
    async (body: string) => {
      if (composer === null || submitting || onCreateComment === undefined) return;
      if (composer.sourceLine === null && sourceDirty) {
        setSubmitError('Save the draft before commenting on a part that only exists in it.');
        return;
      }
      const text = body.trim();
      if (text === '') return;
      setSubmitting(true);
      setSubmitError(null);
      try {
        await onCreateComment(
          buildDiagramAnchorValue(composer.primary.target, composer.sourceLine),
          text,
          composer.additional.map((extra) => extra.target),
        );
        setComposer(null);
      } catch (error) {
        // The draft stays open with its text; the person retries.
        setSubmitError(error instanceof Error && error.message ? error.message : "Couldn't save the comment. Try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [composer, onCreateComment, sourceDirty, submitting],
  );

  // Selecting through a badge is the host's selection, so the panel and
  // the ring agree.
  void onSelectComment;

  return {
    resolved,
    hover,
    composer,
    submitting,
    submitError,
    setHoverElement,
    clickElement,
    pickTarget,
    submit,
    cancel,
  };
}
