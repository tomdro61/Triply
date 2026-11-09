import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const sent = vi.hoisted(() => ({ html: [] as string[] }));
vi.mock("../client", () => ({
  FROM_EMAIL: "Triply <bookings@triplypro.com>",
  resend: {
    emails: {
      send: async (payload: { html: string }) => {
        sent.html.push(payload.html);
        return { data: { id: "email_1" }, error: null };
      },
    },
  },
}));
vi.mock("@/lib/sentry", () => ({ captureBookingError: vi.fn() }));

import { sendBookingConfirmation } from "../send-booking-confirmation";
import { bookingKey } from "@/lib/confirmation/booking-key";

const params = {
  to: "dana@example.com",
  customerName: "Dana Rivera",
  confirmationNumber: "RTL869257",
  lotName: "Lot",
  lotAddress: "1 Main St",
  checkInDate: "Nov 9, 2026",
  checkOutDate: "Nov 12, 2026",
  checkInTime: "8:00 AM",
  checkOutTime: "6:00 PM",
  totalAmount: 74,
};

beforeEach(() => {
  sent.html = [];
  vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", "test-secret-one");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.triplypro.com");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sendBookingConfirmation: the View Booking Details link", () => {
  it("carries the signed key and the email; the same input renders byte-identical HTML", async () => {
    expect((await sendBookingConfirmation(params)).success).toBe(true);
    expect((await sendBookingConfirmation(params)).success).toBe(true);
    expect(sent.html[0]).toContain(
      `/confirmation/RTL869257?booking_key=${bookingKey("RTL869257")}&amp;email=dana%40example.com`
    );
    expect(sent.html[1]).toBe(sent.html[0]);
  });

  it("withBookingKey false (the local resend script) sends today's ?email= link", async () => {
    await sendBookingConfirmation({ ...params, withBookingKey: false });
    expect(sent.html[0]).toContain('href="https://www.triplypro.com/confirmation/RTL869257?email=dana%40example.com"');
    expect(sent.html[0]).not.toContain("booking_key");
  });

  it("a missing secret never blocks the email: it goes out with today's link", async () => {
    vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", "");
    expect((await sendBookingConfirmation(params)).success).toBe(true);
    expect(sent.html[0]).toContain('href="https://www.triplypro.com/confirmation/RTL869257?email=dana%40example.com"');
  });
});
