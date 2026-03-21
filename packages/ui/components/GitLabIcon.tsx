import React from "react";

export const GitLabIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 16 16"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M8 14.586L10.489 7.34H5.51L8 14.586Z" />
    <path d="M8 14.586L5.511 7.34H1.328L8 14.586Z" opacity="0.7" />
    <path d="M1.328 7.34L0.265 10.608A0.762 0.762 0 000.54 11.451L8 14.586L1.328 7.34Z" opacity="0.5" />
    <path d="M1.328 7.34H5.511L3.727 1.852C3.646 1.604 3.291 1.604 3.21 1.852L1.328 7.34Z" />
    <path d="M8 14.586L10.489 7.34H14.672L8 14.586Z" opacity="0.7" />
    <path d="M14.672 7.34L15.735 10.608A0.762 0.762 0 0115.46 11.451L8 14.586L14.672 7.34Z" opacity="0.5" />
    <path d="M14.672 7.34H10.489L12.273 1.852C12.354 1.604 12.709 1.604 12.79 1.852L14.672 7.34Z" />
  </svg>
);
