import type { ReactNode } from "react";

import { motion } from "motion/react";

import type { RailMotion } from "./lib/shellMotion";

export function DockedPanelClip({
  motion: panelMotion,
  children,
}: {
  motion: RailMotion;
  children: ReactNode;
}) {
  return (
    <motion.div
      data-docked-panel-clip
      className="flex h-full shrink-0 justify-end overflow-hidden"
      style={{ width: panelMotion.outerWidth }}
    >
      <motion.div
        className="flex h-full shrink-0"
        style={{ width: panelMotion.width, opacity: panelMotion.progress }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
