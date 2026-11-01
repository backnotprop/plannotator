import type { Mask, MaskShape } from "../mask";
import type { Ctx } from "../pix";
import type { ArtCityId, ArtDrawnThemeId } from "../vocabulary";

/** A box in LAYER pixels (the layer canvas's own resolution). */
export interface Box {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

/** Everything a theme reads about the ground it draws on. */
export interface ArtScene {
	/** The ground's visible box in CSS px. */
	readonly W: number;
	readonly H: number;
	readonly dpr: number;
	readonly dark: boolean;
	/** False under Reduce motion: the theme draws its finished still frame. */
	readonly motion: boolean;
	/** An agent panel is open on the ground (the sheet's `active`). */
	readonly active: boolean;
	readonly city: ArtCityId;
	/** The quiet mask in CSS px, theme shape included. */
	readonly mask: Mask;
	/** Totman's ski sprite (Slope), or null until it has loaded. */
	readonly totman: CanvasImageSource | null;
	readonly seed: string;
	/** The layer's size in layer px. */
	readonly LW: number;
	readonly LH: number;
}

export interface ThemeInstance {
	/** Draw the still plate for this scene into a cleared layer-size canvas. */
	bake(g: Ctx): void;
	/**
	 * Draw what moves at time `t` (ms). A "dyn" theme draws into `dyn`, which
	 * the engine has cleared inside the previous step's boxes; a "plate" theme
	 * draws into `bake`. Returns the boxes it drew, or "all" when the whole
	 * layer changed.
	 */
	step(t: number, dyn: Ctx, bake: Ctx): readonly Box[] | "all";
	/**
	 * What the frame at `t` depends on. A step whose key matches the last
	 * drawn frame's is skipped whole: nothing is cleared, drawn or composed.
	 */
	key?(t: number): string;
	/** A theme that owns its mask (Weather) supplies the alpha plate itself. */
	maskPlate?(): OffscreenCanvas;
}

export interface ThemeDef {
	readonly id: ArtDrawnThemeId;
	/** The contrast ceiling: no art pixel above this alpha, [dark, light]. */
	readonly maxAlpha: readonly [number, number];
	readonly pad: number;
	readonly ramp: number;
	readonly shape: MaskShape | null;
	/** The clock's step. */
	readonly stepMs: number;
	/** Layer px per CSS px. */
	scale(dpr: number): number;
	/** Scaled by the compositor with `image-rendering: pixelated`. */
	readonly pixelated: boolean;
	/**
	 * Strokes overlap, so the ceiling is clamped per pixel inside the theme's
	 * CPU-backed bake (never a GPU readback); otherwise the ceiling rides the
	 * mask plate's alpha.
	 */
	readonly cpuBake: boolean;
	/**
	 * Where a step draws: "dyn", a separate movers canvas cleared in the
	 * previous step's boxes, or "plate", the still plate itself (marks that
	 * accumulate, or a field that slides), with no movers canvas at all.
	 */
	readonly movers: "dyn" | "plate";
	/** The bake places things where the mask is clear (rebuilt with the mask). */
	readonly bakeReadsMask: boolean;
	create(scene: ArtScene): ThemeInstance;
}
