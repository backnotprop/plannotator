import type { ComponentType } from 'react';
import type { Block } from '@plannotator/ui/types';

export const DIAGRAM_ENGINE_HOST_KEY = '__plannotatorDiagramEngineHost';

export const DIAGRAM_ENGINE_API_VERSION = 1;

export interface DiagramEngineUrls {
  engine: string;
  mermaid: string;
  graphviz: string;
}

export const DIAGRAM_ENGINE_SHARED_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'ui:components/ThemeProvider',
  'ui:config/index',
  'ui:utils/identity',
  'ui:utils/math',
  'ui:utils/commentDraftScope',
] as const;

export type DiagramEngineSharedModule = (typeof DIAGRAM_ENGINE_SHARED_MODULES)[number];

export interface DiagramEngineHost {
  apiVersion: typeof DIAGRAM_ENGINE_API_VERSION;
  modules: Record<DiagramEngineSharedModule, unknown>;
  runtimeUrls: { mermaid: string; graphviz: string };
}

export type DiagramEngineKind = 'mermaid' | 'graphviz';

export interface DiagramFenceProps {
  kind: DiagramEngineKind;
  block: Block;
}

export interface DiagramEngineModule {
  apiVersion: number;
  DiagramFence: ComponentType<DiagramFenceProps>;
}
