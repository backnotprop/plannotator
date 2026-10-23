import { useSyncExternalStore } from 'react';
import { getDiagramEngine, subscribeDiagramEngine, type DiagramEngine } from '../utils/diagramEngine';

/** The selected Mermaid-syntax diagram renderer, reactive within this page. */
export function useDiagramEngine() {
  return useSyncExternalStore(subscribeDiagramEngine, getDiagramEngine, (): DiagramEngine => 'mermaid');
}
