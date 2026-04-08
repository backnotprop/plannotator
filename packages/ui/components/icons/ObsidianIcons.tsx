import React from 'react';

/**
 * Obsidian icons.
 *
 * ObsidianIcon      — Full branded logo with background rect and gradients. Use for
 *                     larger display contexts (settings, onboarding, etc.).
 * ObsidianIconRaw   — Minimal path-only mark in Obsidian purple. Use inline in compact
 *                     UI surfaces like the file browser directory header.
 */

interface IconProps {
  className?: string;
}

export const ObsidianIcon: React.FC<IconProps> = ({ className = 'w-8 h-8' }) => (
  <svg
    className={className}
    width="512"
    height="512"
    viewBox="0 0 512 512"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <radialGradient
        id="obs-b"
        cx="0"
        cy="0"
        r="1"
        gradientUnits="userSpaceOnUse"
        gradientTransform="matrix(-48 -185 123 -32 179 429.7)"
      >
        <stop stopColor="#fff" stopOpacity=".4" />
        <stop offset="1" stopOpacity=".1" />
      </radialGradient>
      <radialGradient
        id="obs-c"
        cx="0"
        cy="0"
        r="1"
        gradientUnits="userSpaceOnUse"
        gradientTransform="matrix(41 -310 229 30 341.6 351.3)"
      >
        <stop stopColor="#fff" stopOpacity=".6" />
        <stop offset="1" stopColor="#fff" stopOpacity=".1" />
      </radialGradient>
      <radialGradient
        id="obs-d"
        cx="0"
        cy="0"
        r="1"
        gradientUnits="userSpaceOnUse"
        gradientTransform="matrix(57 -261 178 39 190.5 296.3)"
      >
        <stop stopColor="#fff" stopOpacity=".8" />
        <stop offset="1" stopColor="#fff" stopOpacity=".4" />
      </radialGradient>
      <radialGradient
        id="obs-e"
        cx="0"
        cy="0"
        r="1"
        gradientUnits="userSpaceOnUse"
        gradientTransform="matrix(-79 -133 153 -90 321.4 464.2)"
      >
        <stop stopColor="#fff" stopOpacity=".3" />
        <stop offset="1" stopOpacity=".3" />
      </radialGradient>
      <radialGradient
        id="obs-f"
        cx="0"
        cy="0"
        r="1"
        gradientUnits="userSpaceOnUse"
        gradientTransform="matrix(-29 136 -92 -20 300.7 149.9)"
      >
        <stop stopColor="#fff" stopOpacity="0" />
        <stop offset="1" stopColor="#fff" stopOpacity=".2" />
      </radialGradient>
      <radialGradient
        id="obs-g"
        cx="0"
        cy="0"
        r="1"
        gradientUnits="userSpaceOnUse"
        gradientTransform="matrix(72 73 -155 153 137.8 225.2)"
      >
        <stop stopColor="#fff" stopOpacity=".2" />
        <stop offset="1" stopColor="#fff" stopOpacity=".4" />
      </radialGradient>
      <radialGradient
        id="obs-h"
        cx="0"
        cy="0"
        r="1"
        gradientUnits="userSpaceOnUse"
        gradientTransform="matrix(20 118 -251 43 215.1 273.7)"
      >
        <stop stopColor="#fff" stopOpacity=".1" />
        <stop offset="1" stopColor="#fff" stopOpacity=".3" />
      </radialGradient>
      <radialGradient
        id="obs-i"
        cx="0"
        cy="0"
        r="1"
        gradientUnits="userSpaceOnUse"
        gradientTransform="matrix(-162 -85 268 -510 374.4 371.7)"
      >
        <stop stopColor="#fff" stopOpacity=".2" />
        <stop offset=".5" stopColor="#fff" stopOpacity=".2" />
        <stop offset="1" stopColor="#fff" stopOpacity=".3" />
      </radialGradient>
      <filter
        id="obs-a"
        x="80.1"
        y="37"
        width="351.1"
        height="443.2"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feFlood floodOpacity="0" result="BackgroundImageFix" />
        <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
        <feGaussianBlur stdDeviation="6.5" result="effect1_foregroundBlur_744_9191" />
      </filter>
    </defs>
    <rect fill="#262626" width="512" height="512" rx="100" />
    <g filter="url(#obs-a)">
      <path
        d="M359.2 437.5c-2.6 19-21.3 33.9-40 28.7-26.5-7.2-57.2-18.6-84.8-20.7l-42.4-3.2a28 28 0 0 1-18-8.3l-73-74.8a27.7 27.7 0 0 1-5.4-30.7s45-98.6 46.8-103.7c1.6-5.1 7.8-49.9 11.4-73.9a28 28 0 0 1 9-16.5L249 57.2a28 28 0 0 1 40.6 3.4l72.6 91.6a29.5 29.5 0 0 1 6.2 18.3c0 17.3 1.5 53 11.2 76a301.3 301.3 0 0 0 35.6 58.2 14 14 0 0 1 1 15.6c-6.3 10.7-18.9 31.3-36.6 57.6a142.2 142.2 0 0 0-20.5 59.6Z"
        fill="#000"
        fillOpacity=".3"
      />
    </g>
    <path
      d="M359.9 434.3c-2.6 19.1-21.3 34-40 28.9-26.4-7.3-57-18.7-84.7-20.8l-42.3-3.2a27.9 27.9 0 0 1-18-8.4l-73-75a27.9 27.9 0 0 1-5.4-31s45.1-99 46.8-104.2c1.7-5.1 7.8-50 11.4-74.2a28 28 0 0 1 9-16.6l86.2-77.5a28 28 0 0 1 40.6 3.5l72.5 92a29.7 29.7 0 0 1 6.2 18.3c0 17.4 1.5 53.2 11.1 76.3a303 303 0 0 0 35.6 58.5 14 14 0 0 1 1.1 15.7c-6.4 10.8-18.9 31.4-36.7 57.9a143.3 143.3 0 0 0-20.4 59.8Z"
      fill="#6C31E3"
    />
    <path
      d="M182.7 436.4c33.9-68.7 33-118 18.5-153-13.2-32.4-37.9-52.8-57.3-65.5-.4 1.9-1 3.7-1.8 5.4L96.5 324.8a27.9 27.9 0 0 0 5.5 31l72.9 75c2.3 2.3 5 4.2 7.8 5.6Z"
      fill="url(#obs-b)"
    />
    <path
      d="M274.9 297c9.1.9 18 2.9 26.8 6.1 27.8 10.4 53.1 33.8 74 78.9 1.5-2.6 3-5.1 4.6-7.5a1222 1222 0 0 0 36.7-57.9 14 14 0 0 0-1-15.7 303 303 0 0 1-35.7-58.5c-9.6-23-11-58.9-11.1-76.3 0-6.6-2.1-13.1-6.2-18.3l-72.5-92-1.2-1.5c5.3 17.5 5 31.5 1.7 44.2-3 11.8-8.6 22.5-14.5 33.8-2 3.8-4 7.7-5.9 11.7a140 140 0 0 0-15.8 58c-1 24.2 3.9 54.5 20 95Z"
      fill="url(#obs-c)"
    />
    <path
      d="M274.8 297c-16.1-40.5-21-70.8-20-95 1-24 8-42 15.8-58l6-11.7c5.8-11.3 11.3-22 14.4-33.8a78.5 78.5 0 0 0-1.7-44.2 28 28 0 0 0-39.4-2l-86.2 77.5a28 28 0 0 0-9 16.6L144.2 216c0 .7-.2 1.3-.3 2 19.4 12.6 44 33 57.3 65.3 2.6 6.4 4.8 13.1 6.4 20.4a200 200 0 0 1 67.2-6.8Z"
      fill="url(#obs-d)"
    />
    <path
      d="M320 463.2c18.6 5.1 37.3-9.8 39.9-29a153 153 0 0 1 15.9-52.2c-21-45.1-46.3-68.5-74-78.9-29.5-11-61.6-7.3-94.2.6 7.3 33.1 3 76.4-24.8 132.7 3.1 1.6 6.6 2.5 10.1 2.8l43.9 3.3c23.8 1.7 59.3 14 83.2 20.7Z"
      fill="url(#obs-e)"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M255 200.5c-1.1 24 1.9 51.4 18 91.8l-5-.5c-14.5-42.1-17.7-63.7-16.6-88 1-24.3 8.9-43 16.7-59 2-4 6.6-11.5 8.6-15.3 5.8-11.3 9.7-17.2 13-27.5 4.8-14.4 3.8-21.2 3.2-28 3.7 24.5-10.4 45.8-21 67.5a145 145 0 0 0-17 59Z"
      fill="url(#obs-f)"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M206 285.1c2 4.4 3.7 8 4.9 13.5l-4.3 1c-1.7-6.4-3-11-5.5-16.5-14.6-34.3-38-52-57-65 23 12.4 46.7 31.9 61.9 67Z"
      fill="url(#obs-g)"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M211.1 303c8 37.5-1 85.2-27.5 131.6 22.2-46 33-90.1 24-131l3.5-.7Z"
      fill="url(#obs-h)"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M302.7 299.5c43.5 16.3 60.3 52 72.8 81.9-15.5-31.2-37-65.7-74.4-78.5-28.4-9.8-52.4-8.6-93.5.7l-.9-4c43.6-10 66.4-11.2 96 0Z"
      fill="url(#obs-i)"
    />
  </svg>
);

