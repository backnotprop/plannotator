import React, { useEffect, useRef } from 'react';

/**
 * Overlay for viewing one image enlarged. Shared by the markdown Viewer
 * (clicking an image in a document) and the raw-HTML surface (a link to a
 * local image inside the annotated page).
 *
 * The image is only ever shown through `<img src>`, so an SVG runs no script
 * and cannot reach the page.
 *
 * It is modal for the keyboard. Its keydown listener runs on the CAPTURE phase
 * at the window and stops every key there, so nothing behind it reacts:
 * Escape closes the lightbox before the HTML surface's Esc ladder sees it,
 * and Mod+Enter cannot submit a decision behind it. Focus moves to the
 * overlay when it opens, which also pulls focus out of an HTML page's iframe
 * (whose keys the parent would otherwise never see), and goes back to where
 * it was when it closes.
 */
export const ImageLightbox: React.FC<{ src: string; alt: string; onClose: () => void }> = ({ src, alt, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (e: KeyboardEvent) => {
      // Tab stays native: the overlay is the only focusable thing that matters
      // here, and trapping it buys nothing for a click-to-close surface.
      if (e.key === 'Tab') return;
      e.stopImmediatePropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
      }
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Image'}
      data-image-lightbox=""
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm cursor-zoom-out outline-none"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      {alt && (
        <div className="mt-3 text-sm text-white/70 max-w-[90vw] text-center truncate">{alt}</div>
      )}
    </div>
  );
};
