/**
 * Relay 1.1: the APNs topic per device, and the relay's version.
 *
 * Apple delivers a push only under the topic of the app build the token came
 * from (its bundle id), so a TestFlight build, a development build and a later
 * bundle id each need their own. The phone names its topic with its token
 * (`PUT .../apns { topic }`); the Worker accepts only a topic on its list,
 * `APNS_TOPICS` (comma-separated, a plain Worker variable), which defaults to
 * the one bundle id relay 1.0 always used. A device registered without a topic
 * (an app from before 1.1) is pushed under that same id, as 1.0 did.
 */

/** The relay's wire version, said in the Inbox socket's `hello` (1.0 said none). */
export const RELAY_VERSION = "1.1";

/** The bundle id relay 1.0 sent every push under: still the topic of a device that names none. */
export const LEGACY_TOPIC = "ai.plannotator.app";

/** A bundle id: dot-separated parts of letters, digits and hyphens. */
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const BUNDLE_ID_MAX = 155;

export function isBundleId(value: unknown): value is string {
  return typeof value === "string" && value.length <= BUNDLE_ID_MAX && BUNDLE_ID.test(value);
}

/** The allowed topics: `APNS_TOPICS` split on commas, or the legacy topic alone when it is unset or names none. */
export function allowedTopics(configured: string | undefined): Set<string> {
  const listed = (configured ?? "")
    .split(",")
    .map((topic) => topic.trim())
    .filter(isBundleId);
  return new Set(listed.length > 0 ? listed : [LEGACY_TOPIC]);
}

/** The topic a device's alert pushes go under: its own, else the legacy one. */
export function deviceTopic(stored: string | null): string {
  return stored ?? LEGACY_TOPIC;
}

/** A Live Activity's push topic (Apple's rule): the bundle id with `.push-type.liveactivity`. */
export function liveTopic(stored: string | null): string {
  return `${deviceTopic(stored)}.push-type.liveactivity`;
}
