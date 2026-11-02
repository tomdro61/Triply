import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("../client", () => ({ resend: { emails: { send } }, FROM_EMAIL: "Triply <bookings@example.com>" }));
vi.mock("@/lib/sentry", () => ({ captureBookingError: vi.fn() }));

const { sendAdminBookingNotification } = await import("../send-admin-booking-notification");
const { buildCostBreakdown } = await import("@/lib/booking/cost-breakdown");

const base = {
  confirmationNumber: "TRP-D0K1KGXC",
  customerName: "Ada Lovelace",
  customerEmail: "ada@example.com",
  customerPhone: "555-0100",
  lotName: "The Parking Point JFK",
  lotAddress: "150-57 183rd St",
  checkInDate: "2026-10-20",
  checkOutDate: "2026-10-22",
  totalAmount: 42.02,
  dueAtLocation: 0,
};

async function html(props: Partial<Parameters<typeof sendAdminBookingNotification>[0]>): Promise<string> {
  send.mockClear();
  await sendAdminBookingNotification({ ...base, ...props });
  return (send.mock.calls[0][0] as { html: string }).html;
}

beforeEach(() => {
  send.mockResolvedValue({ data: { id: "em_admin" }, error: null });
  // These pin the EMAIL; never post to a webhook a developer's shell happens to export.
  vi.stubEnv("DISCORD_BOOKING_ALERTS_WEBHOOK_URL", "");
});

describe("admin booking notification — the cost breakdown (plan 2026-10-12)", () => {
  it("a direct oversized booking: every line, the card charge, the at-lot estimate and the trip total — escaped", async () => {
    const breakdown = buildCostBreakdown({
      source: "direct",
      subtotal: 19.9,
      tax: 3.18,
      serviceFee: 5.95,
      promoDiscount: 0,
      promoCode: null,
      expectedPromoCents: null,
      protection: { name: "Plan A", premium: 12.99 },
      atLot: { surchargeCents: 1000, surchargeTaxCents: 160, vehicleSizeLabel: "Small <b>SUV</b>" },
      days: 2,
      anchorChargedCents: 4202,
      refundedCents: 0,
      cancelled: false,
    });
    expect(breakdown.ok).toBe(true);
    const out = await html({ breakdown });
    expect(out).toContain("Parking — 2 days");
    expect(out).toContain("$19.90");
    expect(out).toContain("Parking Protection — Plan A");
    expect(out).toContain("Charged to card");
    expect(out).toContain("$42.02");
    expect(out).toContain("Due at the lot (est., Small &lt;b&gt;SUV&lt;/b&gt;)");
    expect(out).toContain("$11.60");
    expect(out).toContain("Trip total (est.)");
    expect(out).toContain("$53.62");
    expect(out).not.toContain("<b>SUV</b>");
  });

  it("a ResLab pay-at-lot promo booking: Total, then Paid online + Due at location", async () => {
    const breakdown = buildCostBreakdown({
      source: "reslab",
      subtotal: 80,
      fees: 3,
      longTermDiscount: 0,
      tax: 5,
      grandTotal: 88,
      dueAtLocation: 20,
      days: null,
      serviceFee: 6,
      promoDiscount: 8,
      promoCode: "SAVE10",
      expectedPromoCents: 800,
      protection: null,
      anchorChargedCents: 6600,
      refundedCents: 0,
      cancelled: false,
    });
    const out = await html({ totalAmount: 86, dueAtLocation: 20, breakdown });
    expect(out).toContain("Promo discount (SAVE10)");
    expect(out).toContain("−$8.00");
    expect(out).toContain("$86.00");
    expect(out).toContain("Paid online (card)");
    expect(out).toContain("$66.00");
    expect(out).toContain("Due at location");
    expect(out).toContain("$20.00");
    // Not the fallback rows.
    expect(out).not.toContain("Paid Online");
  });

  it("ok:false with the charge known: the anchor as 'Charged to card', the recorded due amount, and why", async () => {
    const out = await html({
      totalAmount: 94,
      dueAtLocation: 20,
      protectionPlan: "$1,000 Protection",
      protectionPlanPrice: 12.99,
      breakdown: { ok: false, reason: "ResLab <parts> do not add up" },
      anchoredFallback: {
        chargedCents: 6600,
        due: { kind: "amount", cents: 2000 },
        protection: { label: "Plan A", premiumCents: 1299 },
        reason: "ResLab <parts> do not add up",
      },
    });
    expect(out).toContain("Charged to card");
    expect(out).toContain("$66.00");
    expect(out).toContain("Due at location");
    expect(out).toContain("$20.00");
    expect(out).toContain("Parking Protection — Plan A (incl.)");
    expect(out).toContain("$12.99");
    expect(out).not.toContain("$1,000 Protection");
    expect(out).toContain("ResLab &lt;parts&gt; do not add up");
    expect(out).not.toContain("$94.00");
    expect(out).not.toContain("Paid Online");
  });

  it("a due amount in doubt is not stated as fact", async () => {
    const reason = "due at location exceeds the parking total";
    const out = await html({
      totalAmount: 94,
      dueAtLocation: 20,
      breakdown: { ok: false, reason },
      anchoredFallback: { chargedCents: 6600, due: { kind: "unconfirmed" }, protection: null, reason },
    });
    expect(out).toContain("Unconfirmed — check the reservation");
    expect(out).not.toContain("$20.00");
  });

  it("without a breakdown (or ok:false with no known charge): today's rows", async () => {
    const plain = await html({ totalAmount: 94, dueAtLocation: 20, protectionPlan: "Plan A", protectionPlanPrice: 12.99 });
    expect(plain).toContain("$94.00");
    expect(plain).toContain("Paid Online");
    expect(plain).toContain("$74.00");
    expect(plain).toContain("Plan A — $12.99");
    const failed = await html({
      totalAmount: 94,
      dueAtLocation: 20,
      protectionPlan: "Plan A",
      protectionPlanPrice: 12.99,
      breakdown: { ok: false, reason: "x" },
    });
    expect(failed.replace(/\s+/g, " ")).toBe(plain.replace(/\s+/g, " "));
  });
});
