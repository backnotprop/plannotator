import React from "react";

/**
 * Azure DevOps icon using the official Azure DevOps SVG logo paths.
 * Uses currentColor for theme-adaptive rendering.
 */
export const AzureDevOpsIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 32 32"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M 0 7.656 L 8.073 1.578 L 19.385 0 L 19.385 2.213 L 29.281 5.568 L 32 9.484 L 32 23.901 L 24.188 28.021 L 9.578 30 L 9.578 21.063 L 3.458 19.255 Z M 19.385 4.005 L 19.385 24.781 L 24.297 27.229 L 29.063 24.719 L 29.063 8.661 L 19.385 4.005 Z M 8.734 3.26 L 16.563 5.438 L 16.563 26.151 L 12.563 27.703 L 12.563 19.229 L 5.917 17.422 L 2.938 8.203 Z" />
  </svg>
);
