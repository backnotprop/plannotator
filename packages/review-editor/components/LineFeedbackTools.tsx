import { createContext, type ComponentType, type RefObject } from 'react';

/** Optional host tools for line feedback. Suggested code has its own editor. */
export const LineFeedbackToolsContext = createContext<ComponentType<{
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onBusyChange: (busy: boolean) => void;
}> | null>(null);
