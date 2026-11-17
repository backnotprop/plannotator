// The thread canvas's dev harness: a board from boards/ laid out by the real lift and shown in the real canvas.
// `?board=a6&theme=dark&pins={"av":{"x":..}}`. window.__canvas holds the lift's result for a driver to read.
import { createRoot } from "react-dom/client";
import { lazy, Suspense, useEffect, useState } from "react";
import { liftBoard, type LiftResult } from "../../../packages/inbox/canvas/board/lift";

const CanvasBoard = lazy(() => import("../../../packages/inbox/canvas/board/CanvasBoard"));
const q = new URLSearchParams(location.search);
const theme = q.get("theme") === "dark" ? "dark" : "light";
if (theme === "dark") document.documentElement.classList.add("dark");
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = `${location.origin}/excalidraw/`;

function App() {
  const [lifted, setLifted] = useState<LiftResult | null>(null);
  useEffect(() => {
    void (async () => {
      const board = await (await fetch(`/boards/${q.get("board") ?? "a6"}.html`)).text();
      const result = await liftBoard({ board, pins: JSON.parse(q.get("pins") ?? "{}"), pictureUrl: (n) => `/boards/files/${n}` });
      (window as unknown as { __canvas: unknown }).__canvas = result;
      setLifted(result);
    })();
  }, []);
  if (!lifted) return null;
  return (
    <Suspense fallback={null}>
      <CanvasBoard
        scene={{ elements: lifted.elements, files: lifted.files }}
        sceneKey="1"
        fileUrl={(n) => `/boards/files/${n}`}
        theme={theme}
        dockAtTop={q.get("dock") === "top"}
        onChange={(c) => ((window as unknown as { __change: unknown }).__change = c)}
        emptyHint={{ title: "Draw, type or paste a picture", body: "The agent reads what you add with your next reply. It can draw here too." }}
      />
    </Suspense>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
