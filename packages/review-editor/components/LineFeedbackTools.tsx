import { createContext, type ComponentType, type RefObject } from 'react';

export const LineFeedbackToolsContext = createContext<ComponentType<{
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onBusyChange: (busy: boolean) => void;
}> | null>(null);

export const LineFeedbackToolsProvider = LineFeedbackToolsContext.Provider;
