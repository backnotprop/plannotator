import React, { useCallback, useEffect, useState } from 'react';
import type { Block } from '@plannotator/ui/types';
import { isGraphvizLanguage, isMermaidLanguage } from '@plannotator/ui/components/diagramLanguages';
import { loadDiagramEngine, peekDiagramEngine, type DiagramEngineImporter } from '../utils/diagramEngine';
import type { DiagramEngineKind, DiagramEngineModule, DiagramEngineUrls } from '../utils/diagramEngineContract';

export function diagramFenceKind(block: Block): DiagramEngineKind | null {
  if (block.type !== 'code') return null;
  if (isMermaidLanguage(block.language)) return 'mermaid';
  if (isGraphvizLanguage(block.language)) return 'graphviz';
  return null;
}

type EngineState =
  | { status: 'loading' }
  | { status: 'ready'; engine: DiagramEngineModule }
  | { status: 'failed' };

function useDiagramEngine(urls: DiagramEngineUrls, importer?: DiagramEngineImporter): [EngineState, () => void] {
  const [state, setState] = useState<EngineState>(() => {
    const engine = peekDiagramEngine(urls);
    return engine ? { status: 'ready', engine } : { status: 'loading' };
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ready = peekDiagramEngine(urls);
    if (ready) {
      setState((prev) => (prev.status === 'ready' && prev.engine === ready ? prev : { status: 'ready', engine: ready }));
      return;
    }
    let live = true;
    setState({ status: 'loading' });
    loadDiagramEngine(urls, importer).then(
      (engine) => live && setState({ status: 'ready', engine }),
      (error: unknown) => {
        if (!live) return;
        console.warn('[plannotator] The diagram renderer did not load; showing diagram sources as code.', error);
        setState({ status: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [urls.engine, urls.mermaid, urls.graphviz, importer, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry];
}

export interface ReviewDiagramFenceProps {
  block: Block;
  kind: DiagramEngineKind;
  urls: DiagramEngineUrls;
  fallback: React.ReactNode;
  importer?: DiagramEngineImporter;
}

export const ReviewDiagramFence: React.FC<ReviewDiagramFenceProps> = ({ block, kind, urls, fallback, importer }) => {
  const [state, retry] = useDiagramEngine(urls, importer);
  if (state.status === 'ready') {
    const { DiagramFence } = state.engine;
    return <DiagramFence kind={kind} block={block} />;
  }
  return (
    <div data-review-diagram={state.status} aria-busy={state.status === 'loading' ? true : undefined}>
      {fallback}
      {state.status === 'failed' && (
        <p data-review-diagram-note="" className="mt-1 mb-4 text-xs text-muted-foreground">
          The diagram renderer did not load, so this diagram shows as code.{' '}
          <button type="button" onClick={retry} className="underline underline-offset-2 hover:text-foreground">
            Retry
          </button>
        </p>
      )}
    </div>
  );
};
