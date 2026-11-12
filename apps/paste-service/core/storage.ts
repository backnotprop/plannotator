export interface PasteStore {
  put(id: string, data: string, ttlSeconds: number): Promise<void>;
  get(id: string): Promise<string | null>;
}
