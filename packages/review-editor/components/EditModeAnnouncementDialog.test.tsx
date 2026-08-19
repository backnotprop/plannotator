import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditModeAnnouncementDialog } from './EditModeAnnouncementDialog';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

interface HarnessProps {
  readonly onEnable?: () => void;
  readonly onDismiss?: () => void;
  readonly demoVideoSrc?: string | null;
  readonly demoPosterSrc?: string;
}

function Harness({ onEnable, onDismiss, demoVideoSrc, demoPosterSrc }: HarnessProps) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <EditModeAnnouncementDialog
      isOpen={isOpen}
      demoVideoSrc={demoVideoSrc}
      demoPosterSrc={demoPosterSrc}
      onEnable={() => {
        onEnable?.();
        setIsOpen(false);
      }}
      onDismiss={() => {
        onDismiss?.();
        setIsOpen(false);
      }}
    />
  );
}

async function mountDialog(props: HarnessProps = {}): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Harness {...props} />);
  });
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find(candidate => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Button containing "${text}" did not render`);
  return button;
}

describe('EditModeAnnouncementDialog', () => {
  afterEach(async () => {
    const mountedRoot = root;
    if (mountedRoot) await act(async () => mountedRoot.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('renders as a labelled modal with both actions and accurate copy', async () => {
    await mountDialog();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.textContent).toContain('Edit code to suggest');
    expect(dialog?.textContent).toContain('off by default');
    expect(dialog?.textContent).toContain('never writes to your files on disk');
    expect(dialog?.textContent).toContain('One file at a time');
    expect(dialog?.textContent).toContain('Settings → Editor → Edit Code to Suggest');
    const enableSwitch = document.querySelector('[role="switch"]');
    expect(enableSwitch).not.toBeNull();
    expect(enableSwitch?.getAttribute('aria-checked')).toBe('false');
    expect(buttonWithText('Done')).toBeTruthy();
  });

  test.skipIf(!hasDom)('renders the bundled demo recording by default', async () => {
    await mountDialog();

    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBeTruthy();
    expect(video?.getAttribute('poster')).toBeTruthy();
    expect(document.querySelector('[data-edit-mode-demo-placeholder]')).toBeNull();
    expect(document.body.textContent).not.toContain('coming soon');
  });

  test.skipIf(!hasDom)('falls back to the static placeholder when no recording src is given', async () => {
    await mountDialog({ demoVideoSrc: null });

    expect(document.querySelector('[data-edit-mode-demo-placeholder]')).not.toBeNull();
    expect(document.querySelector('video')).toBeNull();
    expect(document.body.textContent).not.toContain('coming soon');
  });

  test.skipIf(!hasDom)('the demo video slot autoplays muted, loops, and plays inline', async () => {
    await mountDialog({ demoVideoSrc: 'data:video/webm;base64,AAAA', demoPosterSrc: 'data:image/png;base64,BBBB' });

    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('data:video/webm;base64,AAAA');
    expect(video?.getAttribute('poster')).toBe('data:image/png;base64,BBBB');
    expect(video?.hasAttribute('autoplay')).toBe(true);
    expect(video?.hasAttribute('loop')).toBe(true);
    expect(video?.hasAttribute('playsinline')).toBe(true);
    // React reflects muted via the property, not always the attribute.
    expect((video as HTMLVideoElement).muted).toBe(true);
    expect(document.querySelector('[data-edit-mode-demo-placeholder]')).toBeNull();
  });

  test.skipIf(!hasDom)('Done with the switch untouched dismisses without enabling', async () => {
    const onEnable = mock(() => {});
    const onDismiss = mock(() => {});
    await mountDialog({ onEnable, onDismiss });

    // The focused default action must be the consent-neutral one: pressing it
    // blind keeps the feature off.
    expect(document.activeElement?.textContent).toContain('Done');

    await act(async () => buttonWithText('Done').click());

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onEnable).not.toHaveBeenCalled();
    expect(document.querySelector('[data-edit-mode-announcement-dialog]')).toBeNull();
  });

  test.skipIf(!hasDom)('flipping the switch then Done fires onEnable and never onDismiss', async () => {
    const onEnable = mock(() => {});
    const onDismiss = mock(() => {});
    await mountDialog({ onEnable, onDismiss });

    const enableSwitch = document.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(enableSwitch).not.toBeNull();
    await act(async () => enableSwitch!.click());
    expect(enableSwitch!.getAttribute('aria-checked')).toBe('true');

    await act(async () => buttonWithText('Done').click());

    expect(onEnable).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector('[data-edit-mode-announcement-dialog]')).toBeNull();
  });

  test.skipIf(!hasDom)('the switch is a toggle: on then off again ends with a plain dismissal', async () => {
    const onEnable = mock(() => {});
    const onDismiss = mock(() => {});
    await mountDialog({ onEnable, onDismiss });

    const enableSwitch = document.querySelector<HTMLButtonElement>('[role="switch"]');
    await act(async () => enableSwitch!.click());
    await act(async () => enableSwitch!.click());
    expect(enableSwitch!.getAttribute('aria-checked')).toBe('false');

    await act(async () => buttonWithText('Done').click());

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onEnable).not.toHaveBeenCalled();
  });

  test.skipIf(!hasDom)('Escape dismisses the dialog and restores prior focus', async () => {
    const priorButton = document.createElement('button');
    priorButton.textContent = 'Prior focus';
    document.body.appendChild(priorButton);
    priorButton.focus();
    const onEnable = mock(() => {});
    const onDismiss = mock(() => {});
    await mountDialog({ onEnable, onDismiss });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onEnable).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(priorButton);
  });
});
