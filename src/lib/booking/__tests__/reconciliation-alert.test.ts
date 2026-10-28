/**
 * The moment a payment lands in reconciliation, the team hears NOW and the
 * customer is told once (P1b, launch-QA finding #8, Oct 28 2026).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const maybeSingle = vi.hoisted(() => vi.fn());
const postToDiscord = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const moneyOnCard = vi.hoisted(() => vi.fn());
const capturePaymentError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: async () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  }),
}));
vi.mock("@/lib/digest/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/digest/discord")>()),
  postToDiscord,
}));
vi.mock("@/lib/resend/client", () => ({ resend: { emails: { send } }, FROM_EMAIL: "Triply <bookings@triplypro.com>" }));
vi.mock("@/lib/stripe/money-on-card", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stripe/money-on-card")>()),
  moneyOnCard,
}));
vi.mock("@/lib/sentry", () => ({ capturePaymentError }));
vi.mock("@/config/admin", () => ({ PAYMENT_ALERT_EMAILS: ["vin@triplypro.com", "tom@triplypro.com"] }));

import { alertNeedsReconciliation, formatLiteralDateTime } from "../reconciliation-alert";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/AbCdEf_gh-ij";

const row = (over: Record<string, unknown> = {}) => ({
  customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  location_name: "PARK AC JFK",
  airport_code: "JFK",
  from_date: "2026-11-11 07:00:00",
  to_date: "2026-11-15 18:00:00",
  grand_total: "74.89",
  livemode: true,
  inventory_source: "reslab",
  reslab_reservation_number: null,
  ...over,
});

const input = {
  stripePaymentIntentId: "pi_abc",
  status: "needs_reconciliation" as const,
  reason: "ResLab ambiguous failure: API request failed: <html><body><h1>Whoops, looks like something went wrong.</h1></body></html>",
  source: "engine",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL = WEBHOOK;
  maybeSingle.mockResolvedValue({ data: row(), error: null });
  moneyOnCard.mockResolvedValue({ kind: "hold", amountCents: 2537, currency: "usd" });
  postToDiscord.mockResolvedValue({ kind: "posted", status: 200, retried: false });
  send.mockResolvedValue({ data: { id: "em_1" }, error: null });
});
afterEach(() => {
  delete process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL;
});

describe("alertNeedsReconciliation", () => {
  it("live row: Discord with @here, one customer email with the hold sentence and the reference; no team email", async () => {
    const result = await alertNeedsReconciliation(input);
    expect(result).toEqual({ team: "discord", customer: "sent" });

    expect(postToDiscord).toHaveBeenCalledTimes(1);
    const [url, embed, opts] = postToDiscord.mock.calls[0];
    expect(url).toBe(WEBHOOK);
    expect(embed.title).toBe("Booking needs a human — pi\\_abc"); // underscore escaped for Discord markdown
    expect(embed.fields.find((f: { name: string }) => f.name === "Money").value).toMatch(/\$25\.37 HELD/);
    expect(embed.fields.find((f: { name: string }) => f.name === "Why").value).not.toMatch(/<html>|<h1>/);
    expect(embed.fields.find((f: { name: string }) => f.name === "Why").value).toMatch(/Whoops/);
    expect(opts).toMatchObject({ content: "@here", allowedMentions: { parse: ["everyone"] }, requireMessageId: true });
    // No customer email address in Discord (it is in the admin).
    expect(JSON.stringify(embed)).not.toContain("ada@example.com");

    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.to).toBe("ada@example.com");
    expect(mail.subject).toMatch(/finishing your Triply booking/);
    expect(mail.html).toContain("$25.37 on your card is a hold");
    expect(mail.html).toContain("pi_abc");
    expect(mail.html).toContain("Nov 11, 2026 at 7:00 AM");
    expect(mail.html).toContain("Please don't book again");
    expect(mail.html).not.toMatch(/business day|not (been )?charged/i);
  });

  it("staging row (livemode false): [TEST] title, no ping", async () => {
    maybeSingle.mockResolvedValue({ data: row({ livemode: false }), error: null });
    await alertNeedsReconciliation(input);
    const [, embed, opts] = postToDiscord.mock.calls[0];
    expect(embed.title).toMatch(/^\[TEST\] /);
    expect(opts).not.toHaveProperty("content");
  });

  it("captured money: the customer email says charged + refunded in full", async () => {
    moneyOnCard.mockResolvedValue({ kind: "captured", amountCents: 2537, currency: "usd" });
    await alertNeedsReconciliation(input);
    expect(send.mock.calls[0][0].html).toContain("Your card was charged $25.37");
  });

  it("unknown money: no figure, the 'not final' sentence", async () => {
    moneyOnCard.mockResolvedValue({ kind: "unknown" });
    await alertNeedsReconciliation(input);
    expect(send.mock.calls[0][0].html).toContain("not final until your reservation is confirmed");
    expect(send.mock.calls[0][0].html).not.toContain("$");
  });

  it("Discord unset → the team is emailed instead (PAYMENT_ALERT_EMAILS), customer still emailed", async () => {
    delete process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL;
    const result = await alertNeedsReconciliation(input);
    expect(result).toEqual({ team: "email", customer: "sent" });
    expect(postToDiscord).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    const team = send.mock.calls[0][0];
    expect(team.to).toEqual(["vin@triplypro.com", "tom@triplypro.com"]);
    expect(team.subject).toMatch(/Booking needs a human — \$25\.37 — pi_abc/);
    expect(team.html).toContain("ada@example.com"); // the team email DOES carry the address
  });

  it("Discord fails → team email, with the webhook token redacted from the Sentry report", async () => {
    postToDiscord.mockResolvedValue({ kind: "failed", status: 500, body: `boom ${WEBHOOK}`, retried: false });
    const result = await alertNeedsReconciliation(input);
    expect(result.team).toBe("email");
    const reported = capturePaymentError.mock.calls.map((c) => c[0].message).join("\n");
    expect(reported).toContain("discord failed");
    expect(reported).not.toContain("AbCdEf_gh-ij");
  });

  it("row unreadable → still alerts the team with the PaymentIntent id; no customer email", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    const result = await alertNeedsReconciliation(input);
    expect(result).toEqual({ team: "discord", customer: "no_email" });
    const [, embed] = postToDiscord.mock.calls[0];
    expect(embed.title).toContain("pi\\_abc");
    expect(embed.fields.find((f: { name: string }) => f.name === "Lot").value).toMatch(/row not readable/);
    expect(send).not.toHaveBeenCalled();
    expect(capturePaymentError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("row read failed") }),
      expect.objectContaining({ stripePaymentIntentId: "pi_abc" })
    );
  });

  it("customer send fails → 'failed', team alert unaffected, never throws", async () => {
    send.mockResolvedValue({ data: null, error: { message: "daily quota exceeded" } });
    await expect(alertNeedsReconciliation(input)).resolves.toEqual({ team: "discord", customer: "failed" });
  });

  it("neither Discord nor email delivered → one loud Sentry report", async () => {
    postToDiscord.mockRejectedValue(new Error("network"));
    send.mockRejectedValue(new Error("resend down"));
    const result = await alertNeedsReconciliation(input);
    expect(result).toEqual({ team: "none", customer: "failed" });
    const messages = capturePaymentError.mock.calls.map((c) => c[0].message);
    expect(messages.some((m) => /neither Discord nor email delivered/.test(m))).toBe(true);
  });

  it("customer-supplied text is escaped in the customer email", async () => {
    maybeSingle.mockResolvedValue({ data: row({ customer: { firstName: "<b>Bree</b>", email: "bree@example.com" } }), error: null });
    await alertNeedsReconciliation(input);
    expect(send.mock.calls[0][0].html).toContain("Hi &lt;b&gt;Bree&lt;/b&gt;,");
  });

  it("the whole alert is capped: a hanging step cannot hold the caller past the budget", async () => {
    vi.useFakeTimers();
    try {
      postToDiscord.mockImplementation(() => new Promise(() => {}));
      const pending = alertNeedsReconciliation(input);
      await vi.advanceTimersByTimeAsync(12_001);
      await expect(pending).resolves.toEqual({ team: "none", customer: "failed" });
    } finally {
      vi.useRealTimers();
    }
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
