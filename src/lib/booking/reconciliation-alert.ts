/**
 * The moment a payment lands in reconciliation — money held or taken, booking
 * state unknown — tell the team NOW and tell the customer once.
 *
 * Until this module the only signals were a Sentry event and the next day's
 * reconciliation email: a Friday-evening failure was looked at on Monday while
 * the customer sat with a hold on their card and no booking (launch-QA finding
 * #8, Oct 28 2026; the Fox Parking orphan, Oct 22).
 *
 * Called exactly when the row's status TRANSITIONS to `needs_reconciliation`
 * or `capture_ambiguous` (markTerminal's `.in("status", …)` guard, the sweep's
 * `.select()`), so it fires at most once per PaymentIntent per status.
 *
 * Rules:
 *  - Never throws, never writes a row. Every step is bounded and the whole
 *    alert is capped (ALERT_BUDGET_MS); it is AWAITED by the caller, never
 *    fire-and-forget, because Vercel freezes the function after the response.
 *  - A step that fails is one `capturePaymentError` with the PaymentIntent id
 *    and the step name; the remaining steps still run. A row that cannot be
 *    read still produces the team alert with the PaymentIntent id alone.
 *  - Team alert: Discord (DISCORD_BOOKING_ALERTS_WEBHOOK_URL, "@here" for live
 *    rows, "[TEST]" and no ping for staging rows — the direct-lot convention),
 *    emailed to PAYMENT_ALERT_EMAILS when Discord is unset or fails.
 *  - Customer email: one, to the staged customer email. What is on the card
 *    comes from Stripe (moneyOnCard), never from the row. No deadline is
 *    promised — "as soon as it's resolved", the same words as the page.
 *  - Dates shown to the customer are the row's LITERAL airport-local strings,
 *    reformatted by string operations only. No Date math.
 */

import { createAdminClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { PAYMENT_ALERT_EMAILS } from "@/config/admin";
import { escapeHtml } from "@/lib/validation/schemas";
import { isDiscordWebhookUrl, postToDiscord } from "@/lib/digest/discord";
import type { Embed } from "@/lib/digest/render";
import { capturePaymentError } from "@/lib/sentry";
import { formatMoneyOnCard, moneyOnCard, type MoneyOnCard } from "@/lib/stripe/money-on-card";

export type ReconciliationStatus = "needs_reconciliation" | "capture_ambiguous";

export interface ReconciliationAlertInput {
  stripePaymentIntentId: string;
  status: ReconciliationStatus;
  /** The engine's reason (`last_error`). Free text; may contain supplier HTML. */
  reason: string;
  /** Which caller hit it. */
  source: string;
}

export interface ReconciliationAlertResult {
  team: "discord" | "email" | "none";
  customer: "sent" | "no_email" | "failed";
}

const ADMIN_BOOKINGS_URL = "https://www.triplypro.com/admin/bookings";
const DISCORD_USERNAME = "Triply Bookings";
const RED = 0xdc2626;
const AMBER = 0xd97706;

/** Whole alert; the caller is a 60 s route that has already spent most of it. */
const ALERT_BUDGET_MS = 12_000;
const ROW_READ_MS = 3_000;
const DISCORD_MS = 4_000;
const EMAIL_MS = 4_000;

interface AlertRow {
  customer: { firstName?: string; lastName?: string; email?: string } | null;
  location_name: string | null;
  airport_code: string | null;
  from_date: string;
  to_date: string;
  grand_total: string | number | null;
  livemode: boolean | null;
  inventory_source: string | null;
  reslab_reservation_number: string | null;
}

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

function report(piId: string, step: string, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  capturePaymentError(new Error(`reconciliation alert: ${step} failed — ${err.message}`), {
    stripePaymentIntentId: piId,
    fingerprint: ["reconciliation-alert", step],
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

/** A supplier error can be a whole HTML page; keep the first readable line. */
function reasonSummary(reason: string, max = 300): string {
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
  return "The amount on your card is not final until your reservation is confirmed. If we can't confirm it, it is released or refunded in full.";
}

function moneyLine(money: MoneyOnCard): string {
  const figure = formatMoneyOnCard(money);
  if (money.kind === "hold" && figure) return `${figure} HELD (requires_capture)`;
  if (money.kind === "captured" && figure) return `${figure} CAPTURED`;
  return "unknown — read the PaymentIntent in Stripe";
}

async function readRow(piId: string): Promise<AlertRow | null> {
  const supabase = await createAdminClient();
  const { data, error } = await bounded(
    "row read",
    ROW_READ_MS,
    Promise.resolve(
      supabase
        .from("pending_bookings")
        .select(
          "customer, location_name, airport_code, from_date, to_date, grand_total, livemode, inventory_source, reslab_reservation_number"
        )
        .eq("stripe_payment_intent_id", piId)
        .maybeSingle()
    )
  );
  if (error) throw new Error(error.message);
  return (data as AlertRow | null) ?? null;
}

function teamEmbed(input: ReconciliationAlertInput, row: AlertRow | null, money: MoneyOnCard): Embed {
  const live = row?.livemode ?? true;
  const prefix = live ? "" : "[TEST] ";
  const where = row?.location_name
    ? `${plain(row.location_name)}${row.airport_code ? ` (${plain(row.airport_code, 10)})` : ""}`
    : "unknown lot (row not readable)";
  const name = row?.customer ? plain(`${row.customer.firstName ?? ""} ${row.customer.lastName ?? ""}`.trim(), 120) : "";
  const fields: Embed["fields"] = [
    { name: "Money", value: plain(moneyLine(money), 120) },
    { name: "Lot", value: where },
    { name: "Dates", value: row ? `${plain(row.from_date, 40)} → ${plain(row.to_date, 40)}` : "—" },
    { name: "Customer", value: name || "—", inline: true },
    { name: "Reservation", value: row?.reslab_reservation_number ? plain(row.reslab_reservation_number, 40) : "none recorded", inline: true },
    { name: "Why", value: plain(reasonSummary(input.reason), 1000) },
    { name: "Found by", value: plain(input.source, 40), inline: true },
  ];
  return {
    title: `${prefix}Booking needs a human — ${plain(input.stripePaymentIntentId, 60)}`,
    description:
      `${input.status === "capture_ambiguous" ? "Capture result unknown" : "Money held or taken, booking state unknown"}. ` +
      `Resolve in Stripe + the supplier, then mark the row (runbook § 32). [Admin](${ADMIN_BOOKINGS_URL})`,
    color: live ? RED : AMBER,
    fields,
    footer: { text: `${prefix}Triply reconciliation alert · ${live ? "production (live Stripe)" : "test mode (staging)"} · customer emailed once` },
  };
}

async function postTeamDiscord(input: ReconciliationAlertInput, row: AlertRow | null, money: MoneyOnCard): Promise<boolean> {
  const webhookUrl = (process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL ?? "").trim();
  if (!webhookUrl) return false;
  if (!isDiscordWebhookUrl(webhookUrl)) {
    // Never fetched: a malformed value could carry the token into a report.
    report(input.stripePaymentIntentId, "discord (not a webhook URL)", new Error("DISCORD_BOOKING_ALERTS_WEBHOOK_URL is not a Discord webhook URL"));
    return false;
  }
  const token = webhookUrl.split("?")[0].split("/").filter(Boolean).pop() ?? webhookUrl;
  const redact = (text: string) => text.split(webhookUrl).join("<webhook>").split(token).join("<token>");
  const live = row?.livemode ?? true;
  try {
    const res = await postToDiscord(webhookUrl, teamEmbed(input, row, money), {
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

async function emailTeam(input: ReconciliationAlertInput, row: AlertRow | null, money: MoneyOnCard): Promise<boolean> {
  const live = row?.livemode ?? true;
  const prefix = live ? "" : "[TEST] ";
  const figure = formatMoneyOnCard(money);
  const rows: Array<[string, string]> = [
    ["PaymentIntent", input.stripePaymentIntentId],
    ["Money", moneyLine(money)],
    ["Status", input.status],
    ["Lot", row?.location_name ? `${row.location_name}${row.airport_code ? ` (${row.airport_code})` : ""}` : "unknown (row not readable)"],
    ["Dates", row ? `${row.from_date} → ${row.to_date}` : "—"],
    ["Customer", row?.customer ? `${row.customer.firstName ?? ""} ${row.customer.lastName ?? ""} <${row.customer.email ?? "no email"}>`.trim() : "—"],
    ["Reservation", row?.reslab_reservation_number ?? "none recorded"],
    ["Found by", input.source],
    ["Why", reasonSummary(input.reason, 600)],
  ];
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
      <h2 style="color:#dc2626;">${prefix}Booking needs a human${figure ? ` — ${escapeHtml(figure)}` : ""}</h2>
      <p style="font-size:14px;">Money is held or taken and the booking state is unknown. Resolve it in Stripe and with the supplier, then mark the row (runbook § 32). The customer has been emailed once and told not to book again.</p>
      <table style="border-collapse:collapse;width:100%;font-size:13px;">
        ${rows.map(([k, v]) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280;white-space:nowrap;">${escapeHtml(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(v)}</td></tr>`).join("")}
      </table>
      <p style="font-size:13px;"><a href="${ADMIN_BOOKINGS_URL}">Open the admin</a></p>
    </div>`;
  try {
    const { error } = await bounded(
      "team email",
      EMAIL_MS,
      resend.emails.send({
        from: FROM_EMAIL,
        to: PAYMENT_ALERT_EMAILS,
        subject: `🚨 ${prefix}Booking needs a human${figure ? ` — ${figure}` : ""} — ${input.stripePaymentIntentId}`,
        html,
      })
    );
    if (error) throw new Error(error.message);
    return true;
  } catch (error) {
    report(input.stripePaymentIntentId, "team email", error);
    return false;
  }
}

async function emailCustomer(input: ReconciliationAlertInput, row: AlertRow | null, money: MoneyOnCard): Promise<"sent" | "no_email" | "failed"> {
  const to = row?.customer?.email?.trim();
  if (!to || !to.includes("@")) return "no_email";
  const first = row?.customer?.firstName?.trim();
  const lot = row?.location_name?.trim();
  const when = row ? `${formatLiteralDateTime(row.from_date)} – ${formatLiteralDateTime(row.to_date)}` : null;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1e293b;line-height:1.5;">
      <h2 style="font-family:Poppins,Arial,sans-serif;color:#1A1A2E;">We're finishing your booking</h2>
      <p>${first ? `Hi ${escapeHtml(first)},` : "Hi,"}</p>
      <p>We couldn't get an instant confirmation from the parking facility for your reservation${lot ? ` at <strong>${escapeHtml(lot)}</strong>` : ""}${when ? ` (${escapeHtml(when)})` : ""}. Our team has been alerted and is confirming it now. <strong>We'll email you as soon as it's resolved.</strong></p>
      <p>${escapeHtml(moneySentence(money))}</p>
      <p style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px;"><strong>Please don't book again</strong> — a second booking would place a second charge on your card.</p>
      <p style="font-size:14px;color:#64748b;">Your reference: <code>${escapeHtml(input.stripePaymentIntentId)}</code><br>Quote it if you contact us: <a href="mailto:support@triplypro.com">support@triplypro.com</a></p>
      <p style="font-size:12px;color:#94a3b8;">Triply · triplypro.com</p>
    </div>`;
  try {
    const { error } = await bounded(
      "customer email",
      EMAIL_MS,
      resend.emails.send({
        from: FROM_EMAIL,
        to,
        subject: "We're finishing your Triply booking — no action needed",
        html,
      })
    );
    if (error) throw new Error(error.message);
    return "sent";
  } catch (error) {
    report(input.stripePaymentIntentId, "customer email", error);
    return "failed";
  }
}

async function run(input: ReconciliationAlertInput): Promise<ReconciliationAlertResult> {
  const piId = input.stripePaymentIntentId;
  let row: AlertRow | null = null;
  try {
    row = await readRow(piId);
  } catch (error) {
    report(piId, "row read", error);
  }
  const money = await moneyOnCard(piId);

  const discord = await postTeamDiscord(input, row, money);
  const team: ReconciliationAlertResult["team"] = discord ? "discord" : (await emailTeam(input, row, money)) ? "email" : "none";
  if (team === "none") {
    report(piId, "team alert", new Error("neither Discord nor email delivered — only Sentry and the daily reconciliation email know"));
  }
  const customer = await emailCustomer(input, row, money);
  return { team, customer };
}

/** Never throws. Awaited by the caller; capped at ALERT_BUDGET_MS. */
export async function alertNeedsReconciliation(input: ReconciliationAlertInput): Promise<ReconciliationAlertResult> {
  try {
    return await bounded("whole alert", ALERT_BUDGET_MS, run(input));
  } catch (error) {
    report(input.stripePaymentIntentId, "whole alert", error);
    return { team: "none", customer: "failed" };
  }
}
