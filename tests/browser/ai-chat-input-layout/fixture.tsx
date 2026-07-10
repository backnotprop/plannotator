import React from 'react';
import { createRoot } from 'react-dom/client';
import '@plannotator/editor/styles';
import { DocumentAIChatPanel } from '@plannotator/ui/components/ai/DocumentAIChatPanel';
import type { AIChatEntry } from '@plannotator/ui/hooks/useAIChat';
import type { AIProviderOption } from '@plannotator/ui/utils/aiProvider';

const completed = new URLSearchParams(location.search).get('state') !== 'streaming';
const longResponse = Array.from(
  { length: 8 },
  (_, i) => `Paragraph ${i + 1}: This completed response is long enough to overflow the chat viewport and trigger automatic scrolling.`,
).join('\n\n');
const messages: AIChatEntry[] = [
  {
    question: {
      id: 'q1',
      prompt: 'Can we use the actual codec API?',
      createdAt: Date.now(),
      scope: {
        kind: 'selection',
        label: 'Selected text',
        text: 'export function codec() {}',
      },
    },
    response: {
      text: completed ? longResponse : '',
      isStreaming: !completed,
    },
  },
];
const providers: AIProviderOption[] = [
  {
    id: 'pi-sdk',
    name: 'Pi',
    available: true,
    models: [{ id: 'gpt-5.5', label: 'GPT-5.5', default: true }],
  },
];

function requireElement<T extends Element>(selector: string, type: new () => T): T {
  const element = document.querySelector(selector);
  if (!(element instanceof type)) {
    throw new Error(`Expected ${selector} to be a ${type.name}`);
  }
  return element;
}

function rect(element: Element) {
  const { top, bottom, height } = element.getBoundingClientRect();
  return { top, bottom, height };
}

function App() {
  return (
    <div
      id="viewport"
      style={{ width: 360, height: 650, overflow: 'hidden', display: 'flex' }}
    >
      <aside
        id="panel"
        className="border-l border-border/50 bg-card flex flex-col flex-shrink-0"
        style={{ width: 360 }}
      >
        <div className="border-b border-border/50">
          <div className="flex h-10 items-center px-3">AI</div>
        </div>
        <DocumentAIChatPanel
          messages={messages}
          isCreatingSession={false}
          isStreaming={!completed}
          onAskGeneral={() => {}}
          aiProviders={providers}
          aiConfig={{ providerId: 'pi-sdk', model: 'gpt-5.5' }}
        />
      </aside>
    </div>
  );
}

const root = requireElement('#root', HTMLElement);
createRoot(root).render(<App />);
requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
  const viewportEl = requireElement('#viewport', HTMLElement);
  const panelEl = requireElement('#panel', HTMLElement);
  const chatEl = panelEl.lastElementChild;
  if (!(chatEl instanceof HTMLElement)) {
    throw new Error('Expected the chat panel to render as the final sidebar child');
  }
  const scrollEl = chatEl.firstElementChild;
  if (!(scrollEl instanceof HTMLElement)) {
    throw new Error('Expected the chat panel to render a scroll viewport');
  }
  const inputEl = requireElement('textarea', HTMLTextAreaElement);
  const viewport = viewportEl.getBoundingClientRect();
  const input = inputEl.getBoundingClientRect();
  const visible = input.top >= viewport.top
    && input.bottom <= viewport.bottom
    && input.height > 0;

  document.body.dataset.verdict = visible ? 'PASS' : 'FAIL';
  document.body.dataset.metrics = JSON.stringify({
    viewport: {
      top: viewport.top,
      bottom: viewport.bottom,
      height: viewport.height,
      scrollTop: viewportEl.scrollTop,
    },
    panel: {
      ...rect(panelEl),
      cssHeight: getComputedStyle(panelEl).height,
      minHeight: getComputedStyle(panelEl).minHeight,
    },
    chat: {
      ...rect(chatEl),
      cssHeight: getComputedStyle(chatEl).height,
      minHeight: getComputedStyle(chatEl).minHeight,
    },
    scroll: {
      ...rect(scrollEl),
      cssHeight: getComputedStyle(scrollEl).height,
      minHeight: getComputedStyle(scrollEl).minHeight,
      overflowY: getComputedStyle(scrollEl).overflowY,
      scrollHeight: scrollEl.scrollHeight,
      scrollTop: scrollEl.scrollTop,
    },
    input: rect(inputEl),
  });
}, 100)));
