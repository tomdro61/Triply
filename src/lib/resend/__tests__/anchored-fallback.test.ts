import { describe, it, expect } from "vitest";
import { anchoredFallback } from "../anchored-fallback";
import { fallbackDue } from "@/lib/booking/cost-breakdown";

describe("the anchored email fallback", () => {
  const failed = { ok: false as const, reason: "service fee missing (legacy row?)" };

  it("only for an ok:false breakdown with a known charge", () => {
    const due = () => ({ kind: "none" as const });
    expect(anchoredFallback(failed, null, due, null)).toBeUndefined();
    expect(anchoredFallback({ ok: false, reason: "x" }, Number.NaN, due, null)).toBeUndefined();
  });

  it("labels the plan by its code and carries the core's due decision and the refusal", () => {
    expect(
      anchoredFallback(failed, 6600, (refusal) => fallbackDue({ source: "reslab", recordedDue: 20, grandTotal: 88, parts: { subtotal: 80, fees: 3, longTermDiscount: 0, tax: 5 }, refusal, cancelled: false }), {
        code: "C",
        premium: 4.95,
      })
    ).toEqual({
      chargedCents: 6600,
      due: { kind: "amount", cents: 2000 },
      protection: { label: "Plan C", premiumCents: 495 },
      reason: "service fee missing (legacy row?)",
    });
  });

  it("direct: the at-lot surcharge estimate (dollars) is still shown", () => {
    const f = anchoredFallback(
      { ok: false, reason: "the parts do not add up to what the card was charged" },
      6366,
      (refusal) => fallbackDue({ source: "direct", recordedDue: 58, refusal, cancelled: false }),
      null
    );
    expect(f?.due).toEqual({ kind: "amount", cents: 5800 });
  });
});
