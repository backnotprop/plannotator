import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ImageThumbnail, getImageSrc } from './ImageThumbnail';
import { ImageAnnotator } from './ImageAnnotator';
import type { ImageAttachment } from '../types';

/**
 * Derive a clean, human-readable name from an original filename.
 * "Login Mockup.png" → "login-mockup"
 * "annotated.png" or generic names → "image-N"
 */
export function deriveImageName(originalName: string, existingNames: string[]): string {
  const base = originalName.replace(/\.[^.]+$/, '');
  const generic = ['annotated', 'image', 'screenshot', 'paste', 'clipboard', 'untitled'];

  if (generic.includes(base.toLowerCase())) {
    let n = 1;
    while (existingNames.includes(`image-${n}`)) n++;
    return `image-${n}`;
  }

  let name = base.toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!name) {
    let n = 1;
    while (existingNames.includes(`image-${n}`)) n++;
    return `image-${n}`;
  }

  if (existingNames.includes(name)) {
    let n = 2;
    while (existingNames.includes(`${name}-${n}`)) n++;
    name = `${name}-${n}`;
  }

  return name;
}

interface AttachmentsButtonProps {
  images: ImageAttachment[];
  onAdd: (image: ImageAttachment) => void;
  onRemove: (path: string) => void;
  variant?: 'toolbar' | 'inline';
}

