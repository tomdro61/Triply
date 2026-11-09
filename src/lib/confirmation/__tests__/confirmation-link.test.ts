import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const sentry = vi.hoisted(() => ({ captureBookingError: vi.fn() }));
vi.mock("@/lib/sentry", () => sentry);

import { confirmationLink } from "../confirmation-link";
import { bookingKey, verifyBookingKey } from "../booking-key";
import { BookingConfirmationEmail } from "@/lib/resend/templates/booking-confirmation";

beforeEach(() => {
  sentry.captureBookingError.mockReset();
  vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", "test-secret-one");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.triplypro.com");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("confirmationLink", () => {
  it("carries the booking key and the email; the key verifies for this number", () => {
    const url = new URL(confirmationLink("RTL869257", "dana+trip@example.com", { withKey: true }));
    expect(url.origin + url.pathname).toBe("https://www.triplypro.com/confirmation/RTL869257");
    expect(url.searchParams.get("email")).toBe("dana+trip@example.com");
    const key = url.searchParams.get("booking_key");
    expect(key).toBe(bookingKey("RTL869257"));
    expect(verifyBookingKey("RTL869257", key ?? "")).toBe(true);
    expect([...url.searchParams.keys()]).toEqual(["booking_key", "email"]);
    expect(sentry.captureBookingError).not.toHaveBeenCalled();
  });

  it("the same input gives the same link (a re-send carries an identical email)", () => {
    expect(confirmationLink("RTL1", "a@b.co", { withKey: true })).toBe(confirmationLink("RTL1", "a@b.co", { withKey: true }));
  });

  it("a missing secret: the email still gets today's ?email= link, and the fault is reported", () => {
    vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", "");
    expect(confirmationLink("RTL1", "a@b.co", { withKey: true })).toBe("https://www.triplypro.com/confirmation/RTL1?email=a%40b.co");
    expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);
    expect(sentry.captureBookingError.mock.calls[0][1]).toMatchObject({ fingerprint: ["confirmation-link-without-key"] });
  });

  it("withKey false (the local resend script): no key, nothing reported", () => {
    expect(confirmationLink("RTL1", "a@b.co", { withKey: false })).toBe("https://www.triplypro.com/confirmation/RTL1?email=a%40b.co");
    expect(sentry.captureBookingError).not.toHaveBeenCalled();
  });

  it("the template renders the link it is given, as is", () => {
    const confirmationUrl = confirmationLink("RTL869257", "dana@example.com", { withKey: true });
    const html = renderToStaticMarkup(
      createElement(BookingConfirmationEmail, {
        customerName: "Dana Rivera",
        confirmationUrl,
        confirmationNumber: "RTL869257",
        lotName: "Lot",
        lotAddress: "1 Main St",
        checkInDate: "Nov 9, 2026",
        checkOutDate: "Nov 12, 2026",
        checkInTime: "8:00 AM",
        checkOutTime: "6:00 PM",
        totalAmount: 74,
      })
    );
    expect(html).toContain(`href="${confirmationUrl.replace(/&/g, "&amp;")}"`);
    expect(html).toContain("booking_key=");
  });
});
