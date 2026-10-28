/**
 * The moment a payment lands in reconciliation — money held or taken, booking
 * state unknown — tell the team NOW and tell the customer once.
 *
 * Until this module the only signals were a Sentry event and the next day's
 * reconciliation email: a Friday-evening failure was looked at on Monday while
 * the customer sat with a hold on their card and no booking (launch-QA finding
 * #8, Oct 28 2026; the Fox Parking orphan, Oct 22).
 *
 * Fired when the row's status TRANSITIONS to `needs_reconciliation` or
 * `capture_ambiguous` (markTerminal's `.in("status", …)` guard, the sweep's
 * `.select()`), and from the engine outcomes that carry money but have no row
 * to transition. Once per PaymentIntent: the transition dedupes the first
 * kind; a `reconciliation_alerted_at` marker on the PaymentIntent's metadata
 * dedupes the second (every finishing-page poll and both webhook events
 * re-run the engine), and the two emails carry Resend idempotency keys.
 *
 * Rules:
 *  - `scheduleReconciliationAlert` runs the alert AFTER the response with
 *    Next's `after()` (Vercel `waitUntil`): it never adds to a 60 s route's
 *    budget, never delays the engine's own Sentry events or the customer's
 *    answer, and is not frozen with the function. Outside a request scope
 *    (a script, a test) `after` throws and the alert runs inline. Known limit:
 *    `waitUntil` work is still bounded by the route's `maxDuration`; an alert
 *    scheduled at ~50 s of a 60 s route can be cut off — the engine's own
 *    Sentry event (fired before the schedule) and the daily reconciliation
 *    email are the backstop.
 *  - Never throws, never writes a row. Every step is bounded; the two
 *    deliveries (team, customer) run in parallel; the whole alert is capped.
 *  - A step that fails is one `capturePaymentError` with the PaymentIntent id
 *    and the step name; the other steps still run.
 *  - The row comes from the caller — the UPDATE's own RETURNING — so there is
 *    no second read and `livemode` is known ("[TEST]" and no ping for staging
 *    rows; "@here" only for live rows). No row (engine outcomes with nothing
 *    staged) → the team alert still goes, with the PaymentIntent id, and the
 *    customer address falls back to the PaymentIntent's metadata.
 *  - The team alert says whether the customer is being emailed, and to which
 *    address class — never a fixed "customer emailed" claim.
 *  - What is on the card comes from Stripe (readCard), never from the row; a
 *    refunded payment is said to be refunded and NOT told "don't book again".
 *    No deadline is promised — "as soon as it's resolved", the same words as
 *    the finishing page.
 *  - Dates shown to the customer are the row's LITERAL airport-local strings,
 *    reformatted by string operations only. No Date math.
 */

import { after } from "next/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { PAYMENT_ALERT_EMAILS } from "@/config/admin";
import { escapeHtml } from "@/lib/validation/schemas";
import { isDiscordWebhookUrl, postToDiscord } from "@/lib/digest/discord";
import type { Embed } from "@/lib/digest/render";
import { capturePaymentError } from "@/lib/sentry";
import { stripeKeyIsLive } from "@/lib/cancellation/source-guard";
import { formatMoneyOnCard, markAlerted, readCard, type CardState, type MoneyOnCard } from "@/lib/stripe/money-on-card";

export type ReconciliationStatus = "needs_reconciliation" | "capture_ambiguous";

/** The columns the caller's UPDATE … RETURNING (or its own read) supplies. */
export const RECONCILIATION_ALERT_COLUMNS =
  "stripe_payment_intent_id, livemode, customer, location_name, airport_code, from_date, to_date, reslab_reservation_number, inventory_source";

export interface ReconciliationAlertRow {
  livemode: boolean | null;
  customer: { firstName?: string; lastName?: string; email?: string } | null;
  location_name: string | null;
  airport_code: string | null;
  from_date: string;
  to_date: string;
  reslab_reservation_number: string | null;
  inventory_source: string | null;
}