export const AttachmentsButton: React.FC<AttachmentsButtonProps> = ({
  images,
  onAdd,
  onRemove,
  variant = 'toolbar',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  // Annotator state
  const [annotatorImage, setAnnotatorImage] = useState<{ file: File; blobUrl: string; initialName: string } | null>(null);
  const [editingImage, setEditingImage] = useState<{ path: string; name: string } | null>(null);

  // Update popover position when opened
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({
        top: rect.bottom + 8,
        left: Math.max(8, rect.left - 100), // Center-ish, but keep on screen
      });
    }
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleFileSelect = (file: File) => {
    // Derive name before opening annotator so user sees it immediately
    const initialName = deriveImageName(file.name, images.map(i => i.name));
    const blobUrl = URL.createObjectURL(file);
    setAnnotatorImage({ file, blobUrl, initialName });
    setIsOpen(false); // Close popover when annotator opens
  };

  const handleAnnotatorAccept = async (blob: Blob, hasDrawings: boolean, name: string) => {
    setUploading(true);
    try {
      const formData = new FormData();
      // Use annotated blob if drawings exist, otherwise original file
      if (annotatorImage) {
        const fileToUpload = hasDrawings
          ? new File([blob], 'annotated.png', { type: 'image/png' })
          : annotatorImage.file;
        formData.append('file', fileToUpload);
      } else if (editingImage) {
        // Re-editing: always upload the new blob
        formData.append('file', new File([blob], 'annotated.png', { type: 'image/png' }));
      }

      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.path) {
        // If re-editing, remove old path first
        if (editingImage) {
          onRemove(editingImage.path);
        }
        // Use the name from the annotator (user may have edited it)
        onAdd({ path: data.path, name });
      }
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
      // Cleanup
      if (annotatorImage) {
        URL.revokeObjectURL(annotatorImage.blobUrl);
        setAnnotatorImage(null);
      }
      setEditingImage(null);
    }
  };

  const handleAnnotatorClose = () => {
    if (annotatorImage) {
      URL.revokeObjectURL(annotatorImage.blobUrl);
      setAnnotatorImage(null);
    }
    setEditingImage(null);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
    e.target.value = ''; // Reset for re-selection
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      handleFileSelect(file);
    }
  };

  const handleManualAdd = () => {
    const trimmed = manualPath.trim();
    if (trimmed) {
      const name = deriveImageName(
        trimmed.split('/').pop() || 'image',
        images.map(i => i.name)
      );
      onAdd({ path: trimmed, name });
      setManualPath('');
    }
  };

  const handleClearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    images.forEach(img => onRemove(img.path));
  };

  // Determine annotator props
  const annotatorOpen = !!annotatorImage || !!editingImage;
  const annotatorSrc = annotatorImage?.blobUrl ?? (editingImage ? getImageSrc(editingImage.path) : '');
  const annotatorInitialName = annotatorImage?.initialName ?? editingImage?.name ?? '';

  return (
    <>
      {/* Trigger Button */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="group relative flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
      >
        {/* Show stacked thumbnails if we have images */}
        {images.length > 0 ? (
          <>
            <div className="relative flex items-center">
              {images.slice(0, 3).map((img, idx) => (
                <div
                  key={img.path}
                  className="relative w-5 h-5 rounded border border-background"
                  style={{ marginLeft: idx > 0 ? '-6px' : 0, zIndex: 3 - idx }}
                >
                  <img
                    src={getImageSrc(img.path)}
                    alt={img.name}
                    loading="lazy"
                    className="w-5 h-5 rounded object-cover"
                  />
                </div>
              ))}
              {images.length > 3 && (
                <div
                  className="relative w-5 h-5 rounded bg-muted border border-background flex items-center justify-center text-[9px] font-medium"
                  style={{ marginLeft: '-6px', zIndex: 0 }}
                >
                  +{images.length - 3}
                </div>
              )}
            </div>
            {/* Clear all button on hover */}
            <button
              onClick={handleClearAll}
              className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-destructive text-destructive-foreground rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
            >
              <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </>
        ) : (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
          </svg>
        )}
        <span className={variant === 'inline' ? 'sr-only' : ''}>
          {images.length > 0 ? `${images.length}` : 'Images'}
        </span>
      </button>

      {/* Popover */}
      {isOpen && createPortal(
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-[90]"
            onClick={() => setIsOpen(false)}
          />

          {/* Popover content */}
          <div
            className="fixed z-[100] w-72 bg-card border border-border rounded-xl shadow-2xl p-3"
            style={{ top: position.top, left: position.left }}
            onClick={e => e.stopPropagation()}
          >
            <div className="space-y-3">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Attachments</div>
                {images.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    {images.length} image{images.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground -mt-1">
                Add images to include with your feedback
              </p>

              {/* Drop zone / file picker */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`flex flex-col items-center justify-center gap-2 px-3 py-4 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                  dragOver
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground'
                }`}
              >
                {uploading ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span className="text-xs">Uploading...</span>
                  </div>
                ) : (
                  <>
                    <svg className="w-6 h-6 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                    </svg>
                    <span className="text-xs text-muted-foreground">
                      Drop image or click to browse
                    </span>
                  </>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileInputChange}
                className="hidden"
              />

              {/* Manual path input */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={manualPath}
                  onChange={(e) => setManualPath(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleManualAdd()}
                  placeholder="Paste path or URL..."
                  className="flex-1 px-2 py-1.5 text-xs bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  type="button"
                  onClick={handleManualAdd}
                  disabled={!manualPath.trim()}
                  className="px-2 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Add
                </button>
              </div>

              {/* Grid of current attachments */}
              {images.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">Current</div>
                  <div className="grid grid-cols-4 gap-2">
                    {images.map((img) => (
                      <div key={img.path} className="text-center">
                        <ImageThumbnail
                          path={img.path}
                          size="md"
                          onClick={() => {
                            setEditingImage({ path: img.path, name: img.name });
                            setIsOpen(false);
                          }}
                          onRemove={() => onRemove(img.path)}
                          showRemove
                        />
                        <div
                          className="text-[9px] text-muted-foreground truncate max-w-[3.5rem] mt-0.5 mx-auto"
                          title={img.name}
                        >
                          {img.name}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>,
        document.body
      )}

      {/* Image Annotator Dialog - portaled to body for correct positioning */}
      {annotatorOpen && createPortal(
        <ImageAnnotator
          isOpen={annotatorOpen}
          imageSrc={annotatorSrc}
          initialName={annotatorInitialName}
          onAccept={handleAnnotatorAccept}
          onClose={handleAnnotatorClose}
        />,
        document.body
      )}
    </>
  );
};
