import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/resend/client", () => ({ resend: {}, FROM_EMAIL: "test@example.com" }));

import { buildRecoveryEmail } from "../email";
import { selectRecoveryCandidates, type PaymentIntentLike } from "../select";

const NOW = Date.UTC(2026, 9, 7, 15, 0, 0);
const pi = (metadata: Record<string, string>): PaymentIntentLike => ({
  id: "pi_1",
  status: "requires_payment_method",
  created: Math.floor((NOW - 60 * 60_000) / 1000),
  amount: 3039,
  livemode: true,
  metadata: {
    lotId: "reslab-10",
    locationId: "10",
    checkin: "2026-10-20",
    checkout: "2026-10-22",
    checkinTime: "10:00 AM",
    checkoutTime: "6:00 PM",
    customerEmail: "a@example.com",
    ...metadata,
  },
});
const email = (metadata: Record<string, string>) => {
  const [candidate] = selectRecoveryCandidates([pi(metadata)], NOW).candidates;
  const { subject, html, text } = buildRecoveryEmail(candidate, { name: "Test Lot", airportCode: "YUL" }, "https://example.com/u", "1 Test St");
  return [subject, html, text].join("\n");
};

describe("abandoned-checkout email — the amount's currency", () => {
  it("a US lot: a plain $, as before", () => {
    const out = email({ reslabCurrency: "USD" });
    expect(out).toContain("$30.39");
    expect(out).not.toContain("US$");
  });

  it("a lot converted from Canadian dollars: US$ on the amount, in the HTML and the text, and no bare $", () => {
    const out = email({ reslabCurrency: "CAD", fxRateId: "r1", fxRateMicros: "720000" });
    expect((out.match(/US\$30\.39/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(out).not.toMatch(/(?<!US)\$\d/);
  });
});
