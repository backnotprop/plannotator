import { describe, expect, test } from "bun:test";
import {
  createPaste,
  DEFAULT_PASTE_MAX_SIZE,
  handleRequest,
} from "./handler";
import type { PasteStore } from "./storage";

class MemoryPasteStore implements PasteStore {
  values = new Map<string, string>();

  async put(id: string, data: string): Promise<void> {
    this.values.set(id, data);
  }

  async get(id: string): Promise<string | null> {
    return this.values.get(id) ?? null;
  }
}

describe("paste payload limits", () => {
  test("default limit accepts HTML-scale encrypted payloads above the old 512 KB ceiling", async () => {
    const store = new MemoryPasteStore();

    const result = await createPaste("x".repeat(600 * 1024), store);

    expect(result.id).toHaveLength(8);
    expect(store.values.get(result.id)).toHaveLength(600 * 1024);
  });

  test("rejects payloads above the default encrypted payload limit", async () => {
    const store = new MemoryPasteStore();

    await expect(createPaste("x".repeat(DEFAULT_PASTE_MAX_SIZE + 1), store))
      .rejects
      .toMatchObject({
        status: 413,
        message: "Payload too large (max 5 MB encrypted)",
      });
  });
});

describe("paste request validation", () => {
  test("JSON null returns a client error without writing", async () => {
    const store = new MemoryPasteStore();
    const response = await handleRequest(new Request("http://localhost/api/paste", {
      method: "POST",
      body: "null",
    }), store, {});

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing or invalid "data" field' });
    expect(store.values.size).toBe(0);
  });

  test("enforces the size limit in UTF-8 bytes", async () => {
    const store = new MemoryPasteStore();

    await createPaste("éé", store, { maxSize: 4 });
    await expect(createPaste("ééé", store, { maxSize: 4 })).rejects.toMatchObject({ status: 413 });
    expect(store.values.size).toBe(1);
  });
});
