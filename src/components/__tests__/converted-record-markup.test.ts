import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";

/**
 * The RECORD of a booking for a lot priced in Canadian dollars at the source
 * (confirmation page and email, cancellation email, My Reservations card):
 * the customer was charged US dollars, so every amount reads "US$" — never a
 * bare "$", which a customer in Canada reads as Canadian dollars. Dispute
 * evidence quotes the Pay-step notice. A US-dollar booking's output is pinned separately
 * (us-record-markup-baseline.test.ts) and must not change.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://www.triplypro.com";
});
vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string }) => createElement("img", { src: props.src, alt: props.alt }),
}));
vi.mock("next/link", () => ({
  default: (props: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

import { BookingDetails, type PaymentFallback } from "@/components/confirmation/booking-details";
import { ReservationCard, type ReservationCardBooking } from "@/components/reservations/reservation-card";
import { BookingConfirmationEmail } from "@/lib/resend/templates/booking-confirmation";
import { CancellationConfirmationEmail } from "@/lib/resend/templates/cancellation-confirmation";
import { buildCostBreakdown, type CostBreakdownResult, type DirectCostInput, type ReslabCostInput } from "@/lib/booking/cost-breakdown";
import type { AnchoredFallback } from "@/lib/resend/anchored-fallback";
import { buildEvidence, chargeFactsFrom, type DisputeBooking } from "@/lib/disputes/evidence";
import {
  CURRENCY_NOTICE_VERSION,
  USD_CHARGE_LINE,
  USD_REFUND_LINE,
  currencyNoticeTextFor,
  isUsdLabelledBooking,
  isUsdLabelledPayment,
  moneyCents,
} from "@/lib/fx/usd-label";
import { FX_KEYS } from "@/lib/fx/cad-usd";
import type { UnifiedLot } from "@/types/lot";
import type Stripe from "stripe";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
/** A "$" before a digit that is not part of "US$". */
const BARE_DOLLAR = /(?<!US)\$\s*\d/;
const amounts = (s: string) => s.match(/(?:US)?\$[\d,]+\.\d{2}/g) ?? [];
/** Labelled output with the label taken off must be the US output: only the label differs. */
const unlabel = (s: string) => s.replaceAll("US$", "$");

describe("helpers", () => {
  it("moneyCents is formatUsd's text, with US$ only when labelled", () => {
    expect(moneyCents(3039, false)).toBe("$30.39");
    expect(moneyCents(3039, true)).toBe("US$30.39");
    expect(moneyCents(123456, true)).toBe("US$1,234.56");
    expect(moneyCents(500, true, true)).toBe("−US$5.00");
    expect(moneyCents(-500, true)).toBe("−US$5.00");
    expect(moneyCents(500, false, true)).toBe("−$5.00");
    expect(moneyCents(0, true)).toBe("US$0.00");
  });

  it("a booking is labelled only when its row says CAD", () => {
    expect(isUsdLabelledBooking({ reslab_currency: "CAD" })).toBe(true);
    for (const row of [null, undefined, {}, { reslab_currency: null }, { reslab_currency: "USD" }, { reslab_currency: "cad" }, { reslab_currency: "" }, { reslab_currency: 1 }]) {
      expect(isUsdLabelledBooking(row)).toBe(false);
    }
  });

  it("a payment is labelled only when its stamp says CAD, under the key the checkout writes", () => {
    expect(isUsdLabelledPayment({ [FX_KEYS.currency]: "CAD" })).toBe(true);
    for (const m of [null, undefined, {}, { [FX_KEYS.currency]: "USD" }, { [FX_KEYS.currency]: "cad" }, { currency: "CAD" }]) {
      expect(isUsdLabelledPayment(m)).toBe(false);
    }
  });

  it("a payment's notice stamp names the sentence that was shown; anything else names nothing", () => {
    expect(currencyNoticeTextFor(CURRENCY_NOTICE_VERSION)).toBe(USD_CHARGE_LINE);
    for (const v of [undefined, null, "", "2020-01-01", "toString", "constructor", 20261117]) {
      expect(currencyNoticeTextFor(v)).toBeNull();
    }
  });
});

const lot: UnifiedLot = {
  id: "reslab-330",
  source: "reslab",
  sourceId: "330",
  name: "Lot M",
  slug: "lot-m",
  address: "1 Rue",
  city: "Dorval",
  state: "QC",
  zipCode: "H4Y",
  latitude: 45.46,
  longitude: -73.75,
  amenities: [],
  photos: [],
  availability: "available",
};

