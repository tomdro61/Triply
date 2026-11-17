/**
 * The booking engine on a lot ResLab prices in Canadian dollars.
 *
 * The customer was charged US dollars at the rate stamped on the
 * PaymentIntent. Fulfilment must convert every ResLab figure with THAT rate
 * (the current rate is never read here: none is set in this file, and the
 * bookings below still convert), must never capture when the reservation's
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

const { createBooking, currencyMismatch } = await import("../create-booking");
const { fromReslab } = await import("../fulfilled-reservation");
const { capturePaymentError } = await import("@/lib/sentry");

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
  const usd = fromReslab(JSON.parse(JSON.stringify(reservation({}, "USD"))));
  const cadRaw = fromReslab(JSON.parse(JSON.stringify(reservation())));
  const cadConverted = fromReslab(JSON.parse(JSON.stringify(reservation())), RATE);
  const silent = fromReslab(JSON.parse(JSON.stringify(reservation({}, null))));

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
    expect(currencyMismatch({ kind: "cad", rate: RATE }, cadRaw)).toMatch(/could not be converted/);
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
      expect(fr.fx).toEqual({ rate: RATE, converted: false });
    }
    expect(() => fromReslab(JSON.parse("null"), RATE)).not.toThrow();
    expect(() => fromReslab(JSON.parse('{"history":[{"location":{"currency":{"code":{"x":1}}}}]}'), RATE)).not.toThrow();
  });
  it("without a rate a reservation is carried raw, exactly as before, plus its currency", () => {
    const fr = fromReslab(JSON.parse(JSON.stringify(reservation({}, "USD"))));
    expect(fr.money.grandTotal).toBe(125.81);
    expect(fr.sourceCurrency).toBe("USD");
    expect(fr).not.toHaveProperty("fx");
    expect(fromReslab(JSON.parse(JSON.stringify(reservation({}, null)))).sourceCurrency).toBeNull();
  });
});
