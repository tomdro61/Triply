/**
 * safeBreakdown (fulfill.ts): a cost breakdown that THROWS on the money path
 * falls back — and is reported WITH the error so it can be diagnosed (review
 * round 3). fulfill.ts is imported for real; only its I/O boundaries are stubbed.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/booking/reconciliation-alert", () => ({
  RECONCILIATION_ALERT_COLUMNS: "stripe_payment_intent_id, livemode, customer, location_name, airport_code, from_date, to_date, reslab_reservation_number, inventory_source",
  alertNeedsReconciliation: vi.fn(async () => ({ team: "discord", customer: "sent" })),
  scheduleReconciliationAlert: vi.fn(async () => undefined),
}));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => ({}) }));
vi.mock("@/lib/reslab/client", () => ({ reslab: {}, stripHtml: (s: string | null) => s ?? "" }));
vi.mock("@/lib/resend/send-booking-confirmation", () => ({ sendBookingConfirmation: vi.fn() }));
vi.mock("@/lib/resend/send-admin-booking-notification", () => ({ sendAdminBookingNotification: vi.fn() }));
vi.mock("@/lib/sentry", () => ({
  capturePaymentError: vi.fn(),
  captureBookingError: vi.fn(),
  captureParkGuardError: vi.fn(),
  captureAPIError: vi.fn(),
}));

const { safeBreakdown } = await import("../fulfill");
const { captureBookingError } = await import("@/lib/sentry");

describe("safeBreakdown", () => {
  it("a throw → ok:false, reported with the error, the booking and one fingerprint", () => {
    const boom = new Error("boom: unexpected ResLab value");
    const out = safeBreakdown("RTL1", "reslab", () => {
      throw boom;
    });
    expect(out).toEqual({ ok: false, reason: "cost breakdown could not be built (unexpected input)" });
    expect(captureBookingError).toHaveBeenCalledWith(boom, {
      step: "confirmation",
      fingerprint: ["email-cost-breakdown-threw"],
      confirmationNumber: "RTL1",
      inventorySource: "reslab",
    });
  });

  it("a non-Error throw is wrapped, never lost", () => {
    safeBreakdown("TRP-1", "direct", () => {
      throw "string thrown";
    });
    expect(captureBookingError).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "cost breakdown threw: string thrown" }),
      expect.objectContaining({ inventorySource: "direct" })
    );
  });

  it("no throw → the result, nothing reported", () => {
    vi.mocked(captureBookingError).mockClear();
    expect(safeBreakdown("RTL2", "reslab", () => ({ ok: false, reason: "x" }))).toEqual({ ok: false, reason: "x" });
    expect(captureBookingError).not.toHaveBeenCalled();
  });
});
