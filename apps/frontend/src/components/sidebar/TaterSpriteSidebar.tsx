import spriteSheet from "../../assets/sprite_package_sidebar/sprite.png";

const NATIVE_W = 117;
const NATIVE_H = 96;
const FRAMES = 24;
const DISPLAY_H = 40;
const SCALE = DISPLAY_H / NATIVE_H;
const DISPLAY_W = NATIVE_W * SCALE;
const TOTAL_WIDTH = NATIVE_W * FRAMES * SCALE;

export function TaterSpriteSidebar() {
  return (
    <div
      style={{
        width: DISPLAY_W,
        height: DISPLAY_H,
        backgroundImage: `url(${spriteSheet})`,
        backgroundSize: `${TOTAL_WIDTH}px ${DISPLAY_H}px`,
        backgroundPosition: "left center",
        animation: "tater-sidebar 4.5s steps(24) infinite",
        imageRendering: "pixelated",
        transform: "scaleX(-1)",
      }}
    >
      <style>{`
        @keyframes tater-sidebar {
          to { background-position: -${TOTAL_WIDTH}px 0; }
        }
      `}</style>
    </div>
  );
}
