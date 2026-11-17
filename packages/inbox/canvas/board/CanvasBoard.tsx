/**
 * The canvas surface: Excalidraw (MIT) with Plannotator's quiet dock in place of its toolbar and menus. Load it
 * lazily (`React.lazy(() => import("./board/CanvasBoard"))`): it is the only module that
 * imports Excalidraw, and its stylesheet goes into the page only while a canvas is mounted.
 *
 * Host-neutral: it reads no address and makes no request of its own; pictures load through `fileUrl`, and every
 * change the person makes reaches `onChange` (the host saves). A thread mounts it today and a space page next.
 *
 * - Every drawing tool stays (in the dock): lock, hand, select, rectangle, diamond, ellipse, arrow, line, pen, text,
 *   picture, eraser, frame, laser. Left out: the file menu (open, save, collaboration, its own theme switch), the
 *   shape library, embeds and links. Export as an image stays, as a dock button.
 * - Excalidraw's own one-key shortcuts work only while focus is inside the canvas (`handleKeyboardGlobally` off),
 *   and key events never leave the canvas for the host's shortcuts.
 * - Roughness 0, the host's theme (Excalidraw's dark mode), the agent's ids kept on its elements.
 */
import { Excalidraw, exportToBlob, restoreElements } from "@excalidraw/excalidraw";
import excalidrawCss from "@excalidraw/excalidraw/index.css?inline";
import type { ExcalidrawImperativeAPI, BinaryFileData, AppState } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CanvasElement } from "@plannotator/core/canvas-scene";
import { CANVAS_DOCK_TOOLS, type CanvasDockTool } from "./dock";
import "./board.css";

export interface CanvasBoardFile {
  name: string;
  mimeType: string;
}

export interface CanvasBoardScene {
  elements: readonly CanvasElement[];
  files: Record<string, CanvasBoardFile>;
}

export interface CanvasBoardChange {
  elements: CanvasElement[];
  files: Record<string, CanvasBoardFile>;
  /** Pictures the person added since the last change, to store (by file id). */
  uploads: Record<string, { mimeType: string; dataURL: string }>;
}

export interface CanvasBoardProps {
  scene: CanvasBoardScene | null;
  /** Changes when the scene is replaced from outside (the agent's new version): the canvas updates in place. */
  sceneKey: string;
  fileUrl: (name: string) => string;
  theme: "light" | "dark";
  readOnly?: boolean;
  /** Full screen: the dock moves to the top (the floating reply box owns the bottom). */
  dockAtTop?: boolean;
  /** An empty canvas opens with the pen picked, ready to draw. */
  penWhenEmpty?: boolean;
  onChange?: (change: CanvasBoardChange) => void;
  /** The canvas's own picture (PNG) of what it shows, for read-back and previews. */
  onApi?: (api: CanvasBoardApi | null) => void;
  /** Ids to tint for a moment (the parts the agent just changed). */
  flash?: readonly string[];
  /** Words in the middle of an empty canvas. */
  emptyHint?: { title: string; body: string };
}

export interface CanvasBoardApi {
  png(): Promise<Blob | null>;
  focus(): void;
}

const fileId = (name: string) => name;

/** Restore plain elements (the lift's, the store's) into elements Excalidraw draws, keeping every id. */
function restored(elements: readonly CanvasElement[]): ExcalidrawElement[] {
  return restoreElements(elements as unknown as ExcalidrawElement[], null, { refreshDimensions: false, repairBindings: true }) as ExcalidrawElement[];
}

