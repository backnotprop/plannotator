import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildDiagramAnchorValue,
  diagramFirstSourceLine,
  type DiagramAnchor,
  type DiagramFamily,
  type DiagramTarget,
} from '@plannotator/core/diagram-anchor';
import type { DiagramFinder } from '../../utils/diagram-anchor';

export interface DiagramComment {
  readonly id: string;
  readonly anchor: DiagramAnchor;
  readonly additionalTargets?: readonly DiagramTarget[];
  readonly text: string;
  readonly author?: string;
  readonly resolved?: boolean;
}

export type DiagramCreateComment = (
  anchor: DiagramAnchor,
  text: string,
  additionalTargets: readonly DiagramTarget[],
) => void | Promise<unknown>;

export interface ResolvedDiagramComment {
  readonly id: string;
  readonly number: number;
  readonly element: Element | null;
  readonly additional: readonly Element[];
  readonly label: string;
  readonly resolved: boolean;
  readonly whole: boolean;
}

export interface DiagramHover {
  readonly element: Element;
  readonly target: DiagramTarget;
}

export interface DiagramComposerDraft {
  readonly primary: DiagramHover;
  readonly additional: readonly DiagramHover[];
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
  readonly finder: DiagramFinder;
  readonly svgRoot: SVGSVGElement | null;
  readonly renderId: string | null;
  readonly renderVersion: number;
  readonly comments: readonly DiagramComment[];
  readonly savedSource: string;
  readonly sourceLineOffset: number;
  readonly sourceDirty: boolean;
  readonly maxAdditionalTargets: number;
  readonly canCreate: boolean;
  readonly onCreateComment: DiagramCreateComment | undefined;
  readonly onSelectComment: ((id: string | null) => void) | undefined;
  readonly onUnanchoredChange: ((ids: ReadonlySet<string>) => void) | undefined;
  readonly onResolutionChange: ((resolution: ReadonlyMap<string, boolean>) => void) | undefined;
  readonly familyOf: (svg: Element) => DiagramFamily;
}): {
  readonly resolved: readonly ResolvedDiagramComment[];
  readonly hover: DiagramHover | null;
  readonly composer: DiagramComposerDraft | null;
  readonly submitting: boolean;
  readonly submitError: string | null;
  readonly setHoverElement: (element: Element | null) => void;
  readonly clickElement: (element: Element | null, shiftKey: boolean) => void;
  readonly pickTarget: (candidates: readonly Element[]) => Element | null;
  readonly submit: (body: string) => Promise<void>;
  readonly cancel: () => void;
  readonly openAt: (target: DiagramTarget) => boolean;
} {
  const [hover, setHover] = useState<DiagramHover | null>(null);
  const [composer, setComposer] = useState<DiagramComposerDraft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const composerOpenRef = useRef(false);
  composerOpenRef.current = composer !== null;

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

  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (svgRoot === null || onUnanchoredChange === undefined) return;
    const ids = new Set(resolved.filter((entry) => entry.element === null).map((entry) => entry.id));
    const key = [...ids].sort().join('\n');
    if (key === lastReportedRef.current) return;
    lastReportedRef.current = key;
    onUnanchoredChange(ids);
  }, [onUnanchoredChange, resolved, svgRoot]);

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

  const openAt = useCallback(
    (target: DiagramTarget): boolean => {
      if (!canCreate || svgRoot === null || renderId === null) return false;
      const element = finder.findTarget(svgRoot, target, renderId) ?? (target.kind === 'diagram' ? svgRoot : null);
      if (element === null) return false;
      const part: DiagramTarget = {
        family: target.family,
        kind: target.kind,
        ...(target.id !== undefined ? { id: target.id } : {}),
        ...(target.from !== undefined ? { from: target.from } : {}),
        ...(target.to !== undefined ? { to: target.to } : {}),
        label: target.label,
      };
      const line = finder.sourceLine(savedSource, part);
      setSubmitError(null);
      setComposer({
        primary: { element, target: part },
        additional: [],
        sourceLine: line === null ? null : [line[0] + sourceLineOffset, line[1] + sourceLineOffset],
      });
      return true;
    },
    [canCreate, finder, renderId, savedSource, sourceLineOffset, svgRoot],
  );

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
        setSubmitError(error instanceof Error && error.message ? error.message : "Couldn't save the comment. Try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [composer, onCreateComment, sourceDirty, submitting],
  );

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
    openAt,
  };
}
