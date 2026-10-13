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

/** The mark of the platform a PR/MR lives on. Unknown platforms get GitHub's. */
export const PRPlatformIcon: React.FC<{ platform: string; className?: string }> = ({ platform, className }) => {
  if (platform === "gitlab") return <GitLabIcon className={className} />;
  if (platform === "bitbucket") return <BitbucketIcon className={className} />;
  return <GitHubIcon className={className} />;
};