async function dataUrlOf(url: string): Promise<{ dataURL: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ dataURL: String(reader.result), mimeType: blob.type || "image/png" });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export default function CanvasBoard(props: CanvasBoardProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const known = useRef(new Map<string, CanvasBoardFile>());
  const sent = useRef(new Set<string>());
  const lastSig = useRef("");
  const applying = useRef(false);
  const [tool, setTool] = useState<string>("selection");
  const [locked, setLocked] = useState(false);
  const [empty, setEmpty] = useState(!props.scene?.elements.some((e) => !e.isDeleted));
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  // Excalidraw's stylesheet, only while a canvas is mounted.
  useEffect(() => {
    const style = document.createElement("style");
    style.dataset.excalidraw = "";
    style.textContent = excalidrawCss;
    document.head.append(style);
    return () => style.remove();
  }, []);

  const loadFiles = useCallback(
    async (a: ExcalidrawImperativeAPI, files: Record<string, CanvasBoardFile>) => {
      const have = a.getFiles();
      const wanted = Object.entries(files).filter(([id]) => !have[id]);
      const loaded = await Promise.all(wanted.map(async ([id, f]) => ({ id, f, data: await dataUrlOf(props.fileUrl(f.name)) })));
      const add: BinaryFileData[] = [];
      for (const { id, f, data } of loaded) {
        known.current.set(id, f);
        sent.current.add(id);
        if (data) add.push({ id: id as BinaryFileData["id"], dataURL: data.dataURL as BinaryFileData["dataURL"], mimeType: (f.mimeType || data.mimeType) as BinaryFileData["mimeType"], created: Date.now() });
      }
      if (add.length) a.addFiles(add);
    },
    [props.fileUrl],
  );

  const initialData = useMemo(() => {
    const elements = props.scene ? restored(props.scene.elements) : [];
    lastSig.current = signature(elements as unknown as CanvasElement[]);
    return {
      elements,
      appState: {
        viewBackgroundColor: "transparent",
        currentItemRoughness: 0,
        currentItemFontFamily: 5,
        currentItemStrokeColor: props.theme === "dark" ? "#1e1e1e" : "#1e1e1e",
        ...(props.penWhenEmpty && !elements.length ? { activeTool: { type: "freedraw", customType: null, locked: false, lastActiveTool: null } } : {}),
      } as Partial<AppState>,
      scrollToContent: true,
    };
    // The first scene only; later ones arrive through `sceneKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The agent's new version (or another window's save): update in place, keeping the person's view.
  const firstKey = useRef(props.sceneKey);
  useEffect(() => {
    if (!api || props.sceneKey === firstKey.current) return;
    firstKey.current = props.sceneKey;
    const elements = props.scene ? restored(props.scene.elements) : [];
    applying.current = true;
    lastSig.current = signature(elements as unknown as CanvasElement[]);
    const wasEmpty = !api.getSceneElements().some((e) => !e.isDeleted);
    api.updateScene({ elements, captureUpdate: "NEVER" as never });
    if (props.scene) void loadFiles(api, props.scene.files);
    setEmpty(!elements.some((e) => !e.isDeleted));
    // The agent's first drawing on a blank canvas: brought into view.
    if (wasEmpty) requestAnimationFrame(() => fitScene(api));
    queueMicrotask(() => {
      applying.current = false;
    });
  }, [api, props.sceneKey, props.scene, loadFiles]);

  useEffect(() => {
    if (!api) return;
    if (props.scene) void loadFiles(api, props.scene.files);
    let frames = 0;
    let raf = 0;
    // Once the canvas has its size (it may still be opening): the whole drawing in view.
    const tryFit = () => {
      const { width, height } = api.getAppState();
      if ((width < 50 || height < 50) && frames++ < 60) {
        raf = requestAnimationFrame(tryFit);
        return;
      }
      fitScene(api);
    };
    raf = requestAnimationFrame(tryFit);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    props.onApi?.(
      api
        ? {
            png: async () => {
              const elements = api.getSceneElements();
              if (!elements.length) return null;
              return exportToBlob({ elements, files: api.getFiles(), mimeType: "image/png", appState: { exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false }, exportPadding: 24, maxWidthOrHeight: 1600 });
            },
            focus: () => hostRef.current?.querySelector<HTMLElement>(".excalidraw")?.focus(),
          }
        : null,
    );
    return () => props.onApi?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const onChange = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: Record<string, BinaryFileData>) => {
    setTool(appState.activeTool.type);
    setLocked(appState.activeTool.locked);
    if (applying.current || props.readOnly) return;
    const plain = elements.map((e) => (e.link ? { ...e, link: null } : e)) as unknown as CanvasElement[];
    const sig = signature(plain);
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    setEmpty(!plain.some((e) => !e.isDeleted));
    const uploads: CanvasBoardChange["uploads"] = {};
    const refs: Record<string, CanvasBoardFile> = {};
    for (const el of plain) {
      if (el.type !== "image" || !el.fileId || el.isDeleted) continue;
      const id = el.fileId;
      const k = known.current.get(id);
      if (k) refs[id] = k;
      else {
        const f = files[id];
        if (!f) continue;
        const ext = f.mimeType === "image/jpeg" ? "jpg" : f.mimeType === "image/gif" ? "gif" : f.mimeType === "image/webp" ? "webp" : "png";
        const ref = { name: `${id.replace(/[^\w-]/g, "").slice(0, 40)}.${ext}`, mimeType: f.mimeType };
        refs[id] = ref;
        if (!sent.current.has(id)) {
          uploads[id] = { mimeType: f.mimeType, dataURL: f.dataURL };
          sent.current.add(id);
          known.current.set(id, ref);
        }
      }
    }
    onChangeRef.current?.({ elements: plain, files: refs, uploads });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.readOnly]);

  // Flash the parts the agent changed.
  useEffect(() => {
    if (!api || !props.flash?.length) return;
    const ids = new Set(props.flash);
    api.updateScene({ appState: { selectedElementIds: Object.fromEntries([...ids].map((i) => [i, true])) } as never, captureUpdate: "NEVER" as never });
    const t = setTimeout(() => api.updateScene({ appState: { selectedElementIds: {} } as never, captureUpdate: "NEVER" as never }), 2400);
    return () => clearTimeout(t);
  }, [api, props.flash]);

  const pick = (t: CanvasDockTool) => {
    const a = apiRef.current;
    if (!a) return;
    if (t.kind === "lock") {
      const at = a.getAppState().activeTool;
      a.updateScene({ appState: { activeTool: { ...at, locked: !at.locked } } as never });
      setLocked(!at.locked);
      return;
    }
    if (t.kind === "export") {
      void (async () => {
        const blob = await exportToBlob({ elements: a.getSceneElements(), files: a.getFiles(), mimeType: "image/png", appState: { exportBackground: true, viewBackgroundColor: "#ffffff" }, exportPadding: 24 });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "canvas.png";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      })();
      return;
    }
    a.setActiveTool({ type: t.tool } as never);
    setTool(t.tool!);
  };

  // Keys stay in the canvas: Excalidraw's own keys work here, the host's shortcuts never see them.
  const keepKeys = (e: ReactKeyboardEvent) => e.stopPropagation();

  return (
    <div
      ref={hostRef}
      className="pn-canvas"
      data-canvas-theme={props.theme}
      data-dock={props.dockAtTop ? "top" : "bottom"}
      data-readonly={props.readOnly ? "" : undefined}
      onKeyDown={keepKeys}
      onKeyUp={keepKeys}
    >
      <Excalidraw
        excalidrawAPI={(a) => {
          apiRef.current = a;
          setApi(a);
        }}
        initialData={initialData as never}
        onChange={onChange as never}
        theme={props.theme}
        viewModeEnabled={!!props.readOnly}
        handleKeyboardGlobally={false}
        validateEmbeddable={false}
        detectScroll
        autoFocus={false}
        aiEnabled={false}
        onLinkOpen={(_el, event) => event.preventDefault()}
        UIOptions={{
          canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, toggleTheme: null, saveAsImage: false },
          tools: { image: true },
        }}
        renderTopRightUI={() => null}
      />
      {empty && !props.readOnly && props.emptyHint ? (
        <div className="pn-canvas-empty" aria-hidden="true">
          <p className="pn-canvas-empty-title">{props.emptyHint.title}</p>
          <p className="pn-canvas-empty-body">{props.emptyHint.body}</p>
        </div>
      ) : null}
      {!props.readOnly ? (
        <div className="pn-canvas-dock" role="toolbar" aria-label="Drawing tools">
          {CANVAS_DOCK_TOOLS.map((t) =>
            t.kind === "sep" ? (
              <span key={t.key} className="pn-canvas-sep" aria-hidden="true" />
            ) : (
              <button
                key={t.key}
                type="button"
                className="pn-canvas-tool"
                aria-label={t.label}
                title={t.label}
                aria-pressed={t.kind === "lock" ? locked : t.kind === "tool" ? tool === t.tool : undefined}
                data-tool={t.key}
                onClick={() => pick(t)}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: t.icon }} />
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The whole drawing in view, never larger than life, with room for the dock. */
function fitScene(api: ExcalidrawImperativeAPI) {
  const elements = api.getSceneElements().filter((e) => !e.isDeleted);
  if (!elements.length) return;
  api.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.8, animate: false });
  if (api.getAppState().zoom.value > 1) {
    api.updateScene({ appState: { zoom: { value: 1 as never } } as never, captureUpdate: "NEVER" as never });
    api.scrollToContent(elements, { animate: false });
  }
}

/** What a save would change: ids, versions and deletions (Excalidraw's onChange fires for every pointer move). */
function signature(elements: readonly CanvasElement[]): string {
  let s = "";
  for (const e of elements) s += `${e.id}:${(e as { version?: number }).version ?? 0}:${e.isDeleted ? 1 : 0};`;
  return s;
}

export { fileId as canvasFileId };
