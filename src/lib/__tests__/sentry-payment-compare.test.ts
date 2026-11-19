/**
 * capturePaymentCompare against the REAL Sentry SDK: what matters is the event
 * that would leave the server, after every processor and `beforeSend`. These
 * reports fire on every path into the booking engine, and the SDK attaches
 * what surrounds an event by itself: the incoming request, and breadcrumbs
 * left earlier in the same invocation.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import * as Sentry from "@sentry/nextjs";
import type { ErrorEvent } from "@sentry/nextjs";
import { capturePaymentCompare, onlyOwnData } from "../sentry";
import { scrubEventCredentials } from "../sentry-scrub";

const sent: ErrorEvent[] = [];
const BODY = JSON.stringify({
  customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "555-0100" },
  vehicle: { licensePlate: "ABC123" },
});
const SECRETS = ["ada@", "lovelace", "example.com", "555-0100", "abc123", "secret_abc", "session=1", "grace@", "hopper"];

beforeAll(() => {
  Sentry.init({
    dsn: "https://public@o0.ingest.sentry.invalid/0",
    sendDefaultPii: false,
    // Nothing leaves the test: every event is kept here and dropped.
    beforeSend: (event) => {
      const scrubbed = scrubEventCredentials(event);
      if (scrubbed) sent.push(scrubbed);
      return null;
    },
  });
});

beforeEach(() => {
  sent.length = 0;
  const isolation = Sentry.getIsolationScope();
  isolation.clear();
  // What the SDK records for an incoming POST, as the request-data integration reads it.
  isolation.setSDKProcessingMetadata({
    normalizedRequest: {
      method: "POST",
      url: "https://www.triplypro.com/api/reservations",
      headers: { "x-payment-intent-client-secret": "pi_1_secret_abc", cookie: "session=1" },
      data: BODY,
    },
  });
  // What an earlier step of the same invocation can leave behind: console
  // output, an outgoing URL, a user and extra data on the surrounding scope.
  Sentry.addBreadcrumb({ category: "console", level: "error", message: "send failed for grace@example.com", data: { arguments: ["Grace Hopper"] } });
  Sentry.addBreadcrumb({ category: "http", data: { url: "https://db.invalid/customers?email=eq.grace@example.com" } });
  isolation.setUser({ id: "user_1", email: "grace@example.com" });
  isolation.setExtra("customer", "Grace Hopper");
  isolation.setContext("customer", { plate: "ABC123" });
});

async function events(): Promise<ErrorEvent[]> {
  await Sentry.flush(2000);
  return sent;
}

/** The event as sent: the SDK deletes its own working copy of the request when
 *  it builds the envelope (@sentry/core envelope.js, createEventEnvelope). */
function wire(event: ErrorEvent): string {
  const copy: Record<string, unknown> = { ...event };
  Reflect.deleteProperty(copy, "sdkProcessingMetadata");
  return JSON.stringify(copy).toLowerCase();
}

describe("capturePaymentCompare, on the event Sentry would send", () => {
  it("proves the fixture: an ordinary event here DOES carry the body, the breadcrumbs, the user and the extras", async () => {
    Sentry.captureMessage("ordinary");
    const [event] = await events();
    expect(JSON.stringify(event.request)).toContain("ada@example.com");
    expect(JSON.stringify(event.breadcrumbs)).toContain("grace@example.com");
    expect(event.user).toMatchObject({ email: "grace@example.com" });
    expect(event.extra).toMatchObject({ customer: "Grace Hopper" });
    expect(event.contexts).toHaveProperty("customer");
  });

  it("carries none of it: no request, breadcrumbs, user, extra or foreign context", async () => {
    capturePaymentCompare("request", "differs", {
      stripePaymentIntentId: "pi_1",
      livemode: true,
      tags: { "check.payload_source": "request" },
      detail: { fields: ["lot"], paymentLot: 42, usedLot: 43 },
    });
    const [event] = await events();
    expect(event).toBeDefined();
    expect(event.request).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(Object.keys(event.contexts ?? {}).filter((key) => key !== "trace")).toEqual(["detail"]);
    for (const secret of SECRETS) expect(wire(event)).not.toContain(secret);
  });

  it("is info for a match and a warning for every other outcome, never an error", async () => {
    capturePaymentCompare("reservation", "match", { stripePaymentIntentId: "pi_1", livemode: false });
    capturePaymentCompare("reservation", "differs", { stripePaymentIntentId: "pi_1", livemode: true });
    capturePaymentCompare("request", "fee_unknown", { stripePaymentIntentId: "pi_1", livemode: true });
    capturePaymentCompare("unstaged", "no_staged_row", { stripePaymentIntentId: "pi_1", livemode: true });
    capturePaymentCompare("price_check", "crashed", { stripePaymentIntentId: "pi_1", livemode: true });
    expect((await events()).map((event) => event.level)).toEqual(["info", "warning", "warning", "warning", "warning"]);
  });

  it("groups by site and outcome, with its own tags and no payment-error tag", async () => {
    capturePaymentCompare("price_check", "payment_fee_within", {
      stripePaymentIntentId: "pi_9",
      livemode: true,
      tags: { "check.payload_fee": "present" },
      detail: { freshCents: 7800 },
    });
    const [event] = await events();
    expect(event.fingerprint).toEqual(["payment-compare", "price_check", "payment_fee_within"]);
    expect(event.message).toBe("payment compare: price_check payment_fee_within");
    expect(event.tags).toMatchObject({
      check: "payment_compare",
      "check.site": "price_check",
      "check.outcome": "payment_fee_within",
      "payment.intentId": "pi_9",
      "payment.livemode": "live",
      "check.payload_fee": "present",
    });
    expect(event.tags).not.toHaveProperty("payment.error");
    expect(event.contexts?.detail).toEqual({ freshCents: 7800 });
  });

  it("does not leak its level, tags, fingerprint or its stripping onto the next event", async () => {
    capturePaymentCompare("request", "match", { stripePaymentIntentId: "pi_1", livemode: true });
    Sentry.captureException(new Error("a real fault afterwards"));
    const [, next] = await events();
    expect(next.level).toBe("error");
    expect(next.tags ?? {}).not.toHaveProperty("check");
    expect(next.fingerprint).toBeUndefined();
    expect(next.request).toBeDefined();
    expect(next.breadcrumbs?.length).toBeGreaterThan(0);
  });
});

describe("onlyOwnData", () => {
  it("keeps the message, tags, detail and trace, and removes the rest", () => {
    expect(
      onlyOwnData({
        message: "m",
        tags: { check: "payment_compare" },
        request: { data: BODY },
        breadcrumbs: [{ message: "x" }],
        user: { id: "u" },
        extra: { a: 1 },
        contexts: { detail: { fields: ["lot"] }, trace: { trace_id: "t" }, customer: { plate: "ABC123" } },
      })
    ).toEqual({ message: "m", tags: { check: "payment_compare" }, contexts: { detail: { fields: ["lot"] }, trace: { trace_id: "t" } } });
  });

  it("copes with an event that has no contexts", () => {
    const bare: { message: string; contexts?: Record<string, unknown> } = { message: "m" };
    expect(onlyOwnData(bare)).toEqual({ message: "m", contexts: {} });
  });
});