const reslab = (over: Partial<ReslabCostInput> = {}): CostBreakdownResult =>
  buildCostBreakdown({
    source: "reslab",
    days: 3,
    subtotal: "105.00",
    fees: "15.00",
    longTermDiscount: 0,
    tax: "14.40",
    grandTotal: "134.40",
    dueAtLocation: 0,
    serviceFee: "7.20",
    promoDiscount: "0.00",
    promoCode: null,
    expectedPromoCents: null,
    protection: null,
    anchorChargedCents: 14160,
    refundedCents: 0,
    cancelled: false,
    ...over,
  });
const direct = (over: Partial<DirectCostInput> = {}): CostBreakdownResult =>
  buildCostBreakdown({
    source: "direct",
    days: 2,
    subtotal: "19.90",
    tax: "3.18",
    serviceFee: "5.95",
    promoDiscount: "0.00",
    promoCode: null,
    expectedPromoCents: null,
    protection: { name: "Plan A", premium: "12.99" },
    anchorChargedCents: 4202,
    refundedCents: 0,
    cancelled: false,
    atLot: { surchargeCents: 1000, surchargeTaxCents: 160, vehicleSizeLabel: "Small SUV" },
    ...over,
  });
const ok = (b: CostBreakdownResult) => {
  if (!b.ok) throw new Error(`fixture breakdown not ok: ${b.reason}`);
  return b;
};
const REFUSED: CostBreakdownResult = { ok: false, reason: "fixture" };

describe("confirmation page — Payment summary of a converted booking", () => {
  const NO_FALLBACK: PaymentFallback = { card: { status: "unknown" }, due: { kind: "none" }, dueContext: { source: "reslab" } };
  const details = (usdLabel: boolean, costBreakdown: CostBreakdownResult, fallback: PaymentFallback = NO_FALLBACK, cancelled = false) =>
    html(
      createElement(BookingDetails, {
        lot,
        checkIn: "2026-12-17",
        checkOut: "2026-12-22",
        checkInTime: "8:00 AM",
        checkOutTime: "6:00 PM",
        days: 5,
        costBreakdown,
        fallback,
        cancelled,
        usdLabel,
      })
    );
  const CHARGED_FALLBACK: PaymentFallback = {
    card: { status: "charged", chargedCents: 14160, refundedCents: 2000, netPaidCents: 12160 },
    due: { kind: "amount", cents: 2000 },
    dueContext: { source: "reslab" },
  };
  const cases: [string, CostBreakdownResult, PaymentFallback, boolean, number][] = [
    ["the breakdown", ok(reslab()), NO_FALLBACK, false, 4],
    ["the breakdown with part due at the location", ok(reslab({ dueAtLocation: "20.00", anchorChargedCents: 12160 })), NO_FALLBACK, false, 6],
    ["the cancelled view with its refund", ok(reslab({ cancelled: true, refundedCents: 13440 })), NO_FALLBACK, true, 6],
    ["the fallback (Stripe's charge, a refund, a recorded due amount)", REFUSED, CHARGED_FALLBACK, false, 4],
    ["a direct-lot breakdown with an at-lot estimate (never converted today; labelled all the same)", ok(direct()), NO_FALLBACK, false, 9],
    [
      "a direct-lot fallback with its estimate note",
      REFUSED,
      {
        card: { status: "charged", chargedCents: 4202, refundedCents: 0, netPaidCents: 4202 },
        due: { kind: "amount", cents: 1160 },
        dueContext: { source: "direct", estimate: { vehicleSizeLabel: "Small SUV", surcharge: 10, surchargeTax: 1.6 } },
      },
      false,
      4,
    ],
  ];

  it.each(cases)("%s: every amount reads US$, and only the label differs from the US page", (_n, breakdown, fallback, cancelled, count) => {
    const labelled = details(true, breakdown, fallback, cancelled);
    expect(labelled).not.toMatch(BARE_DOLLAR);
    expect(amounts(labelled)).toHaveLength(count);
    for (const a of amounts(labelled)) expect(a.startsWith("US$")).toBe(true);
    expect(unlabel(labelled)).toBe(details(false, breakdown, fallback, cancelled));
  });

  it("a refund is written −US$…", () => {
    expect(details(true, ok(reslab({ cancelled: true, refundedCents: 13440 })), NO_FALLBACK, true)).toContain("−US$134.40");
  });
});

