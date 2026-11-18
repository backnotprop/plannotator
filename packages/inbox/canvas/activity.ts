/**
 * Is the person in the middle of something on a canvas: a pointer held down in it (a stroke, a drag, a resize), or
 * a text being typed there? While so, a scene from elsewhere waits (useThreadCanvas.ts): replacing the scene would cut
 * the stroke or the text short. Listens on the window only while a canvas hook asks.
 */
const BOX = '.pn-canvas';

export interface CanvasActivity {
  busy: () => boolean;
  stop: () => void;
}

export function trackCanvasActivity(): CanvasActivity {
  if (typeof window === 'undefined') return { busy: () => false, stop: () => {} };
  let pressing = false;
  const down = (e: PointerEvent) => {
    const target = e.target as Element | null;
    if (target && typeof target.closest === 'function' && target.closest(BOX)) pressing = true;
  };
  const up = () => {
    pressing = false;
  };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', up);
  return {
    busy: () => {
      if (pressing) return true;
      const active = document.activeElement;
      return !!active && active.tagName === 'TEXTAREA' && !!active.closest(BOX);
    },
    stop: () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', up);
    },
  };
}
