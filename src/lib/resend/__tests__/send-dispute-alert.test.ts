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
