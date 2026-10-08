import { format } from "date-fns";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import type { RecoveryCandidate } from "./select";

/**
 * The one "you didn't finish booking" email. Short, plain, honest: what they
 * picked, what it cost at checkout, one button back to the same checkout. No
 * discount, no countdown, no "only N left" — nothing we cannot stand behind.
 *
 * It is COMMERCIAL mail (no transaction completed), so the footer carries the
 * business postal address (CAN-SPAM) and says plainly why the recipient got
 * it; "one-time" was removed because the per-address cap is 7 days, not ever.
 */

export interface RecoveryLotInfo {
  /** ResLab location name; null when the lookup failed. */
  name: string | null;
  /** Resolved airport code; null when it could not be resolved. */
  airportCode: string | null;
}

/** Deadline for one Resend call. The cron must settle inside its 60 s. */
export const RESEND_SEND_TIMEOUT_MS = 10_000;

/**
 * Resend's per-call failure with the HTTP status kept, so the cron can tell a
 * permanent per-recipient rejection (4xx) from a transient one (429 / 5xx / no
 * status). Same shape as the waitlist cron's.
 */
export class RecoverySendError extends Error {
  readonly statusCode: number | undefined;
  constructor(message: string, statusCode: number | undefined) {
    super(message);
    this.name = "RecoverySendError";
    this.statusCode = statusCode;
  }
}

export function isTransientSendFailure(error: unknown): boolean {
  if (error instanceof RecoverySendError) {
    const c = error.statusCode;
    return c === undefined || c === 429 || c >= 500;
  }
  return true;
}

/** Resend rejected OUR credentials or domain (401/403) — nothing to do with
 *  this recipient, and every later send in the run would fail the same way. */
export function isSendConfigFailure(error: unknown): boolean {
  return error instanceof RecoverySendError && (error.statusCode === 401 || error.statusCode === 403);
}

/**
 * Resend's idempotency answer: the key was already used with a different
 * payload (`invalid_idempotent_request`), or the first request is still in
 * flight (`concurrent_idempotent_requests`). Either way an email under this
 * key may already be out — it must be recorded as sent, never retried and
 * never marked failed.
 */
export function isIdempotencyConflict(error: unknown): boolean {
  return error instanceof RecoverySendError && error.statusCode === 409;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Display-only formatting of a literal "YYYY-MM-DD" (parsed as a local
 *  midnight, the same way waitlist-notify does, so the day never shifts). */
function displayDate(isoDate: string): string {
  return format(new Date(`${isoDate}T00:00:00`), "EEE, MMM d");
}

/**
 * The exact checkout URL the lot page and search slider build
 * (booking-widget.tsx / product-detail-slider.tsx): same lot, same dates, same
 * times. The checkout page re-prices on load, so the customer always sees the
 * live price before paying.
 */
export function buildResumeUrl(c: RecoveryCandidate): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com").replace(/\/$/, "");
  const params = new URLSearchParams({
    lot: c.lotId,
    checkin: c.checkin,
    checkout: c.checkout,
    checkinTime: c.checkinTime,
    checkoutTime: c.checkoutTime,
    utm_source: "triply",
    utm_medium: "email",
    utm_campaign: "checkout_recovery",
  });
  return `${base}/checkout?${params.toString()}`;
}

