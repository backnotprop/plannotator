import type { ReviewGitRuntime } from "./review-core";

type Assert<T extends true> = T;
type IsRequired<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;

type RuntimeRequiresFileInfo = Assert<
  IsRequired<ReviewGitRuntime, "getFileInfo">
>;
type RuntimeRequiresReadLink = Assert<
  IsRequired<ReviewGitRuntime, "readLink">
>;
