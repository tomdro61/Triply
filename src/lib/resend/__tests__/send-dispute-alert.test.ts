/**
 * The dispute alert: the deadline reads in Eastern time with the clock time
 * (Stripe's 23:59 UTC is early evening Eastern), and a hung Resend call fails
 * inside the webhook's budget instead of holding the send lease until the
 * function is killed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../client", () => ({ resend: { emails: { send } }, FROM_EMAIL: "Triply <bookings@triplypro.com>" }));

import { formatDeadline, sendDisputeOpenedAlert } from "../send-dispute-alert";
import { playbookFor } from "@/lib/disputes/evidence";

const alert = {
  disputeId: "dp_1",
  amountCents: 6356,
  reason: "fraudulent",
  dueByISO: "2026-11-17T04:59:59.000Z",
  livemode: true,
  confirmationNumber: "RTL1",
  customerEmail: "a@b.com",
  lot: "Park Fast",
  checkIn: "2026-11-10T08:00:00",
  playbook: playbookFor("fraudulent"),
  draftSaved: false,
  draftError: null,
  draftUnknown: false,
};

beforeEach(() => send.mockReset().mockResolvedValue({ data: { id: "e1" }, error: null }));
afterEach(() => vi.useRealTimers());

describe("formatDeadline", () => {
  it("shows Stripe's end-of-day UTC deadline as the Eastern evening it really is", () => {
    expect(formatDeadline("2026-11-16T23:59:59.000Z")).toBe("Nov 16, 2026, 6:59 PM EST");
    expect(formatDeadline("2026-07-16T23:59:59.000Z")).toBe("Jul 16, 2026, 7:59 PM EDT");
  });

  it("a just-after-midnight UTC deadline is the previous day in Eastern time", () => {
    expect(formatDeadline("2026-11-17T04:59:59.000Z")).toBe("Nov 16, 2026, 11:59 PM EST");
  });
});

describe("sendDisputeOpenedAlert", () => {
  it("puts the Eastern deadline in the subject", async () => {
    await sendDisputeOpenedAlert(alert);
    expect(send.mock.calls[0][0].subject).toContain("respond by Nov 16, 2026, 11:59 PM EST");
  });

  it("an interrupted draft tells the reader to check Stripe", async () => {
    await sendDisputeOpenedAlert({ ...alert, draftUnknown: true });
    expect(send.mock.calls[0][0].html).toContain("Check the evidence in Stripe before filling it in.");
  });

  it("a Resend error throws so the caller frees its lease", async () => {
    send.mockResolvedValueOnce({ data: null, error: { message: "daily quota" } });
    await expect(sendDisputeOpenedAlert(alert)).rejects.toThrow("Dispute alert email failed: daily quota");
  });

  it("a hung Resend call fails after 10 s", async () => {
    vi.useFakeTimers();
    send.mockReturnValueOnce(new Promise(() => {}));
    const p = sendDisputeOpenedAlert(alert);
    const done = expect(p).rejects.toThrow("Dispute alert email timed out after 10000ms");
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
  });
});

describe("timeLeftLabel", () => {
  it("counts hours under two days, days after, and 'passed' once gone", async () => {
    const { timeLeftLabel } = await import("@/lib/disputes/deadline");
    const now = Date.parse("2026-11-16T12:00:00Z");
    expect(timeLeftLabel("2026-11-16T23:59:59Z", now).label).toBe("11h left");
    expect(timeLeftLabel("2026-11-20T12:00:00Z", now).label).toBe("4d left");
    expect(timeLeftLabel("2026-11-16T11:00:00Z", now).label).toBe("passed");
  });
});

// Review High: a Stripe-only refund leaves the ResLab reservation live (the
// lot still honours it and ResLab still bills it).
describe("sendFraudWarningAlert", () => {
  const base = { warningId: "issfr_1", chargeId: "ch_1", fraudType: "made_with_stolen_card", actionable: true, livemode: true, bookingStatus: "confirmed", checkIn: "2026-12-01T08:00:00" };

  it("with a booking: cancel with a full refund from admin, never Stripe alone", async () => {
    const { sendFraudWarningAlert } = await import("../send-dispute-alert");
    await sendFraudWarningAlert({ ...base, confirmationNumber: "RTL1" });
    const html: string = send.mock.calls[0][0].html;
    expect(html).toContain("Admin → Bookings");
    expect(html).toContain("Don't refund in Stripe alone");
    expect(send.mock.calls[0][0].subject).not.toContain("$");
  });

  it("no booking: refund in Stripe", async () => {
    const { sendFraudWarningAlert } = await import("../send-dispute-alert");
    await sendFraudWarningAlert({ ...base, confirmationNumber: null });
    expect(send.mock.calls[0][0].html).toContain("No booking matches this charge");
  });
});