export const ObsidianIconRaw: React.FC<IconProps> = ({ className = 'w-[14px] h-[16px]' }) => (
  <svg
    className={className}
    viewBox="0 0 22 25"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      fill="#A88BFA"
      d="m6.91927 14.5955c.64053-.1907 1.67255-.4839 2.85923-.5565-.71191-1.7968-.88376-3.3691-.74554-4.76905.15962-1.61678.72977-2.9662 1.28554-4.11442.1186-.24501.2326-.47313.3419-.69198.1549-.30984.3004-.60109.4365-.8953.2266-.48978.3948-.92231.4798-1.32416.0836-.39515.0841-.74806-.0148-1.08657-.099-.338982-.3093-.703864-.7093-1.1038132-.5222-.1353116-1.1017-.0165173-1.53613.3742922l-5.15591 4.638241c-.28758.25871-.47636.60929-.53406.99179l-.44455 2.94723c.69903.6179 2.42435 2.41414 3.47374 4.90644.09364.2224.1819.4505.26358.6838z"
    />
    <path
      fill="#A88BFA"
      d="m2.97347 10.3512c-.02431.1037-.05852.205-.10221.3024l-2.724986 6.0735c-.279882.6238-.15095061 1.3552.325357 1.8457l4.288349 4.4163c2.1899-3.2306 1.87062-6.2699.87032-8.6457-.75846-1.8013-1.90801-3.2112-2.65683-3.9922z"
    />
    <path
      fill="#A88BFA"
      d="m5.7507 23.5094c.07515.012.15135.0192.2281.0215.81383.0244 2.18251.0952 3.29249.2997.90551.1669 2.70051.6687 4.17761 1.1005 1.1271.3294 2.2886-.5707 2.4522-1.7336.1192-.8481.343-1.8075.7553-2.6869l-.0095.0033c-.6982-1.9471-1.5865-3.2044-2.5178-4.0073-.9284-.8004-1.928-1.1738-2.8932-1.3095-1.60474-.2257-3.07497.1961-4.00103.4682.55465 2.3107.38396 5.0295-1.48417 7.8441z"
    />
    <path
      fill="#A88BFA"
      d="m17.3708 19.3102c.9267-1.3985 1.5868-2.4862 1.9352-3.0758.1742-.295.1427-.6648-.0638-.9383-.5377-.7126-1.5666-2.1607-2.1272-3.5015-.5764-1.3785-.6624-3.51876-.6673-4.56119-.0019-.39626-.1275-.78328-.3726-1.09465l-3.3311-4.23183c-.0117.19075-.0392.37998-.0788.56747-.1109.52394-.32 1.04552-.5585 1.56101-.1398.30214-.3014.62583-.4646.95284-.1086.21764-.218.4368-.3222.652-.5385 1.11265-1.0397 2.32011-1.1797 3.73901-.1299 1.31514.0478 2.84484.8484 4.67094.1333.0113.2675.0262.4023.0452 1.1488.1615 2.3546.6115 3.4647 1.5685.9541.8226 1.8163 2.0012 2.5152 3.6463z"
    />
  </svg>
);
