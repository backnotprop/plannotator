import { afterEach, describe, expect, test } from "bun:test";
import { getImageSrc } from "./ImageThumbnail";

const originalWindow = globalThis.window;

function setWindow(value: Partial<Window>) {
  Object.defineProperty(globalThis, "window", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: originalWindow,
    configurable: true,
  });
});

describe("getImageSrc", () => {
  test("uses the root API base by default", () => {
    setWindow({});
    expect(getImageSrc("/tmp/screen shot.png")).toBe("/api/image?path=%2Ftmp%2Fscreen%20shot.png");
  });

  test("uses the daemon-scoped API base for local image resources", () => {
    setWindow({ __PLANNOTATOR_API_BASE__: "/s/sess_123/api" });
    expect(getImageSrc("/tmp/screen shot.png")).toBe("/s/sess_123/api/image?path=%2Ftmp%2Fscreen%20shot.png");
    expect(getImageSrc("images/mock.png", "/repo")).toBe("/s/sess_123/api/image?path=images%2Fmock.png&base=%2Frepo");
  });

  test("leaves remote image URLs untouched", () => {
    setWindow({ __PLANNOTATOR_API_BASE__: "/s/sess_123/api" });
    expect(getImageSrc("https://example.com/image.png")).toBe("https://example.com/image.png");
  });
});
