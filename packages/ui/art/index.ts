// The art backgrounds (animated themes drawn behind an app's content), shared
// by the Plannotator Inbox and Workspaces. The engine runs in a worker
// (`@plannotator/ui/art/art.worker.ts`), which the host starts through
// ArtBackgroundProvider's `createWorker`; the host keeps the person's choice.

export { ArtBackgroundContext, useArtBackground, type ArtBackgroundApi } from "./art-context";
export {
	ArtBackgroundProvider,
	artEngineSupported,
	useReducedMotion,
	type ArtBackgroundProviderProps,
	type ArtWorkerFactory,
} from "./ArtBackgroundProvider";
export { ArtLayer, artAllowedAt, type ArtGround } from "./ArtLayer";
export { ART_DEFAULT_ASSETS } from "./assets";
export { ART_KEEP_SELECTOR } from "./collect-rects";
export type { ArtAssets, ArtConfig, ArtLayout, FromArtWorker, ToArtWorker } from "./protocol";
export { ART_THUMB_HEIGHT, ART_THUMB_WIDTH, useArtThumbnails } from "./useArtThumbnails";
export {
	ART_CITY_IDS,
	ART_CITY_LABELS,
	ART_THEME_IDS,
	ART_THEME_LABELS,
	isArtCityId,
	isArtThemeId,
	parseArtCity,
	parseArtTheme,
	type ArtCityId,
	type ArtDrawnThemeId,
	type ArtThemeId,
} from "./vocabulary";
