import { createContext, type ComponentType, type RefObject } from 'react';

export const QuestionOtherToolsContext = createContext<ComponentType<{ textareaRef: RefObject<HTMLTextAreaElement | null> }> | null>(null);

export const QuestionOtherToolsProvider = QuestionOtherToolsContext.Provider;
