/**
 * Which posts get the live price card + sticky "Check prices" bar.
 *
 * A 50/50 test split by CMS post id: even ids get prices, odd ids keep today's
 * layout. Deterministic and server-side, so a post never flips between
 * visits, nothing is stored on the reader, and the readout needs no new
 * Analytics dimension: Analytics records the landing slug, a slug-to-id
 * lookup from the CMS gives the post id, and the id's parity is its arm.
 * Even-id posts that showed no prices (an airport we don't sell, a failed
 * search) still count as the price arm: an intent-to-treat readout, which
 * understates the lift rather than overstating it. Readout rule (marketing plan move 5): lot opens up 2
 * points on the price arm against the control arm, after 2,000 visits a side.
 *
 * To end the test, return "price" for every post (or delete the gate).
 */
export type PriceBarArm = "price" | "control";

export function priceBarArm(postId: unknown): PriceBarArm {
  const id = typeof postId === "number" ? postId : typeof postId === "string" ? Number(postId) : NaN;
  if (!Number.isInteger(id)) return "control";
  return id % 2 === 0 ? "price" : "control";
}

/**
 * id of the top-of-article booking prompt (ArticleBookingPrompt). The sticky
 * bar shows once it scrolls out of view. In this plain module, not the
 * 'use client' bar, so the server component can import the real string.
 */
export const BLOG_BOOKING_PROMPT_ID = "blog-booking-prompt";
