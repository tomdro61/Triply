/**
 * The moment a payment lands in reconciliation, the team hears NOW and the
 * customer is told once (P1b, launch-QA finding #8, Oct 28 2026).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const postToDiscord = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const readCard = vi.hoisted(() => vi.fn());
const markAlerted = vi.hoisted(() => vi.fn());
const capturePaymentError = vi.hoisted(() => vi.fn());
const after = vi.hoisted(() => vi.fn());

vi.mock("next/server", () => ({ after }));
vi.mock("@/lib/digest/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/digest/discord")>()),
  postToDiscord,
}));
vi.mock("@/lib/resend/client", () => ({ resend: { emails: { send } }, FROM_EMAIL: "Triply <bookings@triplypro.com>" }));
vi.mock("@/lib/stripe/money-on-card", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stripe/money-on-card")>()),
  readCard,
  markAlerted,
}));
vi.mock("@/lib/sentry", () => ({ capturePaymentError }));
vi.mock("@/config/admin", () => ({ PAYMENT_ALERT_EMAILS: ["vin@triplypro.com", "tom@triplypro.com"] }));

import {
  alertNeedsReconciliation,
  scheduleReconciliationAlert,
  formatLiteralDateTime,
  type ReconciliationAlertRow,
} from "../reconciliation-alert";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/AbCdEf_gh-ij";

const row = (over: Partial<ReconciliationAlertRow> = {}): ReconciliationAlertRow => ({
  livemode: true,
  customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  location_name: "PARK AC JFK",
  airport_code: "JFK",
  from_date: "2026-11-11 07:00:00",
  to_date: "2026-11-15 18:00:00",
  reslab_reservation_number: null,
  inventory_source: "reslab",
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({
  stripePaymentIntentId: "pi_abc",
  status: "needs_reconciliation" as const,
  reason: "ResLab ambiguous failure: API request failed: <html><body><h1>Whoops, looks like something went wrong.</h1></body></html>",
  source: "engine",
  row: row(),
  ...over,
});

const card = (over: Record<string, unknown> = {}) => ({
  money: { kind: "hold", amountCents: 2537, currency: "usd" },
  customerEmail: "meta@example.com",
  livemode: true,
  alreadyAlerted: false,
  ...over,
});

const field = (embed: { fields: Array<{ name: string; value: string }> }, name: string) =>
  embed.fields.find((f) => f.name === name)?.value ?? "";
const teamMail = () => send.mock.calls.map((c) => c[0]).find((m) => Array.isArray(m.to));
const customerMail = () => send.mock.calls.map((c) => c[0]).find((m) => !Array.isArray(m.to));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL = WEBHOOK;
  readCard.mockResolvedValue(card());
  markAlerted.mockResolvedValue(true);
  postToDiscord.mockResolvedValue({ kind: "posted", status: 200, retried: false });
  send.mockResolvedValue({ data: { id: "em_1" }, error: null });
});
afterEach(() => {
  delete process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL;
  vi.unstubAllEnvs();
});

describe("alertNeedsReconciliation", () => {
  it("live row: Discord with @here, one customer email (row address) with the hold sentence and the reference; no team email; marker written", async () => {
    const result = await alertNeedsReconciliation(input());
    expect(result).toEqual({ team: "discord", customer: "sent", deduped: false });

    expect(postToDiscord).toHaveBeenCalledTimes(1);
    const [url, embed, opts] = postToDiscord.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(embed.title).toBe("Booking needs a human — pi\\_abc"); // underscore escaped for Discord markdown
    expect(field(embed, "Money")).toMatch(/\$25\.37 HELD/);
    expect(field(embed, "Why")).not.toMatch(/<html>|<h1>/);
    expect(field(embed, "Why")).toMatch(/Whoops/);
    expect(field(embed, "Customer email")).toMatch(/being emailed at the address on file/);
    expect(embed.description).toContain("https://dashboard.stripe.com/payments/pi_abc");
    expect(opts).toMatchObject({ content: "@here", allowedMentions: { parse: ["everyone"] }, requireMessageId: true });
    // No customer email address in Discord (it is in Stripe / the team email).
    expect(JSON.stringify(embed)).not.toContain("example.com");

    expect(send).toHaveBeenCalledTimes(1);
    const [mail, sendOpts] = send.mock.calls[0];
    expect(mail.to).toBe("ada@example.com"); // the row wins over the PaymentIntent's metadata
    expect(sendOpts).toEqual({ idempotencyKey: "reconciliation/customer/pi_abc" });
    expect(mail.subject).toMatch(/finishing your Triply booking/);
    expect(mail.html).toContain("$25.37 on your card is a hold");
    expect(mail.html).toContain("pi_abc");
    expect(mail.html).toContain("Nov 11, 2026 at 7:00 AM");
    expect(mail.html).toContain("Please don't book again");
    expect(mail.html).toContain("checking it by hand");
    expect(mail.html).not.toMatch(/business day|not (been )?charged|parking facility/i);

    expect(markAlerted).toHaveBeenCalledWith("pi_abc");
  });

  it("already alerted (marker on the PaymentIntent) → nothing sent, no Sentry, deduped", async () => {
    readCard.mockResolvedValue(card({ alreadyAlerted: true }));
    const result = await alertNeedsReconciliation(input());
    expect(result).toEqual({ team: "none", customer: "no_email", deduped: true });
    expect(postToDiscord).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(capturePaymentError).not.toHaveBeenCalled();
    expect(markAlerted).not.toHaveBeenCalled();
  });

  it("staging row (livemode false): [TEST] title, no ping, test-mode Stripe link", async () => {
    await alertNeedsReconciliation(input({ row: row({ livemode: false }) }));
    const [, embed, opts] = postToDiscord.mock.calls[0];
    expect(embed.title).toMatch(/^\[TEST\] /);
    expect(embed.description).toContain("https://dashboard.stripe.com/test/payments/pi_abc");
    expect(opts).not.toHaveProperty("content");
  });

  it("no row (nothing staged): Stripe's livemode decides; the customer is emailed at the PaymentIntent's metadata address", async () => {
    readCard.mockResolvedValue(card({ livemode: false }));
    const result = await alertNeedsReconciliation(input({ row: null }));
    expect(result).toEqual({ team: "discord", customer: "sent", deduped: false });
    const [, embed, opts] = postToDiscord.mock.calls[0];
    expect(embed.title).toMatch(/^\[TEST\] .*pi\\_abc$/);
    expect(field(embed, "Lot")).toMatch(/nothing staged/);
    expect(opts).not.toHaveProperty("content");
    expect(customerMail().to).toBe("meta@example.com");
  });

  it("no address anywhere: the team is told the customer was NOT emailed (never a fixed 'emailed once' claim)", async () => {
    readCard.mockResolvedValue(card({ customerEmail: null }));
    delete process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL;
    const result = await alertNeedsReconciliation(input({ row: row({ customer: { firstName: "Ada" } }) }));
    expect(result).toEqual({ team: "email", customer: "no_email", deduped: false });
    expect(teamMail().html).toContain("customer NOT emailed");
    expect(customerMail()).toBeUndefined();
  });

  it("no row and no card livemode (read failed): the deployment's key decides", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
    readCard.mockRejectedValue(new Error("stripe down"));
    await alertNeedsReconciliation(input({ row: null }));
    const [, embed, opts] = postToDiscord.mock.calls[0];
    expect(embed.title).toMatch(/^\[TEST\] /);
    expect(opts).not.toHaveProperty("content");
    expect(field(embed, "Money")).toContain("unknown");
  });

  it.each([
    [{ kind: "captured", amountCents: 2537, currency: "usd" }, "Your card was charged $25.37", "$25.37 CAPTURED"],
    [{ kind: "unknown" }, "not final until your reservation is confirmed", "unknown — read the PaymentIntent"],
  ])("money %j → customer sentence and team line match the card", async (money, customerText, teamText) => {
    readCard.mockResolvedValue(card({ money }));
    await alertNeedsReconciliation(input());
    expect(customerMail().html).toContain(customerText);
    expect(customerMail().html).toContain("Please don't book again");
    expect(field(postToDiscord.mock.calls[0][1], "Money")).toContain(teamText);
  });

  it("refunded in full: the customer is told the money is back and may book again — never 'don't book again'", async () => {
    readCard.mockResolvedValue(card({ money: { kind: "refunded", amountCents: 2537, currency: "usd" } }));
    await alertNeedsReconciliation(input());
    const mail = customerMail();
    expect(mail.subject).toMatch(/payment was returned/);
    expect(mail.html).toContain("has already been refunded in full");
    expect(mail.html).toContain("you can book again");
    expect(mail.html).not.toContain("don't book again");
    expect(field(postToDiscord.mock.calls[0][1], "Money")).toContain("$25.37 REFUNDED in full");
  });

  it("Discord unset → the team is emailed instead (PAYMENT_ALERT_EMAILS, idempotent), customer still emailed", async () => {
    delete process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL;
    const result = await alertNeedsReconciliation(input());
    expect(result).toEqual({ team: "email", customer: "sent", deduped: false });
    expect(postToDiscord).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    const team = teamMail();
    expect(team.to).toEqual(["vin@triplypro.com", "tom@triplypro.com"]);
    expect(team.subject).toMatch(/Booking needs a human — \$25\.37 — pi_abc/);
    expect(team.html).toContain("being emailed at ada@example.com"); // the team email DOES carry the address
    expect(team.html).toContain("https://dashboard.stripe.com/payments/pi_abc");
    const teamOpts = send.mock.calls.find((c) => Array.isArray(c[0].to))![1];
    expect(teamOpts).toEqual({ idempotencyKey: "reconciliation/team/pi_abc" });
  });

  it("Discord fails → team email, with the webhook token redacted from the Sentry report", async () => {
    postToDiscord.mockResolvedValue({ kind: "failed", status: 500, body: `boom ${WEBHOOK}`, retried: false });
    const result = await alertNeedsReconciliation(input());
    expect(result.team).toBe("email");
    const reported = capturePaymentError.mock.calls.map((c) => c[0].message).join("\n");
    expect(reported).toContain("discord failed");
    expect(reported).not.toContain("AbCdEf_gh-ij");
  });

  it("the customer email is sent in parallel with the team delivery — a slow Discord + fallback never cuts it", async () => {
    vi.useFakeTimers();
    try {
      postToDiscord.mockImplementation(() => new Promise((r) => setTimeout(() => r({ kind: "failed", status: 500, body: "slow", retried: false }), 3_900)));
      let customerSentAt = -1;
      const t0 = Date.now();
      send.mockImplementation(async (m: { to: unknown }) => {
        if (!Array.isArray(m.to)) customerSentAt = Date.now() - t0;
        return { data: { id: "em" }, error: null };
      });
      const pending = alertNeedsReconciliation(input());
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await pending;
      expect(result).toEqual({ team: "email", customer: "sent", deduped: false });
      expect(customerSentAt).toBeGreaterThanOrEqual(0);
      expect(customerSentAt).toBeLessThan(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("customer send fails → 'failed', team alert unaffected, marker still written, never throws", async () => {
    send.mockResolvedValue({ data: null, error: { message: "daily quota exceeded" } });
    await expect(alertNeedsReconciliation(input())).resolves.toEqual({ team: "discord", customer: "failed", deduped: false });
    expect(markAlerted).toHaveBeenCalledTimes(1);
  });

  it("neither Discord nor email delivered → one loud Sentry report, fingerprinted PER payment; no marker (may alert again)", async () => {
    postToDiscord.mockRejectedValue(new Error("network"));
    send.mockRejectedValue(new Error("resend down"));
    const result = await alertNeedsReconciliation(input());
    expect(result).toEqual({ team: "none", customer: "failed", deduped: false });
    const call = capturePaymentError.mock.calls.find((c) => /neither Discord nor email delivered/.test(c[0].message));
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ stripePaymentIntentId: "pi_abc", fingerprint: ["reconciliation-alert", "team alert", "pi_abc"] });
    expect(markAlerted).not.toHaveBeenCalled();
  });

  it("customer-supplied text is escaped in the customer email; a non-string email never throws", async () => {
    await alertNeedsReconciliation(input({ row: row({ customer: { firstName: "<b>Bree</b>", email: "bree@example.com" } }) }));
    expect(customerMail().html).toContain("Hi &lt;b&gt;Bree&lt;/b&gt;,");
    vi.clearAllMocks();
    readCard.mockResolvedValue(card({ customerEmail: null }));
    const result = await alertNeedsReconciliation(input({ row: row({ customer: { email: 42 as unknown as string } }) }));
    expect(result.customer).toBe("no_email");
  });

  it("a 5,000-character markdown reason keeps the Discord 'Why' field under 1,024 characters", async () => {
    await alertNeedsReconciliation(input({ reason: "*_~|>[]()`".repeat(500) }));
    expect(field(postToDiscord.mock.calls[0][1], "Why").length).toBeLessThanOrEqual(1024);
  });

  it("the whole alert is capped, and the result reports what DID finish", async () => {
    vi.useFakeTimers();
    try {
      postToDiscord.mockImplementation(() => new Promise(() => {}));
      const pending = alertNeedsReconciliation(input());
      await vi.advanceTimersByTimeAsync(18_001);
      await expect(pending).resolves.toEqual({ team: "none", customer: "sent", deduped: false });
      const whole = capturePaymentError.mock.calls.find((c) => /whole alert failed/.test(c[0].message));
      expect(whole![1]).toMatchObject({ fingerprint: ["reconciliation-alert", "whole alert", "pi_abc"] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("scheduleReconciliationAlert", () => {
  it("defers the alert to after the response when a request scope exists", async () => {
    after.mockImplementation(() => undefined);
    await scheduleReconciliationAlert(input());
    expect(after).toHaveBeenCalledTimes(1);
    expect(postToDiscord).not.toHaveBeenCalled(); // nothing ran yet
    await after.mock.calls[0][0]();
    expect(postToDiscord).toHaveBeenCalledTimes(1);
  });

  it("runs inline when `after` is unavailable (no request scope), and never throws", async () => {
    after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    await expect(scheduleReconciliationAlert(input())).resolves.toBeUndefined();
    expect(postToDiscord).toHaveBeenCalledTimes(1);
  });
});

describe("formatLiteralDateTime", () => {
  it("reformats a literal wall-clock string without Date math", () => {
    expect(formatLiteralDateTime("2026-11-11 07:00:00")).toBe("Nov 11, 2026 at 7:00 AM");
    expect(formatLiteralDateTime("2026-11-15 18:00:00")).toBe("Nov 15, 2026 at 6:00 PM");
    expect(formatLiteralDateTime("2026-01-01 00:30:00")).toBe("Jan 1, 2026 at 12:30 AM");
    expect(formatLiteralDateTime("2026-12-31 12:00:00")).toBe("Dec 31, 2026 at 12:00 PM");
  });
  it("shows anything else as-is", () => {
    expect(formatLiteralDateTime("tomorrow")).toBe("tomorrow");
    expect(formatLiteralDateTime("2026-13-01 10:00:00")).toBe("2026-13-01 10:00:00");
  });
});
