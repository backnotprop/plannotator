import { createContext, useContext } from "react";

import type { ArtLayout } from "./protocol";
import type { ArtThemeId } from "./vocabulary";

export interface ArtBackgroundApi {
	readonly theme: ArtThemeId;
	/** Scaled by the compositor with `image-rendering: pixelated`. */
	readonly pixelated: boolean;
	/** Hand a layer's canvas to the worker; `onReady` fires after each layout's first frame. */
	mount(canvas: HTMLCanvasElement, onReady: () => void): number;
	layout(id: number, layout: ArtLayout): void;
	unmount(id: number): void;
}

/** Null outside an ArtBackgroundProvider: no background draws there. */
export const ArtBackgroundContext = createContext<ArtBackgroundApi | null>(null);

export function useArtBackground(): ArtBackgroundApi | null {
	return useContext(ArtBackgroundContext);
}