describe("booking confirmation email of a converted booking", () => {
  const base = {
    customerName: "Ada Lovelace",
    confirmationUrl: "https://www.triplypro.com/confirmation/RTL-TEST",
    confirmationNumber: "RTL900",
    lotName: "Lot M",
    lotAddress: "1 Rue, Dorval",
    checkInDate: "2026-12-17",
    checkOutDate: "2026-12-22",
    checkInTime: "8:00 AM",
    checkOutTime: "6:00 PM",
    totalAmount: 141.6,
    dueAtLocation: 0,
  };
  const email = (usdLabel: boolean, props: Record<string, unknown>) =>
    html(createElement(BookingConfirmationEmail, { ...base, usdLabel, ...props } as Parameters<typeof BookingConfirmationEmail>[0]));
  const anchored: AnchoredFallback = {
    chargedCents: 14160,
    due: { kind: "amount", cents: 2000 },
    protection: { label: "Plan A", premiumCents: 1299 },
    reason: "fixture",
  };
  // [layout, props, how many amounts it prints]
  const layouts: [string, Record<string, unknown>, number][] = [
    ["breakdown", { breakdown: ok(reslab()) }, 4],
    ["breakdown, part due at the location", { breakdown: ok(reslab({ dueAtLocation: "20.00", anchorChargedCents: 12160 })) }, 6],
    ["anchored fallback", { breakdown: REFUSED, anchoredFallback: anchored }, 3],
    ["anchored fallback, direct", { breakdown: REFUSED, anchoredFallback: anchored, direct: { vehicleSizeLabel: "Small SUV", atLotEstimate: 20, discount: 0 } }, 3],
    ["breakdown, direct with an at-lot estimate", { breakdown: ok(direct()), direct: { vehicleSizeLabel: "Small SUV", atLotEstimate: 11.6, discount: 0 } }, 7],
    ["breakdown, refunded", { breakdown: ok(reslab({ refundedCents: 2000 })) }, 6],
    ["legacy, nothing due", {}, 1],
    ["legacy, nothing due, with protection", { protectionPlan: "Plan A", protectionPlanPrice: 12.99, pgSyncStatus: "synced" }, 2],
    ["legacy, part due at the location", { dueAtLocation: 20, protectionPlan: "Plan A", protectionPlanPrice: 12.99, pgSyncStatus: "synced" }, 5],
    [
      "legacy direct layout (never converted today; labelled all the same if it ever is)",
      { direct: { vehicleSizeLabel: "Large SUV / truck", atLotEstimate: 58, discount: 12 }, protectionPlan: "Plan A", protectionPlanPrice: 12.99, pgSyncStatus: "synced" },
      6,
    ],
  ];

  it.each(layouts)("%s: every amount reads US$, and only the label differs from the US email", (_n, props, count) => {
    const labelled = email(true, props);
    expect(labelled).not.toMatch(BARE_DOLLAR);
    expect(amounts(labelled)).toHaveLength(count);
    for (const a of amounts(labelled)) expect(a.startsWith("US$")).toBe(true);
    expect(unlabel(labelled)).toBe(email(false, props));
  });
});

describe("cancellation email of a converted booking", () => {
  const base = {
    customerName: "Ada Lovelace",
    confirmationNumber: "RTL900",
    lotName: "Lot M",
    lotAddress: "1 Rue, Dorval",
    checkInDate: "2026-12-17",
    checkOutDate: "2026-12-22",
    refundAmount: 135.65,
    wasRefunded: true,
  };
  const email = (usdLabel: boolean, over: Record<string, unknown> = {}) =>
    html(createElement(CancellationConfirmationEmail, { ...base, usdLabel, ...over }));
  const SPLIT = { protectionPlanRefund: 6.99, protectionPlanRetained: 6, serviceFee: 5.95 };

  it.each([
    ["a plain refund", {}, 1],
    ["the protection split, the retained part and the service fee", SPLIT, 5],
  ])("%s: every amount reads US$ and the refund sentence is there", (_n, over, count) => {
    const labelled = email(true, over);
    expect(labelled).not.toMatch(BARE_DOLLAR);
    expect(amounts(labelled)).toHaveLength(count);
    for (const a of amounts(labelled)) expect(a.startsWith("US$")).toBe(true);
    expect(labelled).toContain(USD_REFUND_LINE);
    // Apart from the label and that one sentence, it is the US email.
    const us = email(false, over);
    expect(us).not.toContain(USD_REFUND_LINE);
    expect(us).not.toContain("US$");
    expect(unlabel(labelled).replace(/<p[^>]*>Refunds are made in US dollars[^<]*<\/p>/, "")).toBe(us);
  });

  it("cancelled with no refund: no amount and no refund sentence, labelled or not", () => {
    const labelled = email(true, { refundAmount: 0, wasRefunded: false });
    expect(labelled).not.toContain(USD_REFUND_LINE);
    expect(amounts(labelled)).toEqual([]);
    expect(labelled).toBe(email(false, { refundAmount: 0, wasRefunded: false }));
  });
});