export function buildRecoveryEmail(
  c: RecoveryCandidate,
  lot: RecoveryLotInfo,
  unsubscribeUrl: string,
  postalAddress: string
): { subject: string; html: string; text: string } {
  const resumeUrl = buildResumeUrl(c);
  const amount = `$${(c.amountCents / 100).toFixed(2)}`;
  const where = lot.name
    ? `${lot.name}${lot.airportCode ? ` (${lot.airportCode})` : ""}`
    : lot.airportCode
      ? `${lot.airportCode} airport parking`
      : "the parking you picked";
  const dates = `${displayDate(c.checkin)}, ${c.checkinTime} to ${displayDate(c.checkout)}, ${c.checkoutTime}`;
  const subject = lot.airportCode
    ? `Your ${lot.airportCode} parking booking isn't finished`
    : "Your parking booking isn't finished";
  // The PaymentIntent amount is what the card would have been charged, so it
  // already includes any protection plan or promo chosen at the time; the
  // resume link carries neither, and the checkout page re-prices live.
  const amountLabel = "Due at booking when you left (incl. any protection plan or promo you'd chosen)";
  const why = "You're getting this because you started a booking at triplypro.com with this address.";

  const text = [
    "You started booking parking on Triply but didn't finish, so nothing is reserved and you have not been charged.",
    "",
    `Lot: ${where}`,
    `Dates: ${dates}`,
    `${amountLabel}: ${amount}`,
    "",
    `Finish your booking: ${resumeUrl}`,
    "",
    "Prices and availability can change. You'll see the current price before you pay.",
    "",
    why,
    `Triply · ${postalAddress}`,
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <div style="background-color: #1A1A2E; padding: 32px 40px; text-align: center;">
          <h1 style="margin: 0; color: #f87356; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Triply</h1>
        </div>
        <div style="padding: 40px;">
          <h2 style="margin: 0 0 16px; color: #111827; font-size: 20px; font-weight: 700;">Your booking isn't finished</h2>
          <p style="font-size: 15px; color: #374151; line-height: 1.6; margin: 0 0 20px;">
            You started booking parking but didn't finish, so nothing is reserved and you have not been charged.
          </p>
          <table style="width: 100%; font-size: 15px; color: #374151; border-collapse: collapse;">
            <tr><td style="padding: 6px 0; color: #6b7280; width: 40%;">Lot</td><td style="padding: 6px 0;">${escapeHtml(where)}</td></tr>
            <tr><td style="padding: 6px 0; color: #6b7280;">Dates</td><td style="padding: 6px 0;">${escapeHtml(dates)}</td></tr>
            <tr><td style="padding: 6px 0; color: #6b7280;">${escapeHtml(amountLabel)}</td><td style="padding: 6px 0;">${amount}</td></tr>
          </table>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${escapeHtml(resumeUrl)}" style="background-color: #f87356; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 16px; display: inline-block;">
              Finish my booking
            </a>
          </div>
          <p style="font-size: 13px; color: #6b7280; line-height: 1.6; margin: 0;">
            Prices and availability can change. You'll see the current price before you pay.
          </p>
        </div>
        <div style="background-color: #f9fafb; padding: 24px 40px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="margin: 0; color: #9ca3af; font-size: 12px;">
            ${escapeHtml(why)}<br>
            Triply · ${escapeHtml(postalAddress)}<br>
            <a href="https://www.triplypro.com" style="color: #f87356; text-decoration: none;">triplypro.com</a><br>
            <a href="${escapeHtml(unsubscribeUrl)}" style="color: #9ca3af; text-decoration: underline;">Unsubscribe</a>
          </p>
        </div>
      </div>
    `;

  return { subject, html, text };
}

/** Resend's Idempotency-Key for one abandoned checkout: keyed on the
 *  PaymentIntent (never the ledger row id, which changes when a claim is
 *  released and retried), so a lost response + retry cannot send twice. The
 *  payload must be byte-stable across retries for the replay to match — so
 *  the unsubscribe link is keyed on the PaymentIntent too, and the lot name
 *  comes from the shared location snapshot. */
export const recoveryIdempotencyKey = (paymentIntentId: string) => `checkout-recovery/${paymentIntentId}`;

export async function sendRecoveryEmail(
  c: RecoveryCandidate,
  lot: RecoveryLotInfo,
  unsubscribeUrl: string,
  postalAddress: string
): Promise<void> {
  const { subject, html, text } = buildRecoveryEmail(c, lot, unsubscribeUrl, postalAddress);
  // resend never throws for an API-level failure — it resolves { error }. The
  // race is the deadline: a hung send must surface as a (transient) failure,
  // not run the cron into its function timeout with the row left `claimed`.
  const send = resend.emails.send(
    {
      from: FROM_EMAIL,
      to: [c.email],
      subject,
      html,
      text,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    },
    { idempotencyKey: recoveryIdempotencyKey(c.paymentIntentId) }
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RecoverySendError(
            `Resend did not answer within ${RESEND_SEND_TIMEOUT_MS} ms for ${c.paymentIntentId}`,
            undefined
          )
        ),
      RESEND_SEND_TIMEOUT_MS
    );
  });
  let error: { message: string; statusCode?: unknown } | null;
  try {
    ({ error } = await Promise.race([send, timeout]));
  } finally {
    clearTimeout(timer);
  }
  if (error) {
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : undefined;
    throw new RecoverySendError(
      `Resend error for checkout recovery ${c.paymentIntentId}: ${error.message}`,
      statusCode
    );
  }
}
