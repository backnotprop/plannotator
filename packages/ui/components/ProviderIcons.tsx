/// <reference path="../globals.d.ts" />
import type React from 'react';
import codexPng from '../assets/icon-codex.png';

/** Claude icon — extracted from apps/marketing/public/assets/icon-claude.svg */
export const ClaudeIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className={className}>
    <path d="m6.283 21.28 6.293-3.531.106-.306-.106-.171h-.307l-1.051-.065-3.596-.097-3.118-.13-3.021-.162-.761-.161-.712-.94.073-.469.639-.429.916.08 2.023.138 3.037.209 2.203.13 3.263.339h.518l.073-.21-.177-.129-.138-.13-3.142-2.129-3.401-2.25-1.782-1.296-.963-.656-.486-.616-.21-1.343.875-.963 1.175.08.3.08 1.19.915 2.542 1.967 3.319 2.445.486.404.194-.138.024-.097-.218-.365-1.806-3.263-1.926-3.32-.857-1.375-.227-.825c-.08-.339-.138-.624-.138-.972L8.384.177 8.935 0l1.328.177.56.486.824 1.887 1.337 2.972 2.073 4.04.607 1.199.324 1.11.121.339h.21v-.194l.17-2.276.315-2.795.307-3.596.106-1.012.501-1.214.995-.657.778.372.639.916-.088.591-.381 2.471-.745 3.87-.485 2.591h.282l.324-.324 1.311-1.74 2.203-2.754.972-1.093 1.133-1.207.728-.574h1.376l1.013 1.505-.454 1.555-1.416 1.797-1.175 1.522-1.685 2.268-1.051 1.814.097.144.25-.023 3.805-.81 2.056-.372 2.454-.421 1.11.518.12.527-.436 1.078-2.624.648-3.077.615-4.582 1.084-.057.041.065.08 2.065.195.883.047h2.162l4.025.3 1.052.696.63.851-.106.647-1.619.825-2.186-.518-5.1-1.214-1.75-.436h-.242v.145l1.458 1.425 2.671 2.412 3.346 3.11.17.769-.43.607-.453-.065-2.939-2.211-1.134-.996-2.568-2.162h-.17v.227l.591.866 3.125 4.697.162 1.441-.226.468-.81.283-.89-.162-1.829-2.568-1.888-2.891-1.522-2.592-.186.106-.898 9.677-.421.495-.972.371-.81-.615-.43-.996.43-1.967.518-2.568.422-2.041.38-2.535.226-.842-.015-.056-.185.023-1.912 2.624-2.906 3.928-2.3 2.462-.551.218-.954-.494.088-.883.533-.787 3.184-4.049 1.919-2.509 1.24-1.449-.009-.21h-.073l-8.455 5.49-1.505.194-.648-.607.08-.995.307-.324 2.542-1.749-.009.008z" fill="#d97757" />
  </svg>
);

/** Codex icon — PNG from apps/marketing/public/assets/icon-codex.png */
export const CodexIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <img src={codexPng} alt="" className={`${className} rounded-sm`} />
);

/** Pi icon — extracted from apps/marketing/public/assets/icon-pi.svg */
export const PiIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" className={className}>
    <path fill="currentColor" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"/>
    <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z"/>
  </svg>
);

/** OpenCode icon — extracted from apps/marketing/public/assets/icon-opencode-dark.svg */
export const OpenCodeIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className={className}>
    <path d="M3 32V0h26v32zM22 7H10v18h12z" fill="currentColor"/>
    <path d="M10 13h12v12H10z" fill="currentColor" opacity={0.4}/>
  </svg>
);

