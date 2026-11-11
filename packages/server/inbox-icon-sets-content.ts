/** Built-in icon sets embedded in the binary: each file is a literal `type: "file"` import that `bun build --compile` embeds, so nothing is read until a window asks. A set not listed here is never served. */

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
// Noto Emoji 3D: its own folder and this one entry, nothing else (noto-3d/LICENSE.md says how to remove or swap it).
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
