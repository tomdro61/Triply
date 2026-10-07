import { describe, it, expect } from "vitest";
import { bucketCheckoutFailure, deviceToday, fieldList, leadDays } from "../checkout-funnel";
import { STALE_CHECKOUT_MESSAGE } from "@/lib/parkguard/plans";

describe("bucketCheckoutFailure — real /api/checkout/lot responses", () => {
  it.each([
    [{ status: 404, message: "Lot not found" }, "not_found"],
    [{ status: 409, message: "This parking option is sold out" }, "sold_out"],
    [{ status: 400, message: "Check-in time is required" }, "invalid_input"],
    [{ status: 400, message: STALE_CHECKOUT_MESSAGE }, "stale_quote"],
    [{ status: 503, message: "Online booking for this lot is not open yet", code: "direct_not_bookable_yet" }, "not_bookable"],
    [{ status: 503, message: "Online booking for this lot is not open yet" }, "not_bookable"],
    [{ status: 503, message: "Parking data is temporarily unavailable" }, "unavailable"],
    // ResLab "Minimum number of hours before parking reservation is 24"
    // reaches the client as this generic 500.
    [{ status: 500, message: "Failed to create payment intent" }, "unavailable"],
    // A non-JSON 504: .json() throws a SyntaxError, but the status was kept.
    [{ status: 504, error: new SyntaxError("Unexpected token <") }, "unavailable"],
  ] as const)("%o → %s", (input, expected) => {
    expect(bucketCheckoutFailure(input)).toBe(expected);
  });

  it("tells a network failure from a refusal before sending", () => {
    expect(bucketCheckoutFailure({ error: new TypeError("Failed to fetch") })).toBe("network");
    expect(bucketCheckoutFailure({ error: new Error("Missing required lot data for payment") })).toBe("client");
    expect(bucketCheckoutFailure({})).toBe("other");
  });

  it("never returns a raw message", () => {
    const reason = bucketCheckoutFailure({ status: 418, message: "jane@example.com something odd" });
    expect(reason).toBe("other");
  });
});

describe("fieldList", () => {
  it("sorts, de-duplicates and joins keys", () => {
    expect(fieldList(["phone", "email", "email", ""])).toBe("email,phone");
    expect(fieldList(new Set(["state", "extra:return_flight_number", "make"]))).toBe(
      "extra:return_flight_number,make,state"
    );
  });

  it("stays within GA4's 100-character limit, cutting at a comma", () => {
    const keys = Array.from({ length: 30 }, (_, i) => `field_${String(i).padStart(2, "0")}`);
    const out = fieldList(keys);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(",")).toBe(false);
    expect(out.split(",").every((k) => keys.includes(k))).toBe(true);
  });

  it("is empty for no errors", () => {
    expect(fieldList([])).toBe("");
  });
});

describe("leadDays / deviceToday", () => {
  it("counts calendar days between literal dates", () => {
    expect(leadDays("2026-10-06", "2026-10-06")).toBe(0);
    expect(leadDays("2026-10-09", "2026-10-06")).toBe(3);
    expect(leadDays("2026-11-02", "2026-10-31")).toBe(2); // across DST end
    expect(leadDays("2027-01-01", "2026-12-31")).toBe(1);
    expect(leadDays("not-a-date", "2026-10-06")).toBeNull();
  });

  it("formats the device's date as YYYY-MM-DD", () => {
    expect(deviceToday(new Date(2026, 9, 6, 23, 30))).toBe("2026-10-06");
  });
});
