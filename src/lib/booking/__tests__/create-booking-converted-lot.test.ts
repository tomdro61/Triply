/**
 * The booking engine on a lot ResLab prices in Canadian dollars.
 *
 * The customer was charged US dollars at the rate stamped on the
 * PaymentIntent. Fulfilment must convert every ResLab figure with THAT rate
 * (the current rate is mocked to a different value, so a figure computed with
 * it would fail these tests), must never capture when the reservation's
 * own currency disagrees with the stamp, and must never write a raw
 * Canadian-dollar figure into a money column.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeSupabase } from "./supabase-fake";

const db = new FakeSupabase();
const stripeMock = { paymentIntents: { retrieve: vi.fn(), capture: vi.fn(), cancel: vi.fn() } };
const capturePaymentIntent = vi.fn();
const cancelPaymentIntent = vi.fn();
const createRefund = vi.fn();
const reslabMock = { createReservation: vi.fn(), getReservation: vi.fn(), getCost: vi.fn(), getLocation: vi.fn() };

vi.mock("@/lib/booking/reconciliation-alert", () => ({
  RECONCILIATION_ALERT_COLUMNS: "stripe_payment_intent_id, livemode, customer, location_name, airport_code, from_date, to_date, reslab_reservation_number, inventory_source",
  alertNeedsReconciliation: vi.fn(async () => ({ team: "discord", customer: "sent" })),
  scheduleReconciliationAlert: vi.fn(async () => undefined),
}));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe/client")>("@/lib/stripe/client");
  return { stripe: stripeMock, capturePaymentIntent, cancelPaymentIntent, createRefund, paymentIntentRefundState: actual.paymentIntentRefundState };
});
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>("@/lib/reslab/client");
  return { reslab: reslabMock, ReslabError: actual.ReslabError, stripHtml: actual.stripHtml };
});
vi.mock("@/lib/resend/send-booking-confirmation", () => ({
  sendBookingConfirmation: vi.fn(async () => ({ success: true, emailId: "em_1" })),
}));
vi.mock("@/lib/resend/send-admin-booking-notification", () => ({
  sendAdminBookingNotification: vi.fn(async () => undefined),
}));
vi.mock("@/lib/parkguard/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/parkguard/client")>("@/lib/parkguard/client");
  return { ...actual, parkGuard: { captureReservation: vi.fn(), updateReservation: vi.fn() } };
});
vi.mock("@/lib/sentry", () => ({
  capturePaymentError: vi.fn(),
  captureBookingError: vi.fn(),
  captureParkGuardError: vi.fn(),
  captureAPIError: vi.fn(),
}));
// The CURRENT rate is deliberately different from the one stamped on every
// PaymentIntent below (0.725): any figure computed with it would be wrong, so
// every expected amount in this file proves the stamped rate was used.
vi.mock("@/lib/fx/cad-usd", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fx/cad-usd")>()),
  currentCadRate: () => ({ id: "r2-current", micros: 690_000 }),
}));

const { createBooking, currencyMismatch } = await import("../create-booking");
const { fromReslab } = await import("../fulfilled-reservation");
const { capturePaymentError } = await import("@/lib/sentry");
const { promoStampMetadata } = await import("@/lib/promo/stamped-discount");
const { sendBookingConfirmation } = await import("@/lib/resend/send-booking-confirmation");

const PI = "pi_test_cad";
const RATE = { id: "r1", micros: 725_000 };
const CAD_STAMP = { reslabCurrency: "CAD", fxRateId: "r1", fxRateMicros: "725000" };

// Montreal, 8 days. ResLab's figures are Canadian dollars; at 0.725 they are
// 77.97 + 3.90 + 9.34 = 91.21 US dollars, plus the $5.95 service fee = $97.16.
const CAD = { sub: 107.55, fees: 5.38, tax: 12.88, grand: 125.81 };

function pendingRow(over: Record<string, unknown> = {}) {
  return {
    stripe_payment_intent_id: PI,
    status: "pending",
    reslab_reservation_number: null,
    claimed_at: null,
    email_sent: false,
    livemode: false,
    location_id: 330,
    costs_token: "tok_1",
    from_date: "2026-12-02 10:00:00",
    to_date: "2026-12-10 10:00:00",
    parking_type_id: 7,
    customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "555-0100" },
    vehicle: { make: "Volvo", model: "XC60", color: "Blue", licensePlate: "ABC123", state: "QC" },
    extra_fields: null,
    location_name: "Lot M",
    location_address: "1 Rue",
    airport_code: "YUL",
    inventory_source: "reslab",
    // The checkout page's figures: already US dollars.
    subtotal: "77.97",
    tax_total: "9.34",
    fees_total: "3.90",
    grand_total: "91.21",
    triply_service_fee: "5.95",
    user_id: null,
    has_protection_plan: false,
    protection_plan_code: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

function paymentIntent(over: Record<string, unknown> = {}) {
  return {
    id: PI,
    status: "requires_capture",
    amount: 9716,
    livemode: false,
    metadata: { customerEmail: "ada@example.com", ...CAD_STAMP },
    latest_charge: null,
    ...over,
  };
}

function cost(over: Record<string, unknown> = {}) {
  return {
    costs_token: "tok_2",
    reservation: {
      sold_out: false,
      sub_total: CAD.sub,
      fees_total: CAD.fees,
      tax_total: CAD.tax,
      long_term_discount: 0,
      discount: 0,
      grand_total: CAD.grand,
      due_at_location: 0,
      totals: { parking: { number_of_days: 8, sub_total: CAD.sub } },
      ...over,
    },
  };
}

function reservation(history: Record<string, unknown> = {}, currency: string | null = "CAD") {
  return {
    reservation_number: "RTL900",
    cancelled: false,
    history: [
      {
        id: 1,
        subtotal: CAD.sub,
        total_fees: CAD.fees,
        total_tax: CAD.tax,
        long_term_discount: 0,
        grand_total: CAD.grand,
        due_at_location_total: 0,
        location: {
          id: 330,
          name: "Lot M",
          address: "1 Rue",
          city: "Dorval",
          state: { code: "QC" },
          zip_code: "H4Y",
          ...(currency && { currency: { id: 1, code: currency } }),
          country: { code: "CA" },
        },
        dates: [],
        ...history,
      },
    ],
  };
}

const book = () => createBooking({ source: "webhook", stripePaymentIntentId: PI });
const moneyColumns = () => {
  const b = db.tables.bookings[0];
  return { subtotal: b.subtotal, tax_total: b.tax_total, fees_total: b.fees_total, grand_total: b.grand_total, due_at_location: b.due_at_location, triply_service_fee: b.triply_service_fee };
};

beforeEach(() => {
  vi.clearAllMocks();
  db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [] };
  db.log = [];
  db.seed("pending_bookings", [pendingRow()]);
  stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent());
  reslabMock.getCost.mockResolvedValue(cost());
  reslabMock.createReservation.mockResolvedValue(reservation());
  reslabMock.getReservation.mockResolvedValue(reservation());
  reslabMock.getLocation.mockResolvedValue(undefined);
  capturePaymentIntent.mockResolvedValue({ status: "succeeded" });
  cancelPaymentIntent.mockResolvedValue({ status: "canceled" });
  createRefund.mockResolvedValue({ id: "re_1" });
});

describe("a booking on a Canadian-dollar lot", () => {
  it("books, captures, and stores US dollars with the stamped rate — no Canadian figure in any money column", async () => {
    const out = await book();
    expect(out.kind).toBe("created");
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1);
    expect(moneyColumns()).toEqual({ subtotal: 77.97, tax_total: 9.34, fees_total: 3.9, grand_total: 91.21, due_at_location: 0, triply_service_fee: 5.95 });
    expect(db.tables.bookings[0]).toMatchObject({ reslab_currency: "CAD", fx_rate: "0.725000", reslab_reservation_number: "RTL900" });
    // Parts add up to the total, and the total plus the fee is what Stripe holds.
    const cents = (v: unknown) => Math.round(Number(v) * 100);
    const m = moneyColumns();
    expect(cents(m.subtotal) + cents(m.fees_total) + cents(m.tax_total)).toBe(cents(m.grand_total));
    expect(cents(m.grand_total) + cents(m.triply_service_fee)).toBe(9716);
  });

  it("the costs token sent to ResLab is the fresh one (ResLab's own CAD price lock)", async () => {
    await book();
    expect(reslabMock.createReservation.mock.calls[0][0]).toMatchObject({ costs_token: "tok_2" });
  });

  it("a fresh price that rose (in CAD) blocks before any reservation and releases the hold", async () => {
    reslabMock.getCost.mockResolvedValue(cost({ sub_total: 117.55, grand_total: 135.81, totals: { parking: { number_of_days: 8, sub_total: 117.55 } } }));
    const out = await book();
    expect(out.kind).toBe("failed");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).toHaveBeenCalledTimes(1);
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });

  it("a fresh price one cent lower in US dollars still books (a drop is never a refusal)", async () => {
    reslabMock.getCost.mockResolvedValue(cost({ tax_total: 12.86, grand_total: 125.79 }));
    expect((await book()).kind).toBe("created");
  });

  it.each([
    ["its parts no longer add up", { grand_total: 130 }],
    ["the lot now collects at the counter", { due_at_location: 25 }],
    ["a discount appeared", { discount: 4 }],
  ])("a fresh price that will not convert (%s) blocks before any reservation", async (_n, bad) => {
    reslabMock.getCost.mockResolvedValue(cost(bad));
    const out = await book();
    expect(out.kind).toBe("failed");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it("ResLab unreachable at the price refresh: books on the existing token and still converts the reservation", async () => {
    reslabMock.getCost.mockRejectedValue(new Error("ResLab 502"));
    expect((await book()).kind).toBe("created");
    expect(db.tables.bookings[0]).toMatchObject({ grand_total: 91.21, reslab_currency: "CAD", fx_rate: "0.725000" });
  });

  it("a resume re-reads the reservation and converts it with the stamped rate", async () => {
    db.tables.pending_bookings = [];
    db.seed("pending_bookings", [pendingRow({ status: "processing", reslab_reservation_number: "RTL900", claimed_at: new Date(Date.now() - 5 * 60_000).toISOString() })]);
    const out = await book();
    expect(out.kind).toBe("created");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(db.tables.bookings[0]).toMatchObject({ grand_total: 91.21, reslab_currency: "CAD", fx_rate: "0.725000" });
  });
});

describe("the currency check before capture", () => {
  const expectHeldForReconciliation = async () => {
    const out = await book();
    expect(out.kind).toBe("needs_reconciliation");
    expect(out).toMatchObject({ retryable: false });
    // The reservation is live and recorded; the money has NOT moved either way.
    expect(reslabMock.createReservation).toHaveBeenCalledTimes(1);
    expect(db.tables.pending_bookings[0]).toMatchObject({ status: "needs_reconciliation", reslab_reservation_number: "RTL900" });
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(db.tables.bookings).toHaveLength(0);
    expect(vi.mocked(capturePaymentError)).toHaveBeenCalled();
  };

  it("charged as a US lot (stamp USD) but the reservation is in CAD → never captured", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent({ metadata: { customerEmail: "ada@example.com", reslabCurrency: "USD" } }));
    reslabMock.getCost.mockResolvedValue(cost({ sub_total: 77.97, fees_total: 3.9, tax_total: 9.34, grand_total: 91.21 }));
    await expectHeldForReconciliation();
  });

  it("no stamp at all (a PaymentIntent from before the stamp) but the reservation is in CAD → never captured", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent({ metadata: { customerEmail: "ada@example.com" } }));
    reslabMock.getCost.mockResolvedValue(cost({ sub_total: 77.97, fees_total: 3.9, tax_total: 9.34, grand_total: 91.21 }));
    await expectHeldForReconciliation();
  });

  it("charged as a CAD lot but the reservation says USD → never captured", async () => {
    reslabMock.createReservation.mockResolvedValue(reservation({}, "USD"));
    await expectHeldForReconciliation();
  });

  it("charged as a CAD lot but the reservation's figures do not add up → never captured", async () => {
    reslabMock.createReservation.mockResolvedValue(reservation({ grand_total: 130 }));
    await expectHeldForReconciliation();
  });

  it("a reservation that does not state its currency converts and books (the stamp is the authority)", async () => {
    reslabMock.createReservation.mockResolvedValue(reservation({}, null));
    expect((await book()).kind).toBe("created");
    expect(db.tables.bookings[0]).toMatchObject({ grand_total: 91.21, reslab_currency: "CAD" });
  });

  it.each([
    ["a rate entered upside down", { reslabCurrency: "CAD", fxRateId: "r1", fxRateMicros: "1380000" }],
    ["CAD with no rate", { reslabCurrency: "CAD" }],
    ["a third currency", { reslabCurrency: "EUR" }],
  ])("an unusable stamp (%s) is refused BEFORE ResLab is called, and the hold is released", async (_n, stamp) => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent({ metadata: { customerEmail: "ada@example.com", ...stamp } }));
    const out = await book();
    expect(out.kind).toBe("failed");
    expect(reslabMock.getCost).not.toHaveBeenCalled();
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).toHaveBeenCalledTimes(1);
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });
});

describe("currencyMismatch", () => {
  const usd = fromReslab(JSON.parse(JSON.stringify(reservation({}, "USD"))), null);
  const cadRaw = fromReslab(JSON.parse(JSON.stringify(reservation())), null);
  const cadConverted = fromReslab(JSON.parse(JSON.stringify(reservation())), RATE);
  const silent = fromReslab(JSON.parse(JSON.stringify(reservation({}, null))), null);

  it("agreement is null", () => {
    expect(currencyMismatch({ kind: "usd" }, usd)).toBeNull();
    expect(currencyMismatch({ kind: "absent" }, usd)).toBeNull();
    expect(currencyMismatch({ kind: "usd" }, silent)).toBeNull();
    expect(currencyMismatch({ kind: "absent" }, silent)).toBeNull();
    expect(currencyMismatch({ kind: "cad", rate: RATE }, cadConverted)).toBeNull();
  });
  it("every disagreement is named", () => {
    expect(currencyMismatch({ kind: "usd" }, cadRaw)).toMatch(/priced in CAD/);
    expect(currencyMismatch({ kind: "absent" }, cadRaw)).toMatch(/priced in CAD/);
    expect(currencyMismatch({ kind: "cad", rate: RATE }, fromReslab(JSON.parse(JSON.stringify(reservation({}, "USD"))), RATE))).toMatch(/priced in USD/);
    // Stamped CAD but nobody converted: never treated as fine.
    expect(currencyMismatch({ kind: "cad", rate: RATE }, cadRaw)).toMatch(/was not converted/);
    expect(currencyMismatch({ kind: "cad", rate: RATE }, fromReslab(JSON.parse(JSON.stringify(reservation({ grand_total: 130 }))), RATE))).toMatch(
      /could not be converted at rate r1 \(parts_do_not_add_up\)/
    );
    // Converted, adds up, but the lot collects part of it at the counter: never sold that way.
    expect(
      currencyMismatch({ kind: "cad", rate: RATE }, fromReslab(JSON.parse(JSON.stringify(reservation({ due_at_location_total: 20 }))), RATE))
    ).toMatch(/due at the lot/);
    expect(currencyMismatch({ kind: "invalid" }, usd)).toMatch(/unusable/);
  });
});

describe("fromReslab with a rate", () => {
  it("converts the history totals and reports the reservation's own currency", () => {
    const fr = fromReslab(JSON.parse(JSON.stringify(reservation())), RATE);
    expect(fr.money).toEqual({ subtotal: 77.97, taxTotal: 9.34, feesTotal: 3.9, grandTotal: 91.21, dueAtLocation: 0, longTermDiscount: 0 });
    expect(fr.sourceCurrency).toBe("CAD");
    expect(fr.fx).toEqual({ rate: RATE, converted: true });
  });
  it("figures that will not convert become null — never the raw Canadian-dollar numbers — and it does not throw", () => {
    for (const bad of [{ grand_total: 130 }, { subtotal: "x" }, { total_tax: null }, { due_at_location_total: 200 }]) {
      const fr = fromReslab(JSON.parse(JSON.stringify(reservation(bad))), RATE);
      expect(fr.money).toEqual({ subtotal: null, taxTotal: null, feesTotal: null, grandTotal: null, dueAtLocation: null, longTermDiscount: null });
      expect(fr.fx).toMatchObject({ rate: RATE, converted: false });
      expect(fr.fx && !fr.fx.converted && fr.fx.reason).toMatch(/^(parts_do_not_add_up|bad_amount|due_above_total)$/);
    }
    expect(() => fromReslab(JSON.parse("null"), RATE)).not.toThrow();
    expect(() => fromReslab(JSON.parse('{"history":[{"location":{"currency":{"code":{"x":1}}}}]}'), RATE)).not.toThrow();
  });
  it("without a rate a reservation is carried raw, exactly as before, plus its currency", () => {
    const fr = fromReslab(JSON.parse(JSON.stringify(reservation({}, "USD"))), null);
    expect(fr.money.grandTotal).toBe(125.81);
    expect(fr.sourceCurrency).toBe("USD");
    expect(fr.fx).toBeNull();
    expect(fromReslab(JSON.parse(JSON.stringify(reservation({}, null))), null).sourceCurrency).toBeNull();
    expect(fromReslab(JSON.parse(JSON.stringify(reservation({}, " cad "))), null).sourceCurrency).toBe("CAD");
  });
});

describe("a US booking, now that every PaymentIntent says its currency", () => {
  // The metadata the checkout POST writes for a US lot today, and a reservation as ResLab returns it for a US lot.
  const usPi = (over: Record<string, unknown> = {}) =>
    paymentIntent({
      amount: 9400,
      metadata: {
        customerEmail: "ada@example.com",
        inventorySource: "reslab",
        locationId: "42",
        serviceFee: "6",
        parkingOnlyChargeAmount: "94",
        parkingOnlyChargeAmountCents: "9400",
        verifiedTotal: "94",
        reslabCurrency: "USD",
      },
      ...over,
    });
  const usReservation = (currency: string | null) => ({
    reservation_number: "RTL901",
    cancelled: false,
    history: [
      {
        id: 2,
        subtotal: 80,
        total_fees: 3,
        total_tax: 5,
        long_term_discount: 0,
        grand_total: 88,
        due_at_location_total: 0,
        location: { id: 42, name: "Lot A", address: "1 Road", city: "Queens", state: { code: "NY" }, zip_code: "11430", ...(currency && { currency: { id: 3, code: currency }, country: { code: "US" } }) },
        dates: [],
      },
    ],
  });
  beforeEach(() => {
    db.tables.pending_bookings = [];
    db.seed("pending_bookings", [pendingRow({ location_id: 42, airport_code: "JFK", subtotal: "80.00", tax_total: "5.00", fees_total: "3.00", grand_total: "88.00", triply_service_fee: "6.00" })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(usPi());
    reslabMock.getCost.mockResolvedValue({ costs_token: "tok_2", reservation: { sold_out: false, sub_total: 80, fees_total: 3, tax_total: 5, grand_total: 88, due_at_location: 0 } });
  });

  it.each([
    ["USD", "USD"],
    ["usd (lower case)", "usd"],
    ["no currency on the reservation", null],
  ])("a USD stamp and a reservation saying %s books and captures exactly as before, with no currency columns", async (_n, currency) => {
    reslabMock.createReservation.mockResolvedValue(usReservation(currency));
    const out = await book();
    expect(out.kind).toBe("created");
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1);
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(vi.mocked(capturePaymentError)).not.toHaveBeenCalled();
    // ResLab's own figures, untouched.
    expect(moneyColumns()).toEqual({ subtotal: 80, tax_total: 5, fees_total: 3, grand_total: 88, due_at_location: 0, triply_service_fee: 6 });
    expect(db.tables.bookings[0]).not.toHaveProperty("reslab_currency");
    expect(db.tables.bookings[0]).not.toHaveProperty("fx_rate");
  });

  it("the same booking with NO stamp (a PaymentIntent from before the stamp) writes the same row", async () => {
    reslabMock.createReservation.mockResolvedValue(usReservation("USD"));
    await book();
    const stamped = { ...db.tables.bookings[0] };
    db.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [] };
    db.seed("pending_bookings", [pendingRow({ location_id: 42, airport_code: "JFK", subtotal: "80.00", tax_total: "5.00", fees_total: "3.00", grand_total: "88.00", triply_service_fee: "6.00" })]);
    const unstamped = usPi();
    delete (unstamped.metadata as Record<string, string>).reslabCurrency;
    stripeMock.paymentIntents.retrieve.mockResolvedValue(unstamped);
    await book();
    const strip = (row: Record<string, unknown>) => {
      const { id: _id, created_at: _c, updated_at: _u, customer_id: _cu, ...rest } = row;
      return rest;
    };
    expect(strip(db.tables.bookings[0])).toEqual(strip(stamped));
  });
});

describe("a converted booking: the paths around the normal one", () => {
  it("the staged row carries no figures → the row is filled from the CONVERTED reservation, never ResLab's raw numbers", async () => {
    db.tables.pending_bookings = [];
    db.seed("pending_bookings", [pendingRow({ subtotal: null, tax_total: null, fees_total: null, grand_total: null })]);
    expect((await book()).kind).toBe("created");
    expect(moneyColumns()).toMatchObject({ subtotal: 77.97, tax_total: 9.34, fees_total: 3.9, grand_total: 91.21 });
  });

  it("the confirmation email and the response carry US dollars only", async () => {
    const out = await book();
    const sent = JSON.stringify([vi.mocked(sendBookingConfirmation).mock.calls, out]);
    expect(sent).not.toMatch(/107\.55|125\.81|12\.88|5\.38|12581|10755/);
    expect(sent).toMatch(/91\.21|97\.16|9121|9716/);
  });

  it("a promo code: the stamped discount is checked against the converted price and recorded", async () => {
    // 10% of the converted subtotal 77.97 = 7.80 → the card holds 97.16 − 7.80.
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      paymentIntent({
        amount: 8936,
        metadata: {
          customerEmail: "ada@example.com",
          ...CAD_STAMP,
          serviceFee: "5.95",
          parkingOnlyChargeAmountCents: "8936",
          ...promoStampMetadata({ code: "TEN", percent: 10, discountCents: 780, onlineParkingCents: 9121, preDiscountOnlineCents: 9716 }),
        },
      })
    );
    const out = await book();
    expect(out.kind).toBe("created");
    expect(capturePaymentIntent).toHaveBeenCalledTimes(1);
    expect(db.tables.bookings[0]).toMatchObject({ grand_total: 91.21, discount_amount: 7.8, promo_code: "TEN", reslab_currency: "CAD", fx_rate: "0.725000" });
  });

  it("a resume with an unusable stamp is held for a person: nothing is released, captured or booked twice", async () => {
    db.tables.pending_bookings = [];
    db.seed("pending_bookings", [pendingRow({ status: "processing", reslab_reservation_number: "RTL900", claimed_at: new Date(Date.now() - 5 * 60_000).toISOString() })]);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(paymentIntent({ metadata: { customerEmail: "ada@example.com", reslabCurrency: "CAD", fxRateId: "r1", fxRateMicros: "1380000" } }));
    const out = await book();
    expect(out.kind).toBe("needs_reconciliation");
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).not.toHaveBeenCalled();
    expect(createRefund).not.toHaveBeenCalled();
    expect(db.tables.bookings).toHaveLength(0);
  });

  it("a converted reservation with an amount due at the lot is never captured", async () => {
    // Adds up and converts, but a converted lot is only ever sold fully paid online.
    reslabMock.getCost.mockRejectedValue(new Error("ResLab 502")); // the price refresh could not catch it
    reslabMock.createReservation.mockResolvedValue(reservation({ due_at_location_total: 20 }));
    const out = await book();
    expect(out.kind).toBe("needs_reconciliation");
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(db.tables.bookings).toHaveLength(0);
  });
});

describe("the currency check when the payment is ALREADY captured (Link, or manual capture switched off)", () => {
  const captured = (metadata: Record<string, string>) =>
    paymentIntent({ status: "succeeded", amount_received: 9716, metadata: { customerEmail: "ada@example.com", ...metadata }, latest_charge: { id: "ch_1", amount_refunded: 0 } });
  const expectBookedOnThePagesFigures = async () => {
    const out = await book();
    expect(out.kind).toBe("created");
    // Nothing left to hold: it books, and a person is told.
    expect(capturePaymentIntent).not.toHaveBeenCalled();
    expect(vi.mocked(capturePaymentError).mock.calls.some((c) => String(c[0]).includes("ALREADY captured"))).toBe(true);
    // The reservation's figures are in the wrong currency: none of them is written.
    // The row carries the checkout page's figures, which are what the card was charged.
    expect(moneyColumns()).toEqual({ subtotal: 77.97, tax_total: 9.34, fees_total: 3.9, grand_total: 91.21, due_at_location: 0, triply_service_fee: 5.95 });
    expect(JSON.stringify([db.tables.bookings[0], vi.mocked(sendBookingConfirmation).mock.calls])).not.toMatch(/107\.55|125\.81|12\.88/);
  };

  it("stamped USD, reservation in CAD → booked on the page's figures; ResLab's Canadian figures are written nowhere", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(captured({ reslabCurrency: "USD" }));
    reslabMock.getCost.mockResolvedValue(cost({ sub_total: 77.97, fees_total: 3.9, tax_total: 9.34, grand_total: 91.21, totals: { parking: { number_of_days: 8, sub_total: 77.97 } } }));
    await expectBookedOnThePagesFigures();
    expect(db.tables.bookings[0]).not.toHaveProperty("reslab_currency");
  });

  it("stamped CAD, reservation says USD → booked on the page's figures; the mis-converted figures are written nowhere", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(captured(CAD_STAMP));
    reslabMock.createReservation.mockResolvedValue(reservation({}, "USD"));
    await expectBookedOnThePagesFigures();
  });

  it("stamped CAD, figures that will not convert → booked on the page's figures", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(captured(CAD_STAMP));
    reslabMock.createReservation.mockResolvedValue(reservation({ grand_total: 130 }));
    await expectBookedOnThePagesFigures();
    expect(db.tables.bookings[0]).toMatchObject({ reslab_currency: "CAD", fx_rate: "0.725000" });
  });
});

describe("refusals that must not depend on another guard happening to fire", () => {
  it("a fresh price with a pay-at-lot share is blocked as unconvertible even though it would slip UNDER the price-rise guard", async () => {
    // Raw CAD due-now 125.81 + 5.95 − 60 = 71.76 is BELOW the 97.16 authorized: only the conversion refusal stops it.
    reslabMock.getCost.mockResolvedValue(cost({ due_at_location: 60 }));
    const out = await book();
    expect(out).toMatchObject({ kind: "failed", reason: expect.stringMatching(/could not be converted/) });
    expect(reslabMock.createReservation).not.toHaveBeenCalled();
    expect(cancelPaymentIntent).toHaveBeenCalledTimes(1);
    expect(capturePaymentIntent).not.toHaveBeenCalled();
  });

  it("a USD (or unstamped) PaymentIntent whose reservation is in ANY other currency is a mismatch", () => {
    const eur = fromReslab(JSON.parse(JSON.stringify(reservation({}, "EUR"))), null);
    expect(currencyMismatch({ kind: "usd" }, eur)).toMatch(/priced in EUR/);
    expect(currencyMismatch({ kind: "absent" }, eur)).toMatch(/priced in EUR/);
  });
});
