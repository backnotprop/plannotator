import React from "react";
import { GitHubIcon } from "./GitHubIcon";
import { GitLabIcon } from "./GitLabIcon";

/** Bitbucket bucket mark (simple-icons, CC0). Uses currentColor. */
export const BitbucketIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z" />
  </svg>
);

/** Forgejo / Gitea: a generic branch mark (not the project's logo). Uses currentColor. */
export const ForgejoIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="6" cy="5.5" r="2.5" />
    <circle cx="6" cy="18.5" r="2.5" />
    <circle cx="18" cy="9" r="2.5" />
    <path d="M6 8v8" />
    <path d="M18 11.5c0 3-4 3.5-8 4.5" />
  </svg>
);

/** The mark of the platform a PR/MR lives on. Unknown platforms get GitHub's. */
export const PRPlatformIcon: React.FC<{ platform: string; className?: string }> = ({ platform, className }) => {
  if (platform === "gitlab") return <GitLabIcon className={className} />;
  if (platform === "bitbucket") return <BitbucketIcon className={className} />;
  if (platform === "forgejo") return <ForgejoIcon className={className} />;
  return <GitHubIcon className={className} />;
};
