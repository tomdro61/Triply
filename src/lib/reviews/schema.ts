import { z } from "zod";

/**
 * The /api/reviews request body: { bookingId, rating, details? }, sent when the customer
 * presses Save (never on page load). The review token is NOT in the body — it
 * travels in the HttpOnly review cookie (src/lib/reviews/token.ts). `details`
 * replaces every detail field at once (an omitted field inside it is stored
 * as NULL / false), so the stored review is always exactly what the form last
 * showed; without `details` only the rating changes. Nothing is defaulted from
 * outside the customer's own input.
 */

export const SHUTTLE_WAIT_VALUES = ["under_5", "5_15", "over_15"] as const;
export type ShuttleWait = (typeof SHUTTLE_WAIT_VALUES)[number];

export const REVIEW_COMMENT_MAX = 500;

export const ratingSchema = z.number().int().min(1).max(5);

export const reviewDetailsSchema = z
  .object({
    shuttleWait: z.enum(SHUTTLE_WAIT_VALUES).nullable(),
    extraCharges: z.boolean().nullable(),
    comment: z
      .string()
      .trim()
      .max(REVIEW_COMMENT_MAX)
      .nullable()
      // An all-whitespace comment is no comment.
      .transform((v) => (v ? v : null)),
    publishConsent: z.boolean(),
  })
  .strict();

export const reviewSubmitSchema = z
  .object({
    // The booking the page is showing. Must match the cookie's token: a second
    // review link opened in another tab replaces the cookie, and this tab must
    // then refuse rather than save its answers onto the other trip.
    bookingId: z.string().uuid(),
    rating: ratingSchema,
    details: reviewDetailsSchema.optional(),
  })
  .strict();

export type ReviewSubmit = z.infer<typeof reviewSubmitSchema>;
export type ReviewDetails = z.infer<typeof reviewDetailsSchema>;

/**
 * `?r=N` from a star link. Returns null for anything but a single digit 1–5:
 * a missing or garbled value means "nothing pre-selected", never a default rating.
 */
export function parseRatingParam(raw: string | string[] | undefined): number | null {
  if (typeof raw !== "string" || !/^[1-5]$/.test(raw)) return null;
  return Number(raw);
}

/**
 * Display name stored with a review: the customer's first name, and only with
 * consent. First word only, capped, so a "first name" field holding a full
 * name never publishes a surname.
 */
export function reviewDisplayName(firstName: string | null | undefined, consent: boolean): string | null {
  if (!consent || typeof firstName !== "string") return null;
  const first = firstName.trim().split(/\s+/)[0] ?? "";
  return first ? first.slice(0, 40) : null;
}
