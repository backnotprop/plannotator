// The art backgrounds' vocabulary: the theme ids, the Lofi cities, and the
// names a picker shows. The ids are the stored values (Slope keeps the design
// lane's id, `skifree`); an absent or unknown stored value reads as the
// default, no background and the Harbour city. A host keeps the choice where
// it keeps its other preferences; the engine only reads it.

/** Slope keeps the design lane's id, `skifree`. */
export const ART_THEME_IDS = [
	"none",
	"weather",
	"drafting",
	"plant",
	"fortress",
	"skifree",
	"lofi",
] as const;
export type ArtThemeId = (typeof ART_THEME_IDS)[number];
export type ArtDrawnThemeId = Exclude<ArtThemeId, "none">;

/** Lofi's cities: data rows under one tile set. */
export const ART_CITY_IDS = ["harbour", "mountain", "downtown"] as const;
export type ArtCityId = (typeof ART_CITY_IDS)[number];

export const ART_THEME_LABELS: Readonly<Record<ArtThemeId, string>> = {
	none: "None",
	weather: "Weather",
	drafting: "Drafting",
	plant: "Plant",
	fortress: "Fortress",
	skifree: "Slope",
	lofi: "Lofi",
};

export const ART_CITY_LABELS: Readonly<Record<ArtCityId, string>> = {
	harbour: "Harbour",
	mountain: "Mountain",
	downtown: "Downtown",
};

export function isArtThemeId(value: unknown): value is ArtThemeId {
	return ART_THEME_IDS.some((id) => id === value);
}

export function isArtCityId(value: unknown): value is ArtCityId {
	return ART_CITY_IDS.some((id) => id === value);
}

export function parseArtTheme(value: unknown): ArtThemeId {
	return isArtThemeId(value) ? value : "none";
}

export function parseArtCity(value: unknown): ArtCityId {
	return isArtCityId(value) ? value : "harbour";
}
