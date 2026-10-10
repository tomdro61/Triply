import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { appBase, bookAgainLabel, bookAgainUrl } from "./links";
import { reviewLinkExpiry, reviewUrl, signReviewToken } from "./token";
import type { ReviewCandidate } from "./select";

/**
 * The post-trip review email (and its one reminder). Plain and short: five
 * tappable stars, one line on why it helps, a secondary "book your next trip"
 * button. No incentive. Styled like the other HTML emails (checkout-recovery,
 * waitlist-notify); footer wording from the booking confirmation.
 *
 * Reply-To is the support inbox so "reply to this email" (shown on the review
 * page for a low rating) reaches a human — FROM is the bookings@ sender.
 */

export const REVIEW_REPLY_TO = "support@triplypro.com";

/** Deadline for one Resend call. The cron must settle inside its 60 s. */
export const RESEND_SEND_TIMEOUT_MS = 10_000;

/** Resend's per-call failure with the HTTP status kept (same shape as the
 *  checkout-recovery and waitlist crons'). */
export class ReviewSendError extends Error {
  readonly statusCode: number | undefined;
  readonly resendName: string | undefined;
  constructor(message: string, statusCode: number | undefined, resendName?: string) {
    super(message);
    this.name = "ReviewSendError";
    this.statusCode = statusCode;
    this.resendName = resendName;
  }
}

export function isTransientSendFailure(error: unknown): boolean {
  if (error instanceof ReviewSendError) {
    const c = error.statusCode;
    return c === undefined || c === 429 || c >= 500;
  }
  return true;
}

/** Resend rejected OUR credentials or domain — every later send would too. */
export function isSendConfigFailure(error: unknown): boolean {
  return error instanceof ReviewSendError && (error.statusCode === 401 || error.statusCode === 403);
}

/** The idempotency key was already used: an email may already be out. */
export function isIdempotencyConflict(error: unknown): boolean {
  if (!(error instanceof ReviewSendError)) return false;
  return (
    error.statusCode === 409 ||
    error.resendName === "invalid_idempotent_request" ||
    error.resendName === "concurrent_idempotent_requests"
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildReviewEmail(c: ReviewCandidate): { subject: string; html: string; text: string } {
  const token = signReviewToken(c.bookingId, reviewLinkExpiry(c.checkoutDate));
  const starUrls = [1, 2, 3, 4, 5].map((n) => reviewUrl(token, n));
  const againUrl = bookAgainUrl(c.airportCode);
  const againLabel = bookAgainLabel(c.airportCode);
  const lot = c.lotName.trim();

  const subject =
    c.kind === "reminder" ? `Quick one: how was ${lot}?` : `How was parking at ${lot}?`;
  const greeting = c.firstName ? `Hi ${c.firstName},` : "Hi,";
  const ask =
    c.kind === "reminder"
      ? `Got 10 seconds? Tap a star to rate your parking at ${lot}.`
      : `Thanks for parking with Triply. How was ${lot}? Tap a star — that's it.`;
  const why = "Your rating helps other travellers pick the right lot.";
  const footer = "You received this email because you booked on triplypro.com";

  const text = [
    greeting,
    "",
    ask,
    "",
    ...starUrls.map((u, i) => `${i + 1} star${i === 0 ? "" : "s"}: ${u}`),
    "",
    why,
    "",
    `${againLabel}: ${againUrl}`,
    "",
    `Questions? Reply to this email or visit ${appBase()}/help`,
    "",
    footer,
  ].join("\n");

  const stars = starUrls
    .map(
      (u, i) => `
              <td style="padding: 0 4px;">
                <a href="${escapeHtml(u)}" title="${i + 1} star${i === 0 ? "" : "s"}" style="display: inline-block; text-decoration: none; color: #f59e0b; font-size: 40px; line-height: 44px;">&#9733;</a>
                <div style="font-size: 12px; color: #9ca3af; text-align: center;">${i + 1}</div>
              </td>`
    )
    .join("");

  const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <div style="background-color: #1A1A2E; padding: 32px 40px; text-align: center;">
          <h1 style="margin: 0; color: #f87356; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Triply</h1>
          <p style="margin: 4px 0 0; color: #94a3b8; font-size: 13px;">Your Trip Simplified</p>
        </div>
        <div style="padding: 40px;">
          <p style="font-size: 15px; color: #374151; line-height: 1.6; margin: 0 0 12px;">${escapeHtml(greeting)}</p>
          <p style="font-size: 15px; color: #374151; line-height: 1.6; margin: 0 0 24px;">${escapeHtml(ask)}</p>
          <table role="presentation" style="margin: 0 auto 24px; border-collapse: collapse;">
            <tr>${stars}
            </tr>
          </table>
          <p style="font-size: 14px; color: #6b7280; line-height: 1.6; margin: 0 0 28px; text-align: center;">${escapeHtml(why)}</p>
          <div style="text-align: center; margin: 0 0 8px;">
            <a href="${escapeHtml(againUrl)}" style="background-color: #ffffff; color: #f87356; border: 2px solid #f87356; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: bold; font-size: 15px; display: inline-block;">
              ${escapeHtml(againLabel)}
            </a>
          </div>
        </div>
        <div style="background-color: #f9fafb; padding: 24px 40px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6;">
            Questions? Reply to this email or visit our <a href="${escapeHtml(appBase())}/help" style="color: #f87356; text-decoration: none;">Help Center</a>.<br>
            ${escapeHtml(footer)}<br>
            <a href="https://www.triplypro.com" style="color: #f87356; text-decoration: none;">triplypro.com</a>
          </p>
        </div>
      </div>
    `;

  return { subject, html, text };
}

/** One key per booking + kind. The payload is byte-stable across retries:
 *  the token's expiry derives from the check-out date, not from "now". */
export const reviewIdempotencyKey = (bookingId: string, kind: ReviewCandidate["kind"]) =>
  `post-trip-review/${bookingId}/${kind}`;

export async function sendReviewEmail(c: ReviewCandidate): Promise<void> {
  const { subject, html, text } = buildReviewEmail(c);
  // resend never throws for an API-level failure — it resolves { error }. The
  // race bounds a hung send so the row is parked, not left `claimed`.
  const send = resend.emails.send(
    { from: FROM_EMAIL, to: [c.email], replyTo: REVIEW_REPLY_TO, subject, html, text },
    { idempotencyKey: reviewIdempotencyKey(c.bookingId, c.kind) }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ReviewSendError(
            `Resend did not answer within ${RESEND_SEND_TIMEOUT_MS} ms for review ${c.kind} ${c.bookingId}`,
            undefined
          )
        ),
      RESEND_SEND_TIMEOUT_MS
    );
  });
  let error: { message: string; statusCode?: unknown; name?: unknown } | null;
  try {
    ({ error } = await Promise.race([send, timeout]));
  } finally {
    clearTimeout(timer);
  }
  if (error) {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : undefined;
    const resendName = typeof error.name === "string" ? error.name : undefined;
    throw new ReviewSendError(
      `Resend error for review ${c.kind} ${c.bookingId}: ${error.message}`,
      statusCode,
      resendName
    );
  }
}