describe("My Reservations card of a converted booking", () => {
  const booking = (over: Partial<ReservationCardBooking> = {}): ReservationCardBooking => ({
    id: "b1",
    reslab_reservation_number: "RTL900001",
    reslab_location_id: 330,
    inventory_source: "reslab",
    direct_lot_id: null,
    vehicle_surcharge_cents: null,
    vehicle_surcharge_tax_cents: null,
    location_name: "Lot M",
    location_address: "1 Rue",
    airport_code: "YUL",
    check_in: "2030-06-15T10:00:00",
    check_out: "2030-06-20T10:00:00",
    grand_total: "100.00",
    subtotal: "85.00",
    fees_total: "7.00",
    tax_total: "8.00",
    triply_service_fee: "5.95",
    protection_plan: null,
    protection_plan_price: null,
    discount_amount: "0.00",
    due_at_location: "20.00",
    vehicle_info: null,
    status: "confirmed",
    created_at: "2030-06-01T00:00:00Z",
    cancellable: false,
    ...over,
  });
  const card = (b: ReservationCardBooking, justCancelledRefund?: number | null) =>
    html(createElement(ReservationCard, { booking: b, customerEmail: null, selfCancelEnabled: false, onCancelled: () => {}, justCancelledRefund }));

  it("the booking total and the due-at-location line read US$; only the label differs from a US card", () => {
    const labelled = card(booking({ usd_label: true }));
    expect(labelled).not.toMatch(BARE_DOLLAR);
    expect(amounts(labelled)).toEqual(["US$105.95", "US$20.00"]);
    expect(unlabel(labelled)).toBe(card(booking()));
  });

  it("the just-cancelled refund line reads US$", () => {
    const labelled = card(booking({ usd_label: true, status: "refunded" }), 100);
    expect(labelled).toContain("US$100.00 has been refunded");
    expect(labelled).not.toMatch(BARE_DOLLAR);
    expect(card(booking({ status: "refunded" }), 100)).toContain("$100.00 has been refunded");
    expect(card(booking({ status: "refunded" }), 100)).not.toContain("US$");
  });
});

describe("dispute evidence quotes the US-dollar notice a payment was shown", () => {
  const dispute: DisputeBooking = {
    id: "b1",
    reslab_reservation_number: "RTL900",
    location_name: "Lot M",
    location_address: "1 Rue, Dorval",
    airport_code: "YUL",
    check_in: "2026-12-17T08:00:00",
    check_out: "2026-12-22T18:00:00",
    due_at_location: "0",
    status: "confirmed",
    created_at: "2026-11-20T15:00:00Z",
    cancellation_reason: null,
    cancelled_by: null,
    cancel_state: null,
    cancel_claimed_at: null,
    inventory_source: "reslab",
    customers: null,
  };
  const charge = { amount_captured: 3039, amount_refunded: 0, currency: "usd", created: 1795000000, payment_method_details: null } as Stripe.Charge;
  const pi = (metadata: Record<string, string>) => ({ metadata }) as Stripe.PaymentIntent;
  const text = (metadata: Record<string, string>) =>
    JSON.stringify(buildEvidence(dispute, "general", { contact: null, charge: chargeFactsFrom(charge, pi(metadata)) }));

  it("a payment stamped with the notice version: the sentence is quoted", () => {
    const facts = chargeFactsFrom(charge, pi({ reslabCurrency: "CAD", currencyNotice: CURRENCY_NOTICE_VERSION }));
    expect(facts.currencyNoticeText).toBe(USD_CHARGE_LINE);
    const out = text({ reslabCurrency: "CAD", currencyNotice: CURRENCY_NOTICE_VERSION });
    expect(out).toContain(USD_CHARGE_LINE);
    // What the stamp backs, and no more: no claim that the customer saw it or about other amounts.
    expect(out).not.toMatch(/was shown|throughout checkout/);
  });

  it("a CAD-stamped charge's own figures read US$; a US charge's stay a plain $", () => {
    const refunded = { ...charge, amount_refunded: 1000 } as Stripe.Charge;
    const cad = JSON.stringify(buildEvidence(dispute, "general", { contact: null, charge: chargeFactsFrom(refunded, pi({ reslabCurrency: "CAD" })) }));
    expect(cad).toContain("Charged online by Triply: US$30.39.");
    expect(cad).toContain("Refunded to the card so far: US$10.00.");
    expect(cad).not.toMatch(BARE_DOLLAR);
    const us = JSON.stringify(buildEvidence(dispute, "general", { contact: null, charge: chargeFactsFrom(refunded, pi({ reslabCurrency: "USD" })) }));
    expect(us).toContain("Charged online by Triply: $30.39.");
    expect(us).not.toContain("US$");
    expect(chargeFactsFrom(refunded, "pi_1").usdLabel).toBe(false);
  });

  it("a US payment, an unknown version, or an unreadable PaymentIntent: nothing is claimed", () => {
    expect(text({ reslabCurrency: "USD" })).not.toContain("US dollars");
    expect(text({ reslabCurrency: "CAD", currencyNotice: "1999-01-01" })).not.toContain("US dollars");
    expect(chargeFactsFrom(charge, "pi_1").currencyNoticeText).toBeNull();
    expect(chargeFactsFrom(charge, null).currencyNoticeText).toBeNull();
  });
});

