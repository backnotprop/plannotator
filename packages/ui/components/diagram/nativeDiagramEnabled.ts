import { createContext, type ComponentProps, type ComponentType } from 'react';
import type { NativeDiagramBlock } from './NativeDiagramBlock';

export type NativeDiagramRenderer = ComponentType<ComponentProps<typeof NativeDiagramBlock>>;

/** Importing Viewer alone leaves the native renderer out of the host's bundle. */
export const NativeDiagramBlockContext = createContext<NativeDiagramRenderer | null>(null);
