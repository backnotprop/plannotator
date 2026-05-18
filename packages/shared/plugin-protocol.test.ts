import { describe, expect, test } from "bun:test";
import {
  PLANNOTATOR_PLUGIN_FEATURES,
  PLANNOTATOR_PLUGIN_MIN_CLIENT_VERSION,
  PLANNOTATOR_PLUGIN_PROTOCOL,
  PLANNOTATOR_PLUGIN_PROTOCOL_VERSION,
  createPluginErrorResponse,
  createPluginSuccessResponse,
  getPluginCapabilities,
  parsePluginResponse,
} from "./plugin-protocol";

describe("plugin protocol", () => {
  test("exposes versioned capabilities for plugin clients", () => {
    expect(getPluginCapabilities()).toEqual({
      protocol: PLANNOTATOR_PLUGIN_PROTOCOL,
      protocolVersion: PLANNOTATOR_PLUGIN_PROTOCOL_VERSION,
      minClientVersion: PLANNOTATOR_PLUGIN_MIN_CLIENT_VERSION,
      features: [...PLANNOTATOR_PLUGIN_FEATURES],
      daemonReady: true,
      multiSessionDaemon: false,
    });
  });

  test("wraps successful plugin results with protocol metadata", () => {
    const response = createPluginSuccessResponse(
      { approved: true },
      { mode: "plan", url: "http://localhost:19432", port: 19432, isRemote: false },
    );

    expect(response).toEqual({
      ok: true,
      protocol: PLANNOTATOR_PLUGIN_PROTOCOL,
      protocolVersion: PLANNOTATOR_PLUGIN_PROTOCOL_VERSION,
      session: {
        mode: "plan",
        url: "http://localhost:19432",
        port: 19432,
        isRemote: false,
      },
      result: { approved: true },
    });
  });

  test("wraps plugin errors with stable code and message fields", () => {
    expect(createPluginErrorResponse("invalid-request", "Missing plan")).toEqual({
      ok: false,
      protocol: PLANNOTATOR_PLUGIN_PROTOCOL,
      protocolVersion: PLANNOTATOR_PLUGIN_PROTOCOL_VERSION,
      error: {
        code: "invalid-request",
        message: "Missing plan",
      },
    });
  });

  test("parses protocol responses", () => {
    const success = createPluginSuccessResponse({ approved: true });
    const error = createPluginErrorResponse("invalid-request", "Missing plan");
    const newerCompatible = {
      ...success,
      protocolVersion: PLANNOTATOR_PLUGIN_PROTOCOL_VERSION + 1,
    };

    expect(parsePluginResponse(JSON.stringify(success))).toEqual(success);
    expect(parsePluginResponse(JSON.stringify(error))).toEqual(error);
    expect(parsePluginResponse(JSON.stringify(newerCompatible))).toEqual(newerCompatible);
    expect(parsePluginResponse("{}")).toBeNull();
    expect(parsePluginResponse("not-json")).toBeNull();
  });
});
