import type { ArtDrawnThemeId } from "../vocabulary";
import { drafting } from "./drafting";
import { fortressTheme } from "./fortress";
import { lofi } from "./lofi";
import { plant } from "./plant";
import { slope } from "./slope";
import type { ThemeDef } from "./types";
import { weather } from "./weather";

export const THEMES: Readonly<Record<ArtDrawnThemeId, ThemeDef>> = {
	weather,
	drafting,
	plant,
	fortress: fortressTheme,
	skifree: slope,
	lofi,
};
