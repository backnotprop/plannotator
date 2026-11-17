/**
 * The canvas's dock: every Excalidraw drawing tool, in Plannotator's look. Icons are drawn after Lucide (ISC).
 * Excalidraw's own one-key shortcuts for them work while focus is in the canvas (the titles name them).
 */
export type CanvasDockTool =
  | { kind: "tool"; key: string; tool: string; label: string; icon: string }
  | { kind: "lock"; key: string; tool?: undefined; label: string; icon: string }
  | { kind: "export"; key: string; tool?: undefined; label: string; icon: string }
  | { kind: "sep"; key: string; tool?: undefined; label?: undefined; icon?: undefined };

export const CANVAS_DOCK_TOOLS: readonly CanvasDockTool[] = [
  { kind: "lock", key: "lock", label: "Keep the tool after drawing (Q)", icon: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>' },
  { kind: "tool", key: "hand", tool: "hand", label: "Hand (H)", icon: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>' },
  { kind: "tool", key: "selection", tool: "selection", label: "Select (V)", icon: '<path d="M5 3l6.5 17 2.4-7.1L21 10.5z"/>' },
  { kind: "tool", key: "rectangle", tool: "rectangle", label: "Rectangle (R)", icon: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>' },
  { kind: "tool", key: "diamond", tool: "diamond", label: "Diamond (D)", icon: '<path d="M12 3l9 9-9 9-9-9z"/>' },
  { kind: "tool", key: "ellipse", tool: "ellipse", label: "Ellipse (O)", icon: '<circle cx="12" cy="12" r="8"/>' },
  { kind: "tool", key: "arrow", tool: "arrow", label: "Arrow (A)", icon: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>' },
  { kind: "tool", key: "line", tool: "line", label: "Line (L)", icon: '<path d="M5 12h14"/>' },
  { kind: "tool", key: "freedraw", tool: "freedraw", label: "Pen (P)", icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>' },
  { kind: "tool", key: "text", tool: "text", label: "Text (T)", icon: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>' },
  { kind: "tool", key: "image", tool: "image", label: "Picture (9)", icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>' },
  { kind: "tool", key: "eraser", tool: "eraser", label: "Eraser (E)", icon: '<path d="M7 21l-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L11 21z"/><path d="M22 21H7"/><path d="M5 11l9 9"/>' },
  { kind: "tool", key: "frame", tool: "frame", label: "Frame (F)", icon: '<path d="M22 6H2"/><path d="M22 18H2"/><path d="M6 2v20"/><path d="M18 2v20"/>' },
  { kind: "tool", key: "laser", tool: "laser", label: "Laser pointer (K)", icon: '<path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><circle cx="12" cy="12" r="2"/>' },
  { kind: "sep", key: "sep" },
  { kind: "export", key: "export", label: "Save as a picture", icon: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>' },
];