export interface ReconciliationAlertInput {
  stripePaymentIntentId: string;
  status: ReconciliationStatus;
  /** The engine's reason (`last_error`). Free text; may contain supplier HTML. */
  reason: string;
  /** Which caller hit it: "engine", "sweep", or the engine's `source`. */
  source: string;
  /** The row as the transition returned it; null when nothing was staged. */
  row: ReconciliationAlertRow | null;
}

export interface ReconciliationAlertResult {
  team: "discord" | "email" | "none";
  customer: "sent" | "no_email" | "failed";
  /** This payment was alerted before (marker on the PaymentIntent); nothing sent. */
  deduped: boolean;
}

const DISCORD_USERNAME = "Triply Bookings";
const RED = 0xdc2626;
const AMBER = 0xd97706;

/** Per-step bounds; the deliveries run in parallel, so the worst case is
 *  card read + the longer of (Discord then email) and (customer email) + the marker. */
const CARD_MS = 4_000;
const DISCORD_MS = 4_000;
const EMAIL_MS = 4_000;
const ALERT_BUDGET_MS = 18_000;

class StepTimeout extends Error {
  constructor(step: string, ms: number) {
    super(`${step} exceeded ${ms} ms`);
    this.name = "StepTimeout";
  }
}

function bounded<T>(step: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(step, ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function report(piId: string, step: string, error: unknown, perPayment = false): void {
  const err = error instanceof Error ? error : new Error(String(error));
  capturePaymentError(new Error(`reconciliation alert: ${step} failed — ${err.message}`), {
    stripePaymentIntentId: piId,
    // The "nothing delivered" report is the last live signal: one issue PER
    // payment, so the second incident is not folded into the first.
    fingerprint: perPayment ? ["reconciliation-alert", step, piId] : ["reconciliation-alert", step],
  });
}

/**
 * Free text as plain Discord text: markdown escaped so a name or a supplier
 * error can't become a link or a heading, whitespace collapsed, clipped.
 */
function plain(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const clipped = oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  return clipped.replace(/([\\`*_~|>[\]()])/g, "\\$1").replace(/^([#-])/, "\\$1");
}

/** A supplier error can be a whole HTML page; keep the first readable line.
 *  ≤ 400 chars → ≤ 800 after Discord escaping, under the 1024 field limit. */
function reasonSummary(reason: string, max = 400): string {
  const stripped = reason.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped || "(no reason recorded)";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2026-11-11 07:00:00" → "Nov 11, 2026 at 7:00 AM". String operations only —
 * the value is the customer's literal airport-local wall-clock time and must
 * never pass through Date math. Anything that does not match is shown as-is.
 */
export function formatLiteralDateTime(literal: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(literal.trim());
  if (!m) return literal;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return literal;
  const day = Number(m[3]);
  const hour24 = Number(m[4]);
  const minute = m[5];
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${month} ${day}, ${m[1]} at ${hour12}:${minute} ${suffix}`;
}

function moneySentence(money: MoneyOnCard): string {
  const figure = formatMoneyOnCard(money);
  if (money.kind === "hold" && figure) {
    return `The ${figure} on your card is a hold, not a final charge. It is only taken once your reservation is confirmed; otherwise it is released.`;
  }
  if (money.kind === "captured" && figure) {
    return `Your card was charged ${figure}. If we can't confirm this reservation, that amount is refunded in full.`;
  }
  if (money.kind === "refunded" && figure) {
    return `The ${figure} charged to your card has already been refunded in full; it can take 5–10 business days to show on your statement.`;
  }
  return "The amount on your card is not final until your reservation is confirmed. If we can't confirm it, it is released or refunded in full.";
}

function moneyLine(money: MoneyOnCard): string {
  const figure = formatMoneyOnCard(money);
  if (money.kind === "hold" && figure) return `${figure} HELD (requires_capture)`;
  if (money.kind === "captured" && figure) return `${figure} CAPTURED`;
  if (money.kind === "refunded" && figure) return `${figure} REFUNDED in full`;
  return "unknown — read the PaymentIntent in Stripe";
}

function stripeUrl(piId: string, live: boolean): string {
  return `https://dashboard.stripe.com/${live ? "" : "test/"}payments/${encodeURIComponent(piId)}`;
}

/** The row says; else Stripe says; else the deployment's key decides. */
function isLive(row: ReconciliationAlertRow | null, card: CardState): boolean {
  if (row && typeof row.livemode === "boolean") return row.livemode;
  if (typeof card.livemode === "boolean") return card.livemode;
  return stripeKeyIsLive();
}

function validEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.includes("@") ? v : null;
}

/** Where the customer email goes: the staged row first, then the PaymentIntent's metadata. */
function customerRecipient(row: ReconciliationAlertRow | null, card: CardState): string | null {
  return validEmail(row?.customer?.email) ?? card.customerEmail;
}

/** What the team is told about the customer email — never a fixed claim. */
function customerLine(recipient: string | null, withAddress: boolean): string {
  if (!recipient) return "customer NOT emailed — no address on file; contact them from Stripe";
  return withAddress
    ? `customer being emailed at ${recipient} (a failed send is a Sentry 'customer email' event)`
    : "customer being emailed at the address on file (a failed send is a Sentry 'customer email' event)";
}

function teamEmbed(input: ReconciliationAlertInput, card: CardState, recipient: string | null): Embed {
  const { row } = input;
  const live = isLive(row, card);
  const prefix = live ? "" : "[TEST] ";
  const where = row?.location_name
    ? `${plain(row.location_name)}${row.airport_code ? ` (${plain(row.airport_code, 10)})` : ""}`
    : "nothing staged for this payment";
  const name = row?.customer ? plain(`${row.customer.firstName ?? ""} ${row.customer.lastName ?? ""}`.trim(), 120) : "";
  const fields: Embed["fields"] = [
    { name: "Money", value: plain(moneyLine(card.money), 120) },
    { name: "Lot", value: where },
    { name: "Dates", value: row ? `${plain(row.from_date, 40)} → ${plain(row.to_date, 40)}` : "—" },
    { name: "Customer", value: name || "—", inline: true },
    { name: "Reservation", value: row?.reslab_reservation_number ? plain(row.reslab_reservation_number, 40) : "none recorded", inline: true },
    { name: "Why", value: plain(reasonSummary(input.reason), 1000) },
    { name: "Found by", value: plain(input.source, 40), inline: true },
    { name: "Customer email", value: plain(customerLine(recipient, false), 200) },
  ];
  return {
    title: `${prefix}Booking needs a human — ${plain(input.stripePaymentIntentId, 60)}`,
    description:
      `${input.status === "capture_ambiguous" ? "Capture result unknown" : "Money held or taken, booking state unknown"}. ` +
      `[Open in Stripe](${stripeUrl(input.stripePaymentIntentId, live)}) · resolve per runbook § 32, then mark the row.`,
    color: live ? RED : AMBER,
    fields,
    footer: { text: `${prefix}Triply reconciliation alert · ${live ? "production (live Stripe)" : "test mode (staging)"}` },
  };
}

async function postTeamDiscord(input: ReconciliationAlertInput, card: CardState, recipient: string | null): Promise<boolean> {
  const webhookUrl = (process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL ?? "").trim();
  if (!webhookUrl) return false;
  if (!isDiscordWebhookUrl(webhookUrl)) {
    // Never fetched: a malformed value could carry the token into a report.
    report(input.stripePaymentIntentId, "discord (not a webhook URL)", new Error("DISCORD_BOOKING_ALERTS_WEBHOOK_URL is not a Discord webhook URL"));
    return false;
  }
  const token = webhookUrl.split("?")[0].split("/").filter(Boolean).pop() ?? webhookUrl;
  const redact = (text: string) => text.split(webhookUrl).join("<webhook>").split(token).join("<token>");
  const live = isLive(input.row, card);
  try {
    const res = await postToDiscord(webhookUrl, teamEmbed(input, card, recipient), {
      remainingBudgetMs: 0,
      username: DISCORD_USERNAME,
      timeoutMs: DISCORD_MS,
      requireMessageId: true,
      ...(live ? { content: "@here", allowedMentions: { parse: ["everyone"] } } : {}),
    });
    if (res.kind === "posted") return true;
    report(input.stripePaymentIntentId, "discord", new Error(`${res.status ?? "no response"}: ${redact(res.body)}`));
    return false;
  } catch (error) {
    report(input.stripePaymentIntentId, "discord", new Error(redact(error instanceof Error ? error.message : String(error))));
    return false;
  }
}

async function emailTeam(input: ReconciliationAlertInput, card: CardState, recipient: string | null): Promise<boolean> {
  const { row } = input;
  const live = isLive(row, card);
  const prefix = live ? "" : "[TEST] ";
  const figure = formatMoneyOnCard(card.money);
  const rows: Array<[string, string]> = [
    ["PaymentIntent", input.stripePaymentIntentId],
    ["Money", moneyLine(card.money)],
    ["Status", input.status],
    ["Lot", row?.location_name ? `${row.location_name}${row.airport_code ? ` (${row.airport_code})` : ""}` : "nothing staged for this payment"],
    ["Dates", row ? `${row.from_date} → ${row.to_date}` : "—"],
    ["Customer", row?.customer ? `${row.customer.firstName ?? ""} ${row.customer.lastName ?? ""}`.trim() || "—" : "—"],
    ["Customer email", customerLine(recipient, true)],
    ["Reservation", row?.reslab_reservation_number ?? "none recorded"],
    ["Found by", input.source],
    ["Why", reasonSummary(input.reason, 600)],
  ];
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
      <h2 style="color:#dc2626;">${prefix}Booking needs a human${figure ? ` — ${escapeHtml(figure)}` : ""}</h2>
      <p style="font-size:14px;">Money is held or taken and the booking state is unknown. Resolve it in Stripe and with the supplier per runbook § 32, then mark the row.</p>
      <table style="border-collapse:collapse;width:100%;font-size:13px;">
        ${rows.map(([k, v]) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(v)}</td></tr>`).join("")}
      </table>
      <p style="font-size:13px;"><a href="${stripeUrl(input.stripePaymentIntentId, live)}">Open the payment in Stripe</a></p>
    </div>`;
  try {
    const { error } = await bounded(
      "team email",
      EMAIL_MS,
      resend.emails.send(
        {
          from: FROM_EMAIL,
          to: PAYMENT_ALERT_EMAILS,
          subject: `🚨 ${prefix}Booking needs a human${figure ? ` — ${figure}` : ""} — ${input.stripePaymentIntentId}`,
          html,
        },
        { idempotencyKey: `reconciliation/team/${input.stripePaymentIntentId}` }
      )
    );
    if (error) throw new Error(error.message);
    return true;
  } catch (error) {
    report(input.stripePaymentIntentId, "team email", error);
    return false;
  }
}

async function emailCustomer(input: ReconciliationAlertInput, card: CardState, to: string | null): Promise<"sent" | "no_email" | "failed"> {
  if (!to) return "no_email";
  try {
    const { row } = input;
    const money = card.money;
    const first = typeof row?.customer?.firstName === "string" ? row.customer.firstName.trim() : "";
    const lot = typeof row?.location_name === "string" ? row.location_name.trim() : "";
    const when = row ? `${formatLiteralDateTime(row.from_date)} – ${formatLiteralDateTime(row.to_date)}` : null;
    const refunded = money.kind === "refunded";
    // Neutral on purpose: at some sites the supplier DID confirm and our
    // capture failed; at direct lots no supplier is called. "Checking it by
    // hand" is true in every case. A refunded customer has no booking and
    // their money back — they are NOT told to wait.
    const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1e293b;line-height:1.5;">
      <h2 style="font-family:Poppins,Arial,sans-serif;color:#1A1A2E;">${refunded ? "About your Triply booking" : "We're finishing your booking"}</h2>
      <p>${first ? `Hi ${escapeHtml(first)},` : "Hi,"}</p>
      <p>We couldn't finish confirming your booking${lot ? ` at <strong>${escapeHtml(lot)}</strong>` : ""}${when ? ` (${escapeHtml(when)})` : ""} automatically, and our team is checking it by hand. <strong>We'll email you as soon as it's resolved.</strong></p>
      <p>${escapeHtml(moneySentence(money))}</p>
      ${
        refunded
          ? `<p style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;">Your payment has been returned, so there is nothing on your card for this booking. If your trip is soon, you can book again now or reply to this email and we'll help.</p>`
          : `<p style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px;"><strong>Please don't book again</strong> — a second booking would place a second charge on your card.</p>`
      }
      <p style="font-size:14px;color:#64748b;">Your reference: <code>${escapeHtml(input.stripePaymentIntentId)}</code><br>Quote it if you contact us: <a href="mailto:support@triplypro.com">support@triplypro.com</a></p>
      <p style="font-size:12px;color:#94a3b8;">Triply · triplypro.com</p>
    </div>`;
    const { error } = await bounded(
      "customer email",
      EMAIL_MS,
      resend.emails.send(
        {
          from: FROM_EMAIL,
          to,
          subject: refunded ? "About your Triply booking — your payment was returned" : "We're finishing your Triply booking — no action needed",
          html,
        },
        { idempotencyKey: `reconciliation/customer/${input.stripePaymentIntentId}` }
      )
    );
    if (error) throw new Error(error.message);
    return "sent";
  } catch (error) {
    report(input.stripePaymentIntentId, "customer email", error);
    return "failed";
  }
}

async function run(input: ReconciliationAlertInput, progress: ReconciliationAlertResult): Promise<ReconciliationAlertResult> {
  const piId = input.stripePaymentIntentId;
  const card = await bounded("card read", CARD_MS, readCard(piId)).catch((error: unknown): CardState => {
    report(piId, "card read", error);
    return { money: { kind: "unknown" }, customerEmail: null, livemode: null, alreadyAlerted: false };
  });
  if (card.alreadyAlerted) {
    progress.deduped = true;
    progress.customer = "no_email";
    return progress;
  }
  const recipient = customerRecipient(input.row, card);

  const team = (async () => {
    if (await postTeamDiscord(input, card, recipient)) {
      progress.team = "discord";
    } else if (await emailTeam(input, card, recipient)) {
      progress.team = "email";
    } else {
      report(piId, "team alert", new Error("neither Discord nor email delivered — only Sentry and the daily reconciliation email know"), true);
    }
  })();
  const customer = (async () => {
    progress.customer = await emailCustomer(input, card, recipient);
  })();
  await Promise.allSettled([team, customer]);

  // Durable once-only marker, written only after something was delivered.
  if (progress.team !== "none" || progress.customer === "sent") {
    await bounded("mark alerted", CARD_MS, markAlerted(piId)).catch((error: unknown) => report(piId, "mark alerted", error));
  }
  return progress;
}

/** Never throws. Capped at ALERT_BUDGET_MS; the result reflects what finished. */
export async function alertNeedsReconciliation(input: ReconciliationAlertInput): Promise<ReconciliationAlertResult> {
  const progress: ReconciliationAlertResult = { team: "none", customer: "failed", deduped: false };
  try {
    return await bounded("whole alert", ALERT_BUDGET_MS, run(input, progress));
  } catch (error) {
    report(input.stripePaymentIntentId, "whole alert", error, true);
    return progress;
  }
}

/**
 * Run the alert after the response (Next `after()` → Vercel `waitUntil`), so
 * it never adds to a route's time budget, never delays the engine's own
 * Sentry events or the customer's answer, and is not frozen with the
 * function. Outside a request scope (a script, a test) `after` throws and
 * the alert runs inline instead. Never throws.
 */
export async function scheduleReconciliationAlert(input: ReconciliationAlertInput): Promise<void> {
  try {
    after(() => alertNeedsReconciliation(input));
    return;
  } catch {
    // not in a request scope — run it here
  }
  await alertNeedsReconciliation(input);
}
