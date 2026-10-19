/**
 * The refund preview behind the cancel dialog. Read-only, but it is the number a
 * customer decides on, so the environment guard (direct-lots plan 4b §9 H-D) must
 * hold here too: a booking paid in the other Stripe mode is refused BEFORE any
 * Stripe read, with customer wording and the no-store header every response
 * carries. The suite runs on a TEST key (vitest.setup.ts).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { retrieve, sessionClient, BASE_BOOKING, current, sentry } = vi.hoisted(() => {
  const booking: Record<string, unknown> = {
    id: "b1",
    status: "confirmed",
    reslab_reservation_number: "RTL1",
    location_name: "Lot",
    check_in: "2030-06-15 10:00:00",
    check_out: "2030-06-20 10:00:00",
    location_timezone: "America/New_York",
    protection_plan: null,
    protection_plan_price: null,
    protection_plan_wholesale: null,
    stripe_payment_intent_id: "pi_1",
    livemode: false,
  };
  // The row the RLS-scoped (owner-only) read returns; a test may replace it.
  const current = { row: booking as Record<string, unknown> | null };
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: current.row, error: null }),
  };
  return {
    retrieve: vi.fn(),
    BASE_BOOKING: booking,
    current,
    sentry: { captureAPIError: vi.fn(), capturePaymentError: vi.fn(), captureParkGuardError: vi.fn() },
    sessionClient: {
      auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
      from: () => q,
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessionClient }));
vi.mock("@/lib/sentry", () => sentry);
vi.mock("@/lib/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe/client")>(
    "@/lib/stripe/client",
  );
  // planTeardown's refund-state gate is pure — exercise it for real.
  return { ...actual, stripe: { paymentIntents: { retrieve } } };
});

import { GET } from "../route";
import { OTHER_MODE_CUSTOMER_MESSAGE, OTHER_MODE_MESSAGE } from "@/lib/cancellation/source-guard";

const params = { params: Promise.resolve({ reservationNumber: "RTL1" }) };
const req = () => new NextRequest("https://x.test/api/user/bookings/RTL1/cancel-preview");

beforeEach(() => {
  process.env.ENABLE_SELF_SERVE_CANCEL = "true";
  current.row = BASE_BOOKING;
  retrieve.mockReset();
  for (const m of Object.values(sentry)) m.mockReset();
});

describe("GET cancel-preview — Stripe-mode guard (plan 4b §9 H-D)", () => {
  it("a LIVE booking under a test key → 409 other_environment, customer wording, no-store, no Stripe read", async () => {
    current.row = { ...BASE_BOOKING, livemode: true };
    const res = await GET(req(), params);
    expect(res.status).toBe(409);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ error: "other_environment", message: OTHER_MODE_CUSTOMER_MESSAGE });
    // Never the staff "manage it from the other admin" text.
    expect(body.message).not.toBe(OTHER_MODE_MESSAGE);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("a pre-015 row (NULL livemode = live) under a test key is refused the same way", async () => {
    current.row = { ...BASE_BOOKING, livemode: null };
    const res = await GET(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("other_environment");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("a same-mode booking gets the normal preview from the PaymentIntent", async () => {
    retrieve.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount_received: 10_000,
      latest_charge: { amount_refunded: 0 },
    });
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(retrieve).toHaveBeenCalledWith("pi_1", { expand: ["latest_charge"] });
    expect(await res.json()).toEqual({
      reservationNumber: "RTL1",
      paidTotal: 100,
      refundAmount: 100,
      parkGuardWithheld: 0,
      priorRefunded: 0,
      hasParkGuard: false,
      isAuthorizationRelease: false,
    });
  });

  it("a production deployment (live key) previews a pre-015 NULL row as before", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    try {
      current.row = { ...BASE_BOOKING, livemode: null };
      retrieve.mockResolvedValue({
        id: "pi_1",
        status: "succeeded",
        amount_received: 10_000,
        latest_charge: { amount_refunded: 0 },
      });
      const res = await GET(req(), params);
      expect(res.status).toBe(200);
      expect((await res.json()).refundAmount).toBe(100);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
