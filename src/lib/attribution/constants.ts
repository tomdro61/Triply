/**
 * Cookie names and limits — NO imports, safe for client bundles. The client
 * component needs only these; schema.ts (zod + Buffer) is server-side.
 */
export const ATTR_COOKIE = "triply_attr";
/** Readable companion (NOT HttpOnly) so the client can dedupe without reading
 *  the payload cookie. Carries only the last airport in context. */
export const ATTR_STATE_COOKIE = "triply_attr_state";
export const ATTR_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
export const ATTR_COOKIE_MAX_BYTES = 1024;
/** The cookie format version THIS build writes and reads. */
export const ATTR_COOKIE_VERSION = 1;
