import type { PasteStore } from "../core/storage";

/**
 * S3-compatible paste store (future implementation).
 *
 * TTL handled via S3 lifecycle rules configured on the bucket.
 * Implement when needed for AWS Lambda or other cloud deployments.
 */
export class S3PasteStore implements PasteStore {
  async put(_id: string, _data: string, _ttlSeconds: number): Promise<void> {
    throw new Error("S3PasteStore not yet implemented");
  }

  async get(_id: string): Promise<string | null> {
    throw new Error("S3PasteStore not yet implemented");
  }
}
