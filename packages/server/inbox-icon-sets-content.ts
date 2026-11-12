// @ts-ignore - Bun import attribute for an embedded file
import tinyManifest from "../inbox/assets/icon-sets/tiny-creatures/manifest.json" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import tinyIcons from "../inbox/assets/icon-sets/tiny-creatures/icons.bin" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import gameManifest from "../inbox/assets/icon-sets/game-icons/manifest.json" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import gameIcons from "../inbox/assets/icon-sets/game-icons/icons.bin" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import gameCredits from "../inbox/assets/icon-sets/game-icons/CREDITS.md" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import dcssManifest from "../inbox/assets/icon-sets/dcss/manifest.json" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import dcssIcons from "../inbox/assets/icon-sets/dcss/icons.bin" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import notoManifest from "../inbox/assets/icon-sets/noto-3d/manifest.json" with { type: "file" };
// @ts-ignore - Bun import attribute for an embedded file
import notoIcons from "../inbox/assets/icon-sets/noto-3d/icons.bin" with { type: "file" };

export interface BuiltInIconSetFiles {
  manifest: string;
  icons: string;
  credits?: string;
}

export const BUILT_IN_ICON_SET_FILES: Readonly<Record<string, BuiltInIconSetFiles>> = Object.freeze({
  "tiny-creatures": { manifest: tinyManifest, icons: tinyIcons },
  "game-icons": { manifest: gameManifest, icons: gameIcons, credits: gameCredits },
  dcss: { manifest: dcssManifest, icons: dcssIcons },
  "noto-3d": { manifest: notoManifest, icons: notoIcons },
} as unknown as Record<string, BuiltInIconSetFiles>);