describe("the record's code cannot print a bare $ or drop the label", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

  it("no record surface formats an amount itself", () => {
    for (const f of [
      "components/confirmation/booking-details.tsx",
      "components/reservations/reservation-card.tsx",
      "components/reservations/cancel-reservation-button.tsx",
      "lib/resend/templates/booking-confirmation.tsx",
      "lib/resend/templates/cancellation-confirmation.tsx",
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(/formatUsd\(/);
      // "$" written before a value: "$${" in a template string, ">${" or " ${…toFixed" in JSX text.
      expect(src, f).not.toMatch(/\$\$\{/);
      expect(src, f).not.toMatch(/>\$\{/);
      expect(src, f).not.toMatch(/[a-z] \$\{[^}\n]*toFixed/);
    }
  });

  it("every sender and loader hands the booking's own label down", () => {
    const fulfill = read("lib/booking/fulfill.ts");
    expect(fulfill).toMatch(/usdLabel: fr\.fx !== null,/);
    expect(fulfill).toMatch(/usdLabel: false, \/\/ a direct lot/);
    expect((fulfill.match(/usdLabel:/g) ?? []).length).toBe(2);
    expect(read("lib/cancellation/finalize.ts")).toMatch(/usdLabel: isUsdLabelledBooking\(booking\),/);
    expect(read("app/api/admin/bookings/cancel/route.ts")).toMatch(/usdLabel: isUsdLabelledBooking\(booking\),/);
    // The three loaders of the cancel row read the column.
    expect(read("app/api/user/bookings/[reservationNumber]/cancel/route.ts")).toMatch(/reslab_currency: booking\.reslab_currency,/);
    expect(read("lib/cancellation/reconcile.ts")).toMatch(/reslab_currency: row\.reslab_currency,/);
    for (const f of [
      "app/api/user/bookings/[reservationNumber]/cancel/route.ts",
      "app/api/user/bookings/[reservationNumber]/cancel-preview/route.ts",
      "app/api/admin/bookings/cancel/route.ts",
      "lib/cancellation/reconcile.ts",
      "app/api/user/bookings/route.ts",
    ]) {
      expect(read(f), f).toMatch(/livemode, reslab_currency|created_at, reslab_currency/);
    }
    expect(read("app/(main)/confirmation/[id]/page.tsx")).toMatch(/usdLabel=\{reservation\.usdLabel === true\}/);
    const button = read("components/reservations/cancel-reservation-button.tsx");
    expect(button).toMatch(/const usdLabel = preview\?\.usdLabel === true;/);
    expect((button.match(/money\(preview\.\w+, usdLabel\)/g) ?? []).length).toBe(4);
    expect(button).toMatch(/\{usdLabel && \(/);
    // The page a customer returns to after card verification, and the payment alerts.
    const complete = read("app/(main)/checkout/complete/complete-client.tsx");
    expect(complete).toMatch(/usdLabel: data\.usdLabel === true/);
    expect(complete).toMatch(/money\.usdLabel && text\.startsWith\("\$"\) \? `US\$\{text\}` : text/);
    expect(read("lib/stripe/money-on-card.ts")).toMatch(/const usdLabel = isUsdLabelledPayment\(fresh\.metadata\);/);
  });
});