/** Antigravity icon — official multi-color Antigravity emblem */
export const AntigravityIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg viewBox="0 0 24 24" className={className} xmlns="http://www.w3.org/2000/svg">
    <title>Antigravity</title>
    <mask height="23" id="lobe-icons-antigravity-0-_R_0_" maskUnits="userSpaceOnUse" width="24" x="0" y="1">
      <path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z" fill="#fff" />
    </mask>
    <g mask="url(#lobe-icons-antigravity-0-_R_0_)">
      <g filter="url(#lobe-icons-antigravity-1-_R_0_)">
        <path d="M-1.018-3.992c-.408 3.591 2.686 6.89 6.91 7.37 4.225.48 7.98-2.043 8.387-5.633.408-3.59-2.686-6.89-6.91-7.37-4.225-.479-7.98 2.043-8.387 5.633z" fill="#FFE432" />
      </g>
      <g filter="url(#lobe-icons-antigravity-2-_R_0_)">
        <path d="M15.269 7.747c1.058 4.557 5.691 7.374 10.348 6.293 4.657-1.082 7.575-5.653 6.516-10.21-1.058-4.556-5.691-7.374-10.348-6.292-4.657 1.082-7.575 5.653-6.516 10.21z" fill="#FC413D" />
      </g>
      <g filter="url(#lobe-icons-antigravity-3-_R_0_)">
        <path d="M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z" fill="#00B95C" />
      </g>
      <g filter="url(#lobe-icons-antigravity-4-_R_0_)">
        <path d="M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z" fill="#00B95C" />
      </g>
      <g filter="url(#lobe-icons-antigravity-5-_R_0_)">
        <path d="M-7.608 14.703c3.352 3.424 9.126 3.208 12.896-.483 3.77-3.69 4.108-9.459.756-12.883C2.69-2.087-3.083-1.871-6.853 1.82c-3.77 3.69-4.108 9.458-.755 12.883z" fill="#00B95C" />
      </g>
      <g filter="url(#lobe-icons-antigravity-6-_R_0_)">
        <path d="M9.932 27.617c1.04 4.482 5.384 7.303 9.7 6.3 4.316-1.002 6.971-5.448 5.93-9.93-1.04-4.483-5.384-7.304-9.7-6.301-4.316 1.002-6.971 5.448-5.93 9.93z" fill="#3186FF" />
      </g>
      <g filter="url(#lobe-icons-antigravity-7-_R_0_)">
        <path d="M2.572-8.185C.392-3.329 2.778 2.472 7.9 4.771c5.122 2.3 11.042.227 13.222-4.63 2.18-4.855-.205-10.656-5.327-12.955-5.122-2.3-11.042-.227-13.222 4.63z" fill="#FBBC04" />
      </g>
      <g filter="url(#lobe-icons-antigravity-8-_R_0_)">
        <path d="M-3.267 38.686c-5.277-2.072 3.742-19.117 5.984-24.83 2.243-5.712 8.34-8.664 13.616-6.592 5.278 2.071 11.533 13.482 9.29 19.195-2.242 5.713-23.613 14.298-28.89 12.227z" fill="#3186FF" />
      </g>
      <g filter="url(#lobe-icons-antigravity-9-_R_0_)">
        <path d="M28.71 17.471c-1.413 1.649-5.1.808-8.236-1.878-3.135-2.687-4.531-6.201-3.118-7.85 1.412-1.649 5.1-.808 8.235 1.878s4.532 6.2 3.119 7.85z" fill="#749BFF" />
      </g>
      <g filter="url(#lobe-icons-antigravity-10-_R_0_)">
        <path d="M18.163 9.077c5.81 3.93 12.502 4.19 14.946.577 2.443-3.612-.287-9.727-6.098-13.658-5.81-3.931-12.502-4.19-14.946-.577-2.443 3.612.287 9.727 6.098 13.658z" fill="#FC413D" />
      </g>
      <g filter="url(#lobe-icons-antigravity-11-_R_0_)">
        <path d="M-.915 2.684c-1.44 3.473-.97 6.967 1.05 7.804 2.02.837 4.824-1.3 6.264-4.772 1.44-3.473.97-6.967-1.05-7.804-2.02-.837-4.824 1.3-6.264 4.772z" fill="#FFEE48" />
      </g>
    </g>
    <defs>
      <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="17.587" id="lobe-icons-antigravity-1-_R_0_" width="19.838" x="-3.288" y="-11.917"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="1.117" /></filter>
      <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="38.565" id="lobe-icons-antigravity-2-_R_0_" width="38.9" x="4.251" y="-13.493"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="5.4" /></filter>
      <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="36.517" id="lobe-icons-antigravity-3-_R_0_" width="40.955" x="-21.889" y="-10.592"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="4.591" /></filter>
      <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="36.517" id="lobe-icons-antigravity-4-_R_0_" width="40.955" x="-21.889" y="-10.592"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="4.591" /></filter>
      <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="36.595" id="lobe-icons-antigravity-5-_R_0_" width="36.632" x="-19.099" y="-10.278"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="4.591" /></filter>
      <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="34.087" id="lobe-icons-antigravity-6-_R_0_" width="33.533" x=".981" y="8.758"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="4.363" /></filter>
      <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="35.276" id="lobe-icons-antigravity-7-_R_0_" width="35.978" x="-6.143" y="-21.659"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="3.954" /></filter>
      <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="46.523" id="lobe-icons-antigravity-8-_R_0_" width="45.114" x="-11.96" y="-.46"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="3.531" /></filter>
      <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="24.054" id="lobe-icons-antigravity-9-_R_0_" width="25.094" x="10.485" y=".58"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="3.159" /></filter>
      <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="30.007" id="lobe-icons-antigravity-10-_R_0_" width="33.508" x="5.833" y="-12.467"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="2.669" /></filter>
      <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="26.151" id="lobe-icons-antigravity-11-_R_0_" width="22.194" x="-8.355" y="-8.876"><feFlood floodOpacity="0" result="BackgroundImageFix" /><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape" /><feGaussianBlur result="effect1_foregroundBlur_977_115" stdDeviation="3.303" /></filter>
    </defs>
  </svg>
);

/** Generic fallback icon for unknown providers */
const GenericProviderIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 00.659 1.591L19 14.5m-4.75-11.396c.251.023.501.05.75.082M12 21a8.966 8.966 0 005.982-2.275M12 21a8.966 8.966 0 01-5.982-2.275M12 21V14.5" />
  </svg>
);

/** "Ask this session": a speech bubble, since the answer comes from the agent session itself. */
const SessionIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5m-7 6 2.5-3H18a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3z" />
  </svg>
);

/** Provider metadata: maps provider type name to display label and icon component. */
export const PROVIDER_META: Record<string, { label: string; icon: React.FC<{ className?: string }> }> = {
  'claude-agent-sdk': { label: 'Claude', icon: ClaudeIcon },
  'codex-sdk': { label: 'Codex', icon: CodexIcon },
  'pi-sdk': { label: 'Pi', icon: PiIcon },
  'session-bridge': { label: 'Ask this session', icon: SessionIcon },
  'antigravity-ls': { label: 'Antigravity', icon: AntigravityIcon },
};

/**
 * Get provider metadata, with fallback for unknown providers. A server-sent
 * `label` (e.g. "Ask this session · Pi") overrides the name lookup.
 */
export function getProviderMeta(providerName: string, label?: string): { label: string; icon: React.FC<{ className?: string }> } {
  const meta = PROVIDER_META[providerName] ?? { label: providerName, icon: GenericProviderIcon };
  return label ? { ...meta, label } : meta;
}
