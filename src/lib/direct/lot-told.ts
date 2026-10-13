/**
 * "The lot was (or may have been) told of this booking" as a PostgREST `.or()`
 * filter, for SELECTs only (PostgREST refuses `.or()` on an UPDATE): the
 * booking notice was stamped, or claimed. The ONE copy — the sweep's cancel
 * scan, the daily digest and the 6b cancel alert all import it. The cancel
 * CLAIM (`claim()` in lot-notice.ts) is the stricter, authoritative form of the
 * same rule. Kept in its own module so readers don't pull in the email client.
 */
export const LOT_TOLD_OR = "lot_notified_at.not.is.null,lot_notice_claimed_at.not.is.null";
