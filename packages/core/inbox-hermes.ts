export const HERMES_PLUGIN_SOURCE = "backnotprop/plannotator/apps/hermes-plugin";
export const HERMES_PLUGIN_INSTALL = `hermes plugins install ${HERMES_PLUGIN_SOURCE} --enable`;
export const HERMES_PLUGIN_NAME = "plannotator";
export const HERMES_WAKE_GRANT: readonly string[] = ["config", "set", `plugins.entries.${HERMES_PLUGIN_NAME}.allow_gateway_injection`, "true"];
export const HERMES_WAKE_GRANT_LINE = `hermes ${HERMES_WAKE_GRANT.join(" ")}`;
export const HERMES_APPLIES = "It applies to new Hermes Agent sessions.";
